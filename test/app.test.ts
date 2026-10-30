import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Db } from "../src/app.js";
import { adminCookieValue } from "../src/auth.js";

const ADMIN = "sergio.freitas@reaktor.com";
const SECRET = "test-secret";
const adminCookie = `admin=${encodeURIComponent(adminCookieValue(ADMIN, SECRET))}`;
const ballot = {
  categories: [
    { name: "Best Colleague", nominees: ["Ada", { name: "Grace" }] },
    { name: "Best Idea", nominees: [] },
  ],
};

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const pglite = new PGlite();
  await pglite.exec(readFileSync("supabase/migrations/001_init_voting.sql", "utf8"));
  await pglite.exec(readFileSync("supabase/migrations/002_add_revealed_count.sql", "utf8"));
  await pglite.exec(readFileSync("supabase/migrations/003_add_lobby_stage.sql", "utf8"));
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

const admin = (method: "get" | "post", url: string) => request(app)[method](url).set("Cookie", adminCookie);

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

describe("admin access", () => {
  it("rejects requests with no cookie, a forged cookie, or a removed admin", async () => {
    expect((await request(app).get("/api/admin/sessions")).status).toBe(401);
    const forged = `admin=${encodeURIComponent(adminCookieValue(ADMIN, "other-secret"))}`;
    expect((await request(app).get("/api/admin/sessions").set("Cookie", forged)).status).toBe(401);
    const other = `admin=${encodeURIComponent(adminCookieValue("someone@reaktor.com", SECRET))}`;
    expect((await request(app).get("/api/admin/sessions").set("Cookie", other)).status).toBe(401);
  });

  it("only signs in the allowed Google account", async () => {
    const google = (email: string) =>
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(url.includes("token") ? { access_token: "t" } : { email, email_verified: true })),
      );

    const signIn = async () => {
      const agent = request.agent(app);
      const start = await agent.get("/auth/google");
      const state = new URL(start.headers.location).searchParams.get("state");
      return agent.get(`/auth/google/callback?code=c&state=${state}`);
    };

    vi.stubGlobal("fetch", google("intruder@gmail.com"));
    const denied = await signIn();
    expect(denied.headers.location).toBe("/admin?error=denied");
    expect(denied.headers["set-cookie"]?.toString()).not.toContain("admin=");

    vi.stubGlobal("fetch", google(ADMIN));
    const ok = await signIn();
    expect(ok.headers.location).toBe("/admin");
    expect(ok.headers["set-cookie"]?.toString()).toContain("admin=");
  });

  it("returns to the requested session after sign-in, but never off-site", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("token") ? { access_token: "t" } : { email: ADMIN, email_verified: true })),
    ));
    const signIn = async (returnTo: string) => {
      const agent = request.agent(app);
      const start = await agent.get(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
      const state = new URL(start.headers.location).searchParams.get("state");
      return agent.get(`/auth/google/callback?code=c&state=${state}`);
    };
    const session = "/admin/sessions/05d49577-1e52-4aad-9349-d09b3cd9df13";
    expect((await signIn(session)).headers.location).toBe(session);
    expect((await signIn("https://evil.example")).headers.location).toBe("/admin");
    expect((await signIn("//evil.example")).headers.location).toBe("/admin");
  });

  it("rejects a callback whose state doesn't match", async () => {
    const res = await request(app).get("/auth/google/callback?code=c&state=wrong");
    expect(res.headers.location).toBe("/admin?error=signin");
  });
});

describe("ballot loading", () => {
  it("rejects invalid JSON shapes", async () => {
    const res = await admin("post", "/api/admin/sessions").send({ name: "X", ballot: { categories: [{ name: "A", nominees: ["B", "b"] }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("twice");
  });
});

describe("voting flow", () => {
  it("shows no category until the admin presses for the first one", async () => {
    const created = await admin("post", "/api/admin/sessions").send({ name: "Awards", ballot });
    const { id, code } = created.body;

    const lobby = await request(app).get(`/api/s/${code}`);
    expect(lobby.body.stage).toBe("lobby");
    expect(JSON.stringify(lobby.body)).not.toMatch(/Best|Ada/);
    await admin("post", `/api/admin/sessions/${id}/reveal`).expect(409);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    const first = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(first.body).toMatchObject({ stage: "waiting", category: "Best Colleague", position: 1 });
    const shown = await request(app).get(`/api/s/${code}`);
    expect(shown.body.category).toBe("Best Colleague");
  });

  it("reveals nominees one at a time and blocks voting until all are shown", async () => {
    const { id, code } = await createSession();
    const voter = request.agent(app);
    const reveal = () => admin("post", `/api/admin/sessions/${id}/reveal`);

    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    await reveal().expect(200);
    expect((await voter.get(`/api/s/${code}`)).body.revealed).toEqual(["Ada"]);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(409);

    const all = await reveal().expect(200);
    expect(all.body.revealedCount).toBe(2);
    expect((await voter.get(`/api/s/${code}`)).body.revealed).toEqual(["Ada", "Grace"]);
    await reveal().expect(409);
    await admin("post", `/api/admin/sessions/${id}/start`).expect(200);

    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);
    const next = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(next.body.revealedCount).toBe(0);
  });

  it("never tells attendees how many categories there are", async () => {
    const { code } = await createSession();
    const { body } = await request(app).get(`/api/s/${code}`);
    expect(body.total).toBeUndefined();
    expect(body.position).toBeUndefined();
  });

  it("hides nominees until voting and never exposes counts to attendees", async () => {
    const { id, code } = await createSession();
    const voter = request.agent(app);

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
    const a = request.agent(app);
    const b = request.agent(app);
    const { nominees } = (await a.get(`/api/s/${code}`)).body;
    await b.get(`/api/s/${code}`);

    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);
    await b.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);

    const open = await admin("get", `/api/admin/sessions/${id}`);
    expect(open.body.voteCount).toBe(2);
    expect(open.body.winners).toEqual([]);

    const closed = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(closed.body.winners).toEqual([{ position: 1, category: "Best Colleague", winners: ["Grace"] }]);
  });

  it("names every top nominee on a tie, and no winner without votes", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const a = request.agent(app);
    const b = request.agent(app);
    const { nominees } = (await a.get(`/api/s/${code}`)).body;
    await a.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[0].id }).expect(200);
    await b.post(`/api/s/${code}/vote`).send({ nomineeId: nominees[1].id }).expect(200);
    const tied = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(tied.body.winners[0].winners).toEqual(["Ada", "Grace"]);

    await admin("post", `/api/admin/sessions/${id}/next`);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Idea" });
    await startVoting(id);
    const none = await admin("post", `/api/admin/sessions/${id}/stop`);
    expect(none.body.winners[1]).toEqual({ position: 2, category: "Best Idea", winners: [] });
  });

  it("rejects votes when closed or for another category's nominee", async () => {
    const { id, code } = await createSession();
    await startVoting(id);
    const voter = request.agent(app);
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
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "Ship it" }).expect(200);
    await admin("post", `/api/admin/sessions/${id}/nominees`).send({ name: "ship IT" }).expect(409);
    await startVoting(id, 200);
    await admin("post", `/api/admin/sessions/${id}/stop`).expect(200);

    const finished = await admin("post", `/api/admin/sessions/${id}/next`).expect(200);
    expect(finished.body.stage).toBe("finished");
    const attendee = await request(app).get(`/api/s/${code}`);
    expect(attendee.body.stage).toBe("finished");
    expect(attendee.body.category).toBeUndefined();
  });

  it("serves the QR code and its page without sign-in", async () => {
    const { code } = await createSession();
    const res = await request(app).get(`/api/s/${code}/qr`).expect(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    await request(app).get(`/qr/${code}`).expect(200);
    await request(app).get("/api/s/nope/qr").expect(404);
  });

  it("returns 404 for unknown codes and ids", async () => {
    await request(app).get("/api/s/nope").expect(404);
    await admin("get", "/api/admin/sessions/nope").expect(404);
  });
});
