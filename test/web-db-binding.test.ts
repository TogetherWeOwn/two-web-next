// Exercise runtime factories (no injected stores) against an owned test schema.
// The driver wrapper only pins search_path; all SQL goes to test containers.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const state = vi.hoisted(() => ({
  schema: "",
  urls: [] as string[],
  clients: [] as { end: () => Promise<void> }[],
}));
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return { default: (url: string, options: Record<string, unknown> = {}) => {
    const safe = testDatabaseUrl(url);
    const client = original(url, {
      ...options,
      password: () => safe.password,
      ...(state.schema ? { connection: { search_path: state.schema }, onnotice: () => {} } : {}),
    });
    if (state.schema) {
      state.urls.push(url);
      state.clients.push(client);
    }
    return client;
  } };
});

const baseEnv: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_GUILD_ID: "test-guild",
  DISCORD_INVITE_URL: "https://discord.gg/test",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_BOT_TOKEN: "test-bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  QA_AUTH_TOKEN: "test-only-qa-token",
};
const cookieFrom = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const memberId = QA_IDENTITIES["qa-member"]!.discordId;

describe.skipIf(!process.env.DATABASE_URL)("web DB binding (test container)", () => {
  let fixture: MemberDataFixture;
  let env: Env;
  const upcomingKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  const request = async (path: string, init: RequestInit = {}, bindings = env) => {
    try {
      return await app.request(path, init, bindings);
    } finally {
      // Request-scoped clients must not exhaust CI's 100-connection service
      // while exercising 30 rapid writes. Persistence must survive closure.
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
    }
  };

  beforeAll(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!).href;
    fixture = await createMemberDataFixture(url);
    state.schema = fixture.schemaName;
    // Deliberately omit DATABASE_URL and every store/DB injection seam.
    env = { ...baseEnv, DB: { connectionString: url } };
    await fixture.db.insert(events).values([
      { eventKey: upcomingKey, title: "Binding game night", status: "published",
        startsAt: new Date("2099-01-01T12:00:00Z"), endsAt: new Date("2099-01-01T14:00:00Z") },
      { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW", title: "Binding past night", status: "published",
        startsAt: new Date("2000-01-01T12:00:00Z"), endsAt: new Date("2000-01-01T14:00:00Z") },
    ]);
  });

  afterAll(async () => {
    await Promise.all(state.clients.map((client) => client.end()));
    state.schema = "";
    await fixture?.dispose();
  });

  const login = async (identity = "qa-member", bindings = env) => {
    const res = await request(`/auth/qa/${identity}`, {
      method: "POST", headers: { origin: bindings.APP_URL, "X-TWO-QA-Auth": baseEnv.QA_AUTH_TOKEN! },
    }, bindings);
    expect(res.status).toBe(204);
    return cookieFrom(res);
  };

  it("serves event list, calendar, RSS and past routes through DB alone", async () => {
    for (const path of ["/events", "/events?view=calendar", "/events.rss", "/events/past"]) {
      const res = await request(path, {}, env);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("Events temporarily unavailable");
      expect(body).toContain(path === "/events/past" ? "Binding past night" : "Binding game night");
    }
  });

  it("persists login, roster and profile across requests; rotation and logout still revoke", async () => {
    const cookie = await login();
    const [user] = await fixture.client`SELECT id, username, member FROM users WHERE id = ${memberId}`;
    expect(user).toMatchObject({ id: memberId, username: "QA Member", member: true });
    const profile = await request("/profile", { headers: { cookie } }, env);
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain("QA Member");
    const home = await request("/", { headers: { cookie } }, env);
    expect(home.status).toBe(200);
    const rotated = cookieFrom(home);
    expect(rotated).not.toBe(cookie);
    expect((await request("/profile", { headers: { cookie } }, env)).status).toBe(302);
    expect((await request("/profile", { headers: { cookie: rotated } }, env)).status).toBe(200);
    expect((await request("/logout", { method: "POST", headers: { cookie: rotated, origin: env.APP_URL } }, env)).status).toBe(303);
    expect((await request("/profile", { headers: { cookie: rotated } }, env)).status).toBe(302);
  });

  it("resolves admin sessions without granting members moderator access", async () => {
    const member = await login();
    expect((await request("/admin", { headers: { cookie: member } }, env)).status).toBe(403);
    const moderator = await login("qa-moderator");
    expect((await request("/admin", { headers: { cookie: moderator } }, env)).status).toBe(200);
  });

  // Sequential requests open and close real SQL clients on shared CI runners.
  // These throttle assertions need a bounded integration budget, not a latency gate.
  it("enforces profile writes at 30/min through the binding", async () => {
    const cookie = await login();
    // Isolate this budget from other requests and the wall-clock minute boundary.
    await fixture.client`DELETE FROM web_throttle_hits`;
    const write = () => request(`/members/${memberId}`, {
      method: "PATCH", headers: { cookie, origin: env.APP_URL, "content-type": "application/json" },
      body: JSON.stringify({ bio: "Binding bio", games: ["Chess"], timezone: "UTC" }),
    }, env);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (let i = 0; i < 30; i++) expect((await write()).status).toBe(303);
      expect((await write()).status).toBe(429);
    } finally { clock.mockRestore(); }
  }, 30_000);

  it("enforces join starts at 10/min through the binding", async () => {
    await fixture.client`DELETE FROM web_throttle_hits`;
    // Join's existing minute bucket gets an injected clock, not an injected store.
    const bindings = { ...env, JOIN_DEPS: { now: () => 60_000 } } as Env;
    for (let i = 0; i < 10; i++) {
      expect((await request("/join/discord", {}, bindings)).status).toBe(302);
    }
    expect((await request("/join/discord", {}, bindings)).status).toBe(429);
  }, 30_000);

  it("keeps explicit configuration ahead of the binding in all login/profile factories", async () => {
    state.urls.length = 0;
    const explicit = { ...env, DATABASE_URL: env.DB!.connectionString,
      DB: { connectionString: "postgres://unused.invalid/db" } };
    const cookie = await login("qa-member", explicit);
    expect((await request("/profile", { headers: { cookie } }, explicit)).status).toBe(200);
    expect(state.urls.length).toBeGreaterThan(0);
    expect(state.urls.every((url) => url === explicit.DATABASE_URL)).toBe(true);
  });
});
