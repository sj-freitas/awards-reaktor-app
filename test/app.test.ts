import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Db } from "../src/app.js";
import { userCookieValue } from "../src/auth.js";

const ADMIN = "sergio.freitas@reaktor.com";
const SECRET = "test-secret";
const cookieFor = (email: string, secret = SECRET) => `user=${encodeURIComponent(userCookieValue(email, secret))}`;
const ballot = {
  allowedEmails: ["ada@reaktor.com", "Grace@Reaktor.com"],
  categories: [
    { name: "Best Colleague", nominees: [{ name: "Ada", pictureUrl: "https://example.com/ada.jpg" }, { name: "Grace" }] },
    { name: "Best Idea", nominees: [] },
  ],
};

let app: ReturnType<typeof createApp>;
let pglite: PGlite;

beforeEach(async () => {
  pglite = new PGlite();
  for (const file of readdirSync("supabase/migrations").sort()) {
    await pglite.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  const db: Db = { query: (sql, params) => pglite.query(sql, params as any[]) as any };
  app = createApp(db, {
    appUrl: "http://localhost:3000",
    adminEmails: [ADMIN],
    googleClientId: "client",
    googleClientSecret: "secret",
    sessionSecret: SECRET,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const admin = (method: "get" | "post", url: string) => request(app)[method](url).set("Cookie", cookieFor(ADMIN));

// An attendee on the list, signed in with their Google account.
const attendee = (email = "ada@reaktor.com") => ({
  get: (url: string) => request(app).get(url).set("Cookie", cookieFor(email)),
  post: (url: string) => request(app).post(url).set("Cookie", cookieFor(email)),
});

// Reveals whatever is left, then opens voting.
async function startVoting(id: string, expected = 200) {
  while ((await admin("post", `/api/admin/sessions/${id}/reveal`)).status === 200);
  return admin("post", `/api/admin/sessions/${id}/start`).expect(expected);
}

async function createSession() {
  const res = await admin("post", "/api/admin/sessions").send({ name: "Awards", ballot });
  expect(res.status).toBe(201);
  await admin("post", `/api/admin/sessions/${res.body.id}/next`).expect(200);
  return res.body as { id: string; code: string };
}

function stubGoogle(email: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("token") ? { access_token: "t" } : { email, email_verified: true })),
  ));
}

async function signIn(returnTo?: string) {
  const agent = request.agent(app);
  const start = await agent.get(returnTo ? `/auth/google?returnTo=${encodeURIComponent(returnTo)}` : "/auth/google");
  const state = new URL(start.headers.location).searchParams.get("state");
  return { agent, callback: await agent.get(`/auth/google/callback?code=c&state=${state}`) };
}

describe("admin access", () => {
  it("rejects no cookie, a forged cookie, and attendees", async () => {
    expect((await request(app).get("/api/admin/sessions")).status).toBe(401);
    const forged = cookieFor(ADMIN, "other-secret");
    expect((await request(app).get("/api/admin/sessions").set("Cookie", forged)).status).toBe(401);
    const other = await request(app).get("/api/admin/sessions").set("Cookie", cookieFor("ada@reaktor.com"));
    expect(other.status).toBe(403);
  });

  it("gives admin access only to the admin account after Google sign-in", async () => {
    stubGoogle("ada@reaktor.com");
    const attendeeLogin = await signIn();
    await attendeeLogin.agent.get("/api/admin/me").expect(403);

    stubGoogle(ADMIN);
    const adminLogin = await signIn();
    expect(adminLogin.callback.headers.location).toBe("/admin");
    await adminLogin.agent.get("/api/admin/me").expect(200);
  });

  it("returns to the requested page after sign-in, but never off-site", async () => {
    stubGoogle(ADMIN);
    const session = "/admin/sessions/05d49577-1e52-4aad-9349-d09b3cd9df13";
    expect((await signIn(session)).callback.headers.location).toBe(session);
    expect((await signIn("/display/05d49577-1e52-4aad-9349-d09b3cd9df13")).callback.headers.location).toBe("/display/05d49577-1e52-4aad-9349-d09b3cd9df13");
    expect((await signIn("/s/abc23")).callback.headers.location).toBe("/s/abc23");
    expect((await signIn("https://evil.example")).callback.headers.location).toBe("/admin");
    expect((await signIn("//evil.example")).callback.headers.location).toBe("/admin");
  });

  it("rejects a callback whose state doesn't match", async () => {
    const res = await request(app).get("/auth/google/callback?code=c&state=wrong");
    expect(res.headers.location).toBe("/admin?error=signin");
  });
});

describe("attendee access", () => {
  it("requires sign-in and an email on that session's list", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    await request(app).get(`/api/s/${code}`).expect(401);
    const outsider = attendee("intruder@gmail.com");
    const denied = await outsider.get(`/api/s/${code}`).expect(403);
    expect(denied.body.category).toBeUndefined();
    await outsider.post(`/api/s/${code}/vote`).send({ nomineeId: "00000000-0000-4000-8000-000000000000" }).expect(403);
    // The list is case-insensitive, and an admin isn't let in unless listed.
    await attendee("grace@reaktor.com").get(`/api/s/${code}`).expect(200);
    await attendee(ADMIN).get(`/api/s/${code}`).expect(403);
  });

  it("scopes the list to one session", async () => {
    const first = await createSession();
    const other = await admin("post", "/api/admin/sessions").send({
      name: "Other",
      ballot: { allowedEmails: ["linus@reaktor.com"], categories: ballot.categories },
    });
    await attendee("linus@reaktor.com").get(`/api/s/${other.body.code}`).expect(200);
    await attendee("linus@reaktor.com").get(`/api/s/${first.code}`).expect(403);
  });

  it("counts one vote per Google account, even from another device", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const { nominees } = (await attendee().get(`/api/s/${code}`)).body;
    const phone = request.agent(app);
    const laptop = request.agent(app);
    await phone.post(`/api/s/${code}/vote`).set("Cookie", cookieFor("ada@reaktor.com")).send({ nomineeId: nominees[0].id }).expect(200);
    await laptop.post(`/api/s/${code}/vote`).set("Cookie", cookieFor("ada@reaktor.com")).send({ nomineeId: nominees[1].id }).expect(200);
    expect((await admin("get", `/api/admin/sessions/${id}`)).body.voteCount).toBe(1);
  });

  it("doesn't store the email on the vote", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const { nominees } = (await attendee().get(`/api/s/${code}`)).body;
    await attendee().post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    const { rows } = await pglite.query<{ voter_id: string }>("select voter_id from votes");
    expect(rows[0].voter_id).not.toContain("ada");
  });
});

describe("ballot loading", () => {
  const load = (input: unknown) => admin("post", "/api/admin/sessions").send({ name: "X", ballot: input });

  it("rejects invalid JSON shapes", async () => {
    const twice = await load({ allowedEmails: ["a@b.co"], categories: [{ name: "A", nominees: ["B", "b"] }] });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toContain("twice");
  });

  it("requires a valid list of allowed emails", async () => {
    const categories = ballot.categories;
    expect((await load({ categories })).body.error).toContain("allowedEmails");
    expect((await load({ allowedEmails: [], categories })).body.error).toContain("allowedEmails");
    expect((await load({ allowedEmails: ["nope"], categories })).body.error).toContain("valid email");
  });

  it("allows at most 6 nominees per category", async () => {
    const nominees = (count: number) => Array.from({ length: count }, (_, i) => `Person ${i}`);
    const categories = (count: number) => [{ name: "A", nominees: nominees(count) }];
    expect((await load({ allowedEmails: ["a@b.co"], categories: categories(6) })).status).toBe(201);
    const tooMany = await load({ allowedEmails: ["a@b.co"], categories: categories(7) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toContain("maximum is 6");
  });

  it("stops manually added nominees at 6 too", async () => {
    const created = await load({ allowedEmails: ["a@b.co"], categories: [{ name: "A", nominees: ["1", "2", "3", "4", "5"] }] });
    const url = `/api/admin/sessions/${created.body.id}/nominees`;
    await admin("post", url).send({ name: "6" }).expect(200);
    await admin("post", url).send({ name: "7" }).expect(409);
  });

  it("only accepts https picture URLs", async () => {
    for (const pictureUrl of ["http://example.com/a.jpg", "javascript:alert(1)", "not a url"]) {
      const res = await load({ allowedEmails: ["a@b.co"], categories: [{ name: "A", nominees: [{ name: "B", pictureUrl }] }] });
      expect(res.status).toBe(400);
    }
  });
});

describe("voting flow", () => {
  it("shows no category until the admin presses for the first one", async () => {
    const created = await admin("post", "/api/admin/sessions").send({ name: "Awards", ballot });
    const { id, code } = created.body;

    const lobby = await attendee().get(`/api/s/${code}`);
    expect(lobby.body.stage).toBe("lobby");
    expect(JSON.stringify(lobby.body)).not.toMatch(/Best|Ada/);
    await admin("post", `/api/admin/sessions/${id}/reveal`).expect(409);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    const first = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(first.body).toMatchObject({ stage: "waiting", category: "Best Colleague", position: 1 });
    const shown = await attendee().get(`/api/s/${code}`);
    expect(shown.body.category).toBe("Best Colleague");
  });

  it("reveals nominees one at a time with their pictures and blocks voting until all are shown", async () => {
    const { id, code } = await createSession();
    const voter = attendee();
    const reveal = () => admin("post", `/api/admin/sessions/${id}/reveal`);

    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    await reveal().expect(200);
    expect((await voter.get(`/api/s/${code}`)).body.revealed).toEqual([
      { name: "Ada", pictureUrl: "https://example.com/ada.jpg" },
    ]);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    const all = await reveal().expect(200);
    expect(all.body.revealedCount).toBe(2);
    expect((await voter.get(`/api/s/${code}`)).body.revealed.map((n: any) => n.name)).toEqual(["Ada", "Grace"]);
    await reveal().expect(409);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(200);
    const voting = await voter.get(`/api/s/${code}`);
    expect(voting.body.nominees[0].pictureUrl).toBe("https://example.com/ada.jpg");

    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);
    const next = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(next.body.revealedCount).toBe(0);
  });

  it("never tells attendees how many categories there are", async () => {
    const { code } = await createSession();
    const { body } = await attendee().get(`/api/s/${code}`);
    expect(body.total).toBeUndefined();
    expect(body.position).toBeUndefined();
  });

  it("hides nominees until voting and never exposes counts to attendees", async () => {
    const { id, code } = await createSession();
    const voter = attendee();

    const waiting = await voter.get(`/api/s/${code}`);
    expect(waiting.body).toMatchObject({ stage: "waiting", category: "Best Colleague", revealed: [] });
    expect(waiting.body.nominees).toBeUndefined();

    await startVoting(id, 200);
    const open = await voter.get(`/api/s/${code}`);
    expect(open.body.nominees.map((n: any) => n.name)).toEqual(["Ada", "Grace"]);

    await voter.post(`/api/s/${code}/vote`).send({ nomineeId: open.body.nominees[0].id }).expect(200);
    const voted = await voter.get(`/api/s/${code}`);
    expect(voted.body.myVote).toBe(open.body.nominees[0].id);
    expect(JSON.stringify(voted.body)).not.toMatch(/votes|winner|count/i);

    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);
    const closed = await voter.get(`/api/s/${code}`);
    expect(closed.body.stage).toBe("closed");
    expect(closed.body.nominees).toBeUndefined();
    expect(JSON.stringify(closed.body)).not.toMatch(/Ada|Grace/);
  });

  it("counts one vote per attendee, letting them change it while open", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const a = attendee("ada@reaktor.com");
    const b = attendee("grace@reaktor.com");
    const { nominees } = (await a.get(`/api/s/${code}`)).body;

    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);
    await b.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);

    const open = await admin("get", `/api/admin/sessions/${id}`);
    expect(open.body).toMatchObject({ voteCount: 2, allowedCount: 2, winners: [] });

    const closed = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(closed.body.winners).toEqual([
      { position: 1, category: "Best Colleague", winners: [{ name: "Grace", pictureUrl: null }] },
    ]);
  });

  it("names every top nominee on a tie, and no winner without votes", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const a = attendee("ada@reaktor.com");
    const b = attendee("grace@reaktor.com");
    const { nominees } = (await a.get(`/api/s/${code}`)).body;
    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    await b.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);
    const tied = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(tied.body.winners[0].winners.map((w: any) => w.name)).toEqual(["Ada", "Grace"]);

    await admin("post", `/api/admin/sessions/${id}/next`);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Idea" });
    await startVoting(id);
    const none = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(none.body.winners[1]).toEqual({ position: 2, category: "Best Idea", winners: [] });
  });

  it("rejects votes when closed or for another category's nominee", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const voter = attendee();
    const { nominees } = (await voter.get(`/api/s/${code}`)).body;

    await voter.post(`/api/s/${code}/vote`).send({ nomineeId: "00000000-0000-4000-8000-000000000000" }).expect(409);
    await voter.post(`/api/s/${code}/vote`).send({ nomineeId: "not-a-uuid" }).expect(400);

    await admin("post", `/api/admin/sessions/${id}/stop`);
    await voter.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(409);

    await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Idea" }).expect(200);
    await startVoting(id, 200);
    await voter.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(409);
  });

  it("enforces stage order and finishes after the last category", async () => {
    const { id, code } = await createSession();
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(409);
    await startVoting(id, 200);
    await admin("post", `/api/admin/sessions/${id}/next`).expect(409);
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);

    const second = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(second.body).toMatchObject({ stage: "waiting", category: "Best Idea", position: 2 });

    // The second category has no nominees until one is added by hand.
    await startVoting(id, 409);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Ship it", pictureUrl: "http://example.com/a.jpg" }).expect(400);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Ship it", pictureUrl: "https://example.com/a.jpg" }).expect(200);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "ship IT" }).expect(409);
    await startVoting(id, 200);
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);

    const finished = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(finished.body.stage).toBe("finished");
    const final = await attendee().get(`/api/s/${code}`);
    expect(final.body.stage).toBe("finished");
    expect(final.body.category).toBeUndefined();
  });

  it("serves the QR code and its page without sign-in", async () => {
    const { code } = await createSession();
    const res = await request(app).get(`/api/s/${code}/qr`).expect(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    await request(app).get(`/qr/${code}`).expect(200);
    await request(app).get("/api/s/nope/qr").expect(404);
  });

  it("returns 404 for unknown codes and ids", async () => {
    await attendee().get("/api/s/nope").expect(404);
    await admin("get", "/api/admin/sessions/nope").expect(404);
  });
});

describe("big display", () => {
  async function closedVote() {
    const { id, code } = await createSession();
    const display = () => admin("get", `/api/admin/sessions/${id}/display`);
    await admin("post", `/api/admin/sessions/${id}/reveal`).expect(200);
    const revealing = await display().expect(200);
    expect(revealing.body).toMatchObject({ stage: "waiting", totalNominees: 2, winners: [] });
    expect(revealing.body.nominees.map((n: any) => n.name)).toEqual(["Ada"]);

    await startVoting(id);
    const { nominees } = (await attendee().get(`/api/s/${code}`)).body;
    await attendee().post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);
    return { id, code, display };
  }

  it("needs admin sign-in, since attendees know the session code", async () => {
    const { id } = await createSession();
    await request(app).get(`/api/admin/sessions/${id}/display`).expect(401);
    await request(app).get(`/api/admin/sessions/${id}/display`).set("Cookie", cookieFor("ada@reaktor.com")).expect(403);
  });

  it("shows no category in the lobby", async () => {
    const created = await admin("post", "/api/admin/sessions").send({ name: "Awards", ballot });
    const { body } = await admin("get", `/api/admin/sessions/${created.body.id}/display`);
    expect(body).toMatchObject({ stage: "lobby", category: null, nominees: [], winners: [] });
  });

  it("holds the winner back until the admin shows it, and never tells attendees", async () => {
    const { id, code, display } = await closedVote();
    expect((await display()).body.winners).toEqual([]);

    const shown = await admin("post", `/api/admin/sessions/${id}/show-winner`).expect(200);
    expect(shown.body.stage).toBe("winner");
    expect((await display()).body.winners).toEqual([{ name: "Ada", pictureUrl: "https://example.com/ada.jpg" }]);

    const seen = await attendee().get(`/api/s/${code}`);
    expect(seen.body.stage).toBe("closed");
    expect(JSON.stringify(seen.body)).not.toMatch(/winner|Ada/i);
  });

  it("only shows the winner after voting stops, and moves on from it", async () => {
    const { id } = await createSession();
    await admin("post", `/api/admin/sessions/${id}/show-winner`).expect(409);
    await startVoting(id);
    await admin("post", `/api/admin/sessions/${id}/show-winner`).expect(409);
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);
    await admin("post", `/api/admin/sessions/${id}/show-winner`).expect(200);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Late" }).expect(409);
    const next = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(next.body).toMatchObject({ stage: "waiting", category: "Best Idea" });
  });

  it("serves the display page", async () => {
    const { id } = await createSession();
    await request(app).get(`/display/${id}`).expect(200);
  });
});
