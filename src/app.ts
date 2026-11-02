import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import QRCode from "qrcode";
import {
  SIGN_IN_TTL_MS,
  fetchGoogleEmail,
  googleAuthUrl,
  randomToken,
  readCookie,
  readUserEmail,
  setCookie,
  userCookieValue,
  voterId,
} from "./auth.js";
import { MAX_NOMINEES, cleanName, cleanPictureUrl, parseBallot } from "./ballot.js";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Config {
  appUrl: string;
  adminEmails: string[];
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
}

const USER_COOKIE = "user";
const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_RETURN_COOKIE = "oauth_return";
// Only pages on this site, so sign-in can't be used to redirect elsewhere.
const RETURN_PATH = /^\/(admin\/sessions|display)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\/s\/[a-z0-9]{1,32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIED_WINNERS = 2;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(): string {
  return [...randomBytes(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function publicDir(): string {
  // Both src/ (dev, tests) and dist/ (production) sit next to public/.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

export function createApp(db: Db, config: Config) {
  const app = express();
  const secure = config.appUrl.startsWith("https://");
  const redirectUri = `${config.appUrl}/auth/google/callback`;
  const admins = new Set(config.adminEmails.map((e) => e.toLowerCase()));

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  const publicPage = (file: string) => (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir(), file));
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- Google sign-in ---

  app.get("/auth/google", (req, res) => {
    const state = randomToken();
    setCookie(res, OAUTH_STATE_COOKIE, state, 10 * 60 * 1000, secure);
    const { returnTo } = req.query;
    if (typeof returnTo === "string" && RETURN_PATH.test(returnTo)) {
      setCookie(res, OAUTH_RETURN_COOKIE, returnTo, 10 * 60 * 1000, secure);
    } else {
      res.clearCookie(OAUTH_RETURN_COOKIE, { path: "/" });
    }
    res.redirect(googleAuthUrl(config.googleClientId, redirectUri, state));
  });

  // Any verified Google account gets a sign-in cookie. What it can reach is checked per request:
  // the admin list for the admin, and each session's allowed emails for attendees.
  app.get("/auth/google/callback", async (req, res) => {
    const state = readCookie(req, OAUTH_STATE_COOKIE);
    const returnCookie = readCookie(req, OAUTH_RETURN_COOKIE);
    const returnTo = returnCookie && RETURN_PATH.test(returnCookie) ? returnCookie : "/admin";
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
    res.clearCookie(OAUTH_RETURN_COOKIE, { path: "/" });
    const { code, state: returnedState } = req.query;
    if (!state || state !== returnedState || typeof code !== "string") {
      res.redirect(`${returnTo}?error=signin`);
      return;
    }
    const email = await fetchGoogleEmail(code, config.googleClientId, config.googleClientSecret, redirectUri);
    if (!email) {
      res.redirect(`${returnTo}?error=signin`);
      return;
    }
    setCookie(res, USER_COOKIE, userCookieValue(email, config.sessionSecret), SIGN_IN_TTL_MS, secure);
    res.redirect(returnTo);
  });

  app.post("/auth/logout", (_req, res) => {
    res.clearCookie(USER_COOKIE, { path: "/" });
    res.status(204).end();
  });

  const signedInEmail = (req: Request) => readUserEmail(readCookie(req, USER_COOKIE), config.sessionSecret);

  // --- Attendee ---

  // Responds and returns null unless the signed-in account is on this session's list.
  async function requireAttendee(req: Request, res: Response): Promise<string | null> {
    const email = signedInEmail(req);
    if (!email) {
      res.status(401).json({ error: "Sign in required." });
      return null;
    }
    const { rows } = await db.query(
      `select exists (select 1 from session_attendees a where a.session_id = s.id and a.email = $2) as allowed
         from sessions s where s.code = $1`,
      [req.params.code, email],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "This voting session doesn't exist." });
      return null;
    }
    if (!rows[0].allowed) {
      res.status(403).json({ error: "This account isn't on the list for this session.", email });
      return null;
    }
    return email;
  }

  app.get("/api/s/:code", async (req, res) => {
    const email = await requireAttendee(req, res);
    if (!email) return;
    const { rows } = await db.query(
      `select s.name, s.stage, s.revealed_count, c.id as category_id, c.name as category_name
         from sessions s
         left join categories c on c.session_id = s.id and c.position = s.current_position
        where s.code = $1`,
      [req.params.code],
    );
    const session = rows[0];

    // Showing the winner happens on the big display only, so attendees just see voting closed.
    const stage = session.stage === "winner" ? "closed" : session.stage;
    const body: Record<string, unknown> = { name: session.name, stage };
    if (stage !== "finished" && stage !== "lobby") body.category = session.category_name;
    // Attendees get only the nominees revealed so far, and can vote only while voting is open.
    // The number of categories, vote counts and winners are never sent.
    if (stage === "waiting") {
      const revealed = await db.query(
        `select name, picture_url as "pictureUrl" from nominees where category_id = $1 order by position limit $2`,
        [session.category_id, session.revealed_count],
      );
      body.revealed = revealed.rows;
    }
    if (stage === "voting") {
      const nominees = await db.query(
        `select id, name, picture_url as "pictureUrl" from nominees where category_id = $1 order by position`,
        [session.category_id],
      );
      const mine = await db.query(`select nominee_id from votes where category_id = $1 and voter_id = $2`, [
        session.category_id,
        voterId(email, config.sessionSecret),
      ]);
      body.nominees = nominees.rows;
      body.myVote = mine.rows[0]?.nominee_id ?? null;
    }
    res.json(body);
  });

  app.get("/api/s/:code/qr", async (req, res) => {
    const { rows } = await db.query(`select code from sessions where code = $1`, [req.params.code]);
    if (rows.length === 0) {
      res.status(404).json({ error: "This voting session doesn't exist." });
      return;
    }
    const svg = await QRCode.toString(`${config.appUrl}/s/${rows[0].code}`, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.type("image/svg+xml").send(svg);
  });

  app.post("/api/s/:code/vote", async (req, res) => {
    const email = await requireAttendee(req, res);
    if (!email) return;
    const nomineeId = req.body?.nomineeId;
    if (typeof nomineeId !== "string" || !UUID.test(nomineeId)) {
      res.status(400).json({ error: "Pick a nominee." });
      return;
    }
    const { rows } = await db.query(
      `insert into votes (category_id, nominee_id, voter_id)
       select c.id, n.id, $3
         from sessions s
         join categories c on c.session_id = s.id and c.position = s.current_position
         join nominees n on n.category_id = c.id and n.id = $2
        where s.code = $1 and s.stage = 'voting'
       on conflict (category_id, voter_id)
       do update set nominee_id = excluded.nominee_id, updated_at = now()
       returning nominee_id`,
      [req.params.code, nomineeId, voterId(email, config.sessionSecret)],
    );
    if (rows.length === 0) {
      res.status(409).json({ error: "Voting for this nominee isn't open." });
      return;
    }
    res.json({ myVote: rows[0].nominee_id });
  });

  // --- Admin ---

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const email = signedInEmail(req);
    if (!email) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    // Re-checked on each request so removing an email takes effect at once.
    if (!admins.has(email)) {
      res.status(403).json({ error: "This account isn't an admin.", email });
      return;
    }
    res.locals.email = email;
    next();
  }

  app.use("/api/admin", requireAdmin);

  app.get("/api/admin/me", (_req, res) => {
    res.json({ email: res.locals.email });
  });

  app.get("/api/admin/sessions", async (_req, res) => {
    const { rows } = await db.query(
      `select id, code, name, stage, created_at from sessions order by created_at desc limit 50`,
    );
    res.json(rows);
  });

  app.post("/api/admin/sessions", async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) {
      res.status(400).json({ error: "Give the session a name." });
      return;
    }
    const ballot = parseBallot(req.body?.ballot);
    if (typeof ballot === "string") {
      res.status(400).json({ error: ballot });
      return;
    }
    const { rows } = await db.query(
      `with s as (
         insert into sessions (code, name, created_by) values ($1, $2, $3) returning id, code
       ), input as (
         select ord - 1 as pos, value from jsonb_array_elements($4::jsonb) with ordinality as t(value, ord)
       ), c as (
         insert into categories (session_id, position, name)
         select s.id, input.pos, input.value->>'name' from s, input
         returning id, position
       ), n as (
         insert into nominees (category_id, position, name, picture_url)
         select c.id, nominee.ord - 1, nominee.value->>'name', nominee.value->>'pictureUrl'
           from c
           join input on input.pos = c.position
           cross join lateral jsonb_array_elements(input.value->'nominees') with ordinality as nominee(value, ord)
       ), a as (
         insert into session_attendees (session_id, email)
         select s.id, email from s, jsonb_array_elements_text($5::jsonb) as email
       )
       select id, code from s`,
      [newCode(), name, res.locals.email, JSON.stringify(ballot.categories), JSON.stringify(ballot.allowedEmails)],
    );
    res.status(201).json(rows[0]);
  });

  // Winners of each category whose voting has ended. A tie is shared by the first two tied
  // nominees in ballot order, however many are tied.
  async function categoryWinners(id: string) {
    const { rows } = await db.query(
      `with tallies as (
         select c.id, c.position, c.name as category, n.name as nominee, n.picture_url, n.position as nominee_position,
                count(v.voter_id)::int as votes
           from sessions s
           join categories c on c.session_id = s.id
           left join nominees n on n.category_id = c.id
           left join votes v on v.nominee_id = n.id
          where s.id = $1
            and (c.position < s.current_position
                 or (c.position = s.current_position and s.stage in ('closed', 'winner', 'finished')))
          group by c.id, c.position, c.name, n.name, n.picture_url, n.position
       ), ranked as (
         select *, max(votes) over (partition by id) as top from tallies
       )
       select position, category, nominee, picture_url, votes = top and votes > 0 as won
         from ranked
        order by position, nominee_position`,
      [id],
    );
    const categories = new Map<
      number,
      { position: number; category: string; winners: { name: string; pictureUrl: string | null }[] }
    >();
    for (const row of rows) {
      if (!categories.has(row.position)) {
        categories.set(row.position, { position: row.position + 1, category: row.category, winners: [] });
      }
      const { winners } = categories.get(row.position)!;
      if (row.won && winners.length < MAX_TIED_WINNERS) winners.push({ name: row.nominee, pictureUrl: row.picture_url });
    }
    return [...categories.values()];
  }

  async function adminState(id: string) {
    const { rows } = await db.query(
      `select s.id, s.code, s.name, s.stage, s.current_position, s.revealed_count,
              c.id as category_id, c.name as category_name,
              (select count(*)::int from categories where session_id = s.id) as total,
              (select count(*)::int from votes where category_id = c.id) as vote_count,
              (select count(*)::int from session_attendees where session_id = s.id) as allowed_count
         from sessions s
         left join categories c on c.session_id = s.id and c.position = s.current_position
        where s.id = $1`,
      [id],
    );
    const session = rows[0];
    if (!session) return null;
    const nominees = await db.query(
      `select id, name, picture_url as "pictureUrl" from nominees where category_id = $1 order by position`,
      [session.category_id],
    );
    return {
      id: session.id,
      code: session.code,
      name: session.name,
      stage: session.stage,
      position: session.current_position + 1,
      total: session.total,
      category: session.stage === "finished" ? null : session.category_name,
      voteCount: session.vote_count,
      revealedCount: session.revealed_count,
      allowedCount: session.allowed_count,
      nominees: session.stage === "finished" ? [] : nominees.rows,
      winners: await categoryWinners(id),
      attendeeUrl: `${config.appUrl}/s/${session.code}`,
      qrPageUrl: `${config.appUrl}/qr/${session.code}`,
      displayUrl: `${config.appUrl}/display/${session.id}`,
    };
  }

  // Ids that aren't UUIDs would be a Postgres error rather than a 404.
  app.param("id", (req, res, next, id) => {
    if (!UUID.test(id)) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    next();
  });

  async function respondWithState(id: string, res: Response, conflict?: string) {
    const state = await adminState(id);
    if (!state) {
      res.status(404).json({ error: "Session not found." });
    } else if (conflict) {
      res.status(409).json({ error: conflict, state });
    } else {
      res.json(state);
    }
  }

  app.get("/api/admin/sessions/:id", async (req, res) => {
    await respondWithState(req.params.id, res);
  });

  // What the big display shows. It sits behind admin sign-in because attendees know the session
  // code, and this can hold the winner. Only the winner step includes the winners.
  app.get("/api/admin/sessions/:id/display", async (req, res) => {
    const state = await adminState(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    const inCategory = state.stage !== "lobby" && state.stage !== "finished";
    const current = state.winners.find((w) => w.position === state.position);
    res.json({
      name: state.name,
      code: state.code,
      stage: state.stage,
      attendeeUrl: state.attendeeUrl,
      category: inCategory ? state.category : null,
      totalNominees: inCategory ? state.nominees.length : 0,
      nominees: !inCategory ? [] : state.stage === "waiting" ? state.nominees.slice(0, state.revealedCount) : state.nominees,
      winners: state.stage === "winner" ? (current?.winners ?? []) : [],
    });
  });

  app.post("/api/admin/sessions/:id/reveal", async (req, res) => {
    const { rows } = await db.query(
      `update sessions s set revealed_count = s.revealed_count + 1
        where s.id = $1 and s.stage = 'waiting'
          and s.revealed_count < (
            select count(*) from nominees n
              join categories c on c.id = n.category_id
             where c.session_id = s.id and c.position = s.current_position
          )
        returning s.id`,
      [req.params.id],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : "There's no nominee left to reveal.");
  });

  // Voting first opens once every nominee is revealed. Reopening after a stop needs no new reveal.
  app.post("/api/admin/sessions/:id/start", async (req, res) => {
    const { rows } = await db.query(
      `update sessions s set stage = 'voting'
        from (
          select count(*)::int as nominees from nominees n
            join categories c on c.id = n.category_id
            join sessions cs on cs.id = c.session_id and cs.current_position = c.position
           where cs.id = $1
        ) t
        where s.id = $1 and t.nominees > 0
          and (s.stage = 'closed' or (s.stage = 'waiting' and s.revealed_count >= t.nominees))
        returning s.id`,
      [req.params.id],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : "Voting can't start until every nominee is revealed.");
  });

  app.post("/api/admin/sessions/:id/stop", async (req, res) => {
    const { rows } = await db.query(
      `update sessions set stage = 'closed' where id = $1 and stage = 'voting' returning id`,
      [req.params.id],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : "Voting isn't open.");
  });

  app.post("/api/admin/sessions/:id/show-winner", async (req, res) => {
    const { rows } = await db.query(
      `update sessions set stage = 'winner' where id = $1 and stage = 'closed' returning id`,
      [req.params.id],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : "Stop voting before showing the winner.");
  });

  app.post("/api/admin/sessions/:id/next", async (req, res) => {
    const { rows } = await db.query(
      `update sessions s set
         revealed_count = 0,
         stage = case when s.stage = 'lobby' or s.current_position + 1 < t.total then 'waiting' else 'finished' end,
         current_position = case when s.stage <> 'lobby' and s.current_position + 1 < t.total then s.current_position + 1 else s.current_position end
         from (select count(*)::int as total from categories where session_id = $1) t
        where s.id = $1 and s.stage in ('lobby', 'waiting', 'closed', 'winner')
        returning s.id`,
      [req.params.id],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : "Stop voting before moving to the next category.");
  });

  app.post("/api/admin/sessions/:id/nominees", async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) {
      res.status(400).json({ error: "Give the nominee a name." });
      return;
    }
    const pictureUrl = req.body?.pictureUrl ? cleanPictureUrl(req.body.pictureUrl) : null;
    if (req.body?.pictureUrl && !pictureUrl) {
      res.status(400).json({ error: "The picture needs to be an https URL." });
      return;
    }
    const { rows } = await db.query(
      `insert into nominees (category_id, position, name, picture_url)
       select c.id, coalesce((select max(position) + 1 from nominees where category_id = c.id), 0), $2, $3
         from sessions s
         join categories c on c.session_id = s.id and c.position = s.current_position
        where s.id = $1 and s.stage not in ('winner', 'finished')
          and (select count(*) from nominees where category_id = c.id) < $4
       on conflict (category_id, lower(name)) do nothing
       returning id`,
      [req.params.id, name, pictureUrl, MAX_NOMINEES],
    );
    await respondWithState(req.params.id, res, rows.length ? undefined : `Couldn't add "${name}": it's already nominated, the category has ${MAX_NOMINEES} nominees, or the winner has been shown.`);
  });

  // --- Pages ---

  app.get("/", (_req, res) => {
    res.redirect("/admin");
  });
  app.get("/admin", publicPage("admin.html"));
  app.get("/admin/sessions/:id", publicPage("session.html"));
  app.get("/s/:code", publicPage("attendee.html"));
  app.get("/qr/:code", publicPage("qr.html"));
  app.get("/display/:id", publicPage("display.html"));
  app.use(express.static(publicDir(), { index: false }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}
