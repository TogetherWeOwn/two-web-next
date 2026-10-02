/// <reference types="vite/client" />
// route-inventory: GET /join
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import {
  JOIN_THROTTLE_BUCKET,
  JOIN_THROTTLE_PER_MINUTE,
  checkJoinThrottle,
  finishJoin,
  migrateJoin,
  recordAttempt,
  safeNext,
  sanitizeSource,
} from "../src/join/service";
import type { EnvWithJoin, JoinRouteDeps } from "../src/join/route";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  migrate,
  type Sql,
} from "../src/sessions";
import joinMigration from "../drizzle/1000_join-attempts-throttle.sql?raw";

// W6 acceptance (TOG-9685): the one-click join journey. Ports two-web
// JoinController's funnel contract: /join, /join/discord, /join/callback with
// identify+guilds.join, a 10/min throttle, and the synchronous bot add — the
// live member token is used once in the callback stack frame and never lands
// in a queue table, a row or a log.

const MOD_ROLE = "508654771276873729";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the journey's two statements. Understands exactly
// the queries checkJoinThrottle/recordAttempt emit; anything else is a test
// bug, surfaced loudly.
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, throttle, attempts };
}

/** Fresh memory session store + env carrying a fake journey store, per test. */
function isolated(deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, fake, env: e };
}

type DiscordStubOpts = { joinStatus?: number; memberRoles?: string[]; token?: string };

function mockDiscord({
  joinStatus = 201,
  memberRoles = [],
  token = "user-token",
}: DiscordStubOpts = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        if (token === "EXCHANGE_FAILS") return new Response("bad", { status: 500 });
        return Response.json({ access_token: token });
      }
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes("/members/42"))
        return Response.json({ roles: memberRoles, joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

async function startJoin(e: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, {}, e);
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  return {
    res,
    location,
    state: location?.searchParams.get("state") ?? null,
    cookie: cookiesFrom(res),
  };
}

const finishJoinCb = (e: Env, state: string, cookie: string, extra = "code=abc") =>
  app.request(`/join/callback?${extra}&state=${state}`, { headers: { cookie } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("sanitizeSource (legacy JoinController::rememberSource)", () => {
  it("keeps attribution values, drops anything else without a trace", () => {
    expect(sanitizeSource("web-homepage")).toBe("web-homepage");
    expect(sanitizeSource("XRaS9828r5")).toBe("XRaS9828r5");
    expect(sanitizeSource("a:b_c-d")).toBe("a:b_c-d");
    expect(sanitizeSource("")).toBeNull();
    expect(sanitizeSource("has space")).toBeNull();
    expect(sanitizeSource("a/b")).toBeNull();
    expect(sanitizeSource("-leading")).toBeNull();
    expect(sanitizeSource("x".repeat(65))).toBeNull();
    expect(sanitizeSource("x".repeat(64))).toBe("x".repeat(64));
    expect(sanitizeSource(null)).toBeNull();
    expect(sanitizeSource(42)).toBeNull();
  });
});

describe("safeNext (legacy SafeRedirect::safe)", () => {
  it("passes same-origin paths, rejects open redirects", () => {
    expect(safeNext("/events")).toBe("/events");
    expect(safeNext("/e/abc?x=1")).toBe("/e/abc?x=1");
    expect(safeNext("https://evil.test/")).toBeNull();
    expect(safeNext("//evil.test/")).toBeNull();
    expect(safeNext("/\\evil")).toBeNull();
    expect(safeNext("javascript:alert(1)")).toBeNull();
    expect(safeNext("events")).toBeNull();
    expect(safeNext("")).toBeNull();
    expect(safeNext(null)).toBeNull();
  });

  it.each(["/events\n", "/events\r", "/events\t", "/events next", ["/events"], 42])(
    "rejects whitespace/control characters and non-string input: %j",
    (next) => {
      expect(safeNext(next)).toBeNull();
    },
  );
});

describe("finishJoin (synchronous tail: one bot attempt owns the token)", () => {
  const bot =
    (result: "joined" | "already_member" | "failed", requestId: string | null = null) =>
    async () => ({
      result,
      requestId,
    });

  it("signs in on added / already_member, honoring a safe next", async () => {
    expect(await finishJoin(bot("joined"), "g", "u", "tok", null)).toEqual({
      kind: "signed_in",
      outcome: "added",
      redirect: "/?n=joined",
      requestId: null,
      discordId: "u",
    });
    expect(await finishJoin(bot("already_member"), "g", "u", "tok", null)).toMatchObject({
      kind: "signed_in",
      outcome: "already_member",
      redirect: "/?n=already_member",
    });
    expect(await finishJoin(bot("joined", "req-1"), "g", "u", "tok", "/events")).toMatchObject({
      redirect: "/events",
      requestId: "req-1",
    });
  });

  it("degrades (never throws) when the bot refuses or is unreachable", async () => {
    expect(await finishJoin(bot("failed", "req-9"), "g", "u", "tok", null)).toEqual({
      kind: "recoverable",
      outcome: "degraded",
      requestId: "req-9",
    });
    expect(
      await finishJoin(async () => Promise.reject(new Error("down")), "g", "u", "tok", null),
    ).toEqual({
      kind: "recoverable",
      outcome: "degraded",
      requestId: null,
    });
  });
});

describe("throttle + attempt units (Postgres fixed window)", () => {
  it("allows the 10/min budget, then refuses with a retry hint", async () => {
    const { sql } = fakeSql();
    const bucket = `${JOIN_THROTTLE_BUCKET}:unit`;
    for (let i = 0; i < JOIN_THROTTLE_PER_MINUTE; i++) {
      expect(await checkJoinThrottle(sql, bucket, JOIN_THROTTLE_PER_MINUTE)).toEqual({
        limited: false,
      });
    }
    const verdict = await checkJoinThrottle(sql, bucket, JOIN_THROTTLE_PER_MINUTE);
    expect(verdict.limited).toBe(true);
    if (verdict.limited) expect(verdict.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("a missing store degrades to allow; attempts are a no-op", async () => {
    expect(await checkJoinThrottle(null, "join:unit", 10)).toEqual({ limited: false });
    await expect(
      recordAttempt(null, { outcome: "added", source: null, requestId: null, discordId: "42" }),
    ).resolves.toBeUndefined();
  });

  it("recordAttempt persists exactly the four safe columns", async () => {
    const { sql, attempts } = fakeSql();
    await recordAttempt(sql, {
      outcome: "added",
      source: "web-homepage",
      requestId: "req-1",
      discordId: "42",
    });
    expect(attempts).toEqual([
      { outcome: "added", source: "web-homepage", requestId: "req-1", discordId: "42" },
    ]);
  });
});

describe("GET /join (database-free leaf)", () => {
  it("renders the one-click button, the invite fallback and the server preview", async () => {
    const { env: e } = isolated();
    const res = await app.request("/join", {}, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain('data-testid="join-oneclick"');
    expect(html).toContain("https://discord.gg/invite");
    expect(html).toContain("https://discord.com/widget?id=326474832151838730");
  });

  it("renders without consulting session or journey persistence", async () => {
    const journey = vi.fn(async () => {
      throw new Error("test store must not be reached");
    });
    const sessions = { create: vi.fn(), get: vi.fn(), rotate: vi.fn(), revoke: vi.fn() };
    const { env: e } = isolated({ store: journey });
    const res = await app.request("/join", {}, { ...e, SESSION_STORE: sessions } as Env);
    expect(res.status).toBe(200);
    expect(journey).not.toHaveBeenCalled();
    for (const method of Object.values(sessions)) expect(method).not.toHaveBeenCalled();
  });

  it("stays 200 with a copy fallback when no valid guild id is configured", async () => {
    const { env: e } = isolated();
    const res = await app.request("/join", {}, { ...e, DISCORD_GUILD_ID: "unset" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("Live server preview is unavailable");
  });
});

// W15 ports ReturnToPageTest, JoinWidgetFallbackTest, JoinDenialMatrixTest
// and JoinCallbackFailureTest. Remaining framework-specific cases are mapped
// explicitly in docs/w15-auth-tests.md rather than counted as passing.
describe("W15 join landing and recovery parity", () => {
  it("forwards a safe return path from the landing page to one-click OAuth", async () => {
    const { env: e } = isolated();
    const next = "/events?month=2026-10";
    const res = await app.request(`/join?next=${encodeURIComponent(next)}`, {}, e);
    expect(await res.text()).toContain(`href="/join/discord?next=${encodeURIComponent(next)}"`);
  });

  it.each(["https://evil.test/", "//evil.test/", "/\\evil.test", "javascript:alert(1)"])(
    "strips hostile landing return path %s",
    async (next) => {
      const { env: e } = isolated();
      const html = await (
        await app.request(`/join?next=${encodeURIComponent(next)}`, {}, e)
      ).text();
      expect(html).toContain('href="/join/discord"');
      expect(html).not.toContain(encodeURIComponent(next));
    },
  );

  it("renders the widget with sandbox, lazy loading and no-referrer", async () => {
    const { env: e } = isolated();
    const html = await (await app.request("/join", {}, e)).text();
    for (const attr of [
      'sandbox="allow-scripts allow-same-origin"',
      'loading="lazy"',
      'referrerpolicy="no-referrer"',
    ]) {
      expect(html).toContain(attr);
    }
  });

  it.each(["", "javascript:alert(1)", "https://evil.test/invite"])(
    "uses the static Discord invite on recovery when configuration is unusable: %s",
    async (invite) => {
      const { env: e } = isolated();
      const html = await (
        await app.request(
          "/join/callback?error=access_denied",
          {},
          { ...e, DISCORD_INVITE_URL: invite },
        )
      ).text();
      expect(html).toContain('href="https://discord.gg/4GwEDNRTtx"');
      if (invite) expect(html).not.toContain(invite);
    },
  );

  it.each(["access_denied", "server_error", "temporarily_unavailable"])(
    "clears attribution and return cookies, records a denied outcome and never exchanges on %s",
    async (error) => {
      const { fake, env: e } = isolated();
      const calls = mockDiscord();
      const start = await startJoin(e, "?source=web-homepage&next=/events");
      const res = await app.request(
        `/join/callback?error=${error}&error_description=never-echo`,
        { headers: { cookie: start.cookie } },
        e,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("never-echo");
      expect(calls).toHaveLength(0);
      expect(fake.attempts).toEqual([
        { outcome: "denied", source: "web-homepage", requestId: null, discordId: null },
      ]);
      for (const name of ["state", "source", "next"]) {
        expect(res.headers.getSetCookie().join("\n")).toContain(
          `__Host-two_join_${name}=; Max-Age=0`,
        );
      }
      // Simulate the browser after the deletion cookies: no stale attribution.
      await app.request("/join/callback?error=access_denied", {}, e);
      expect(fake.attempts[1]?.source).toBeNull();
    },
  );

  it("records already-member separately, issues a session, and consumes safe return state", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 204 });
    const { state, cookie } = await startJoin(e, "?source=returning&next=/events");
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.headers.get("location")).toBe("/events");
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    expect(fake.attempts).toEqual([
      { outcome: "already_member", source: "returning", requestId: null, discordId: "42" },
    ]);
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_join_next=; Max-Age=0");
  });

  it("a refused bot join records degradation but never issues a successful member session", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(fake.attempts[0]?.outcome).toBe("degraded");
  });
});

describe("GET /join/discord (throttled OAuth start)", () => {
  it("redirects to Discord with identify+guilds.join and the /join/callback redirect URI", async () => {
    const { env: e } = isolated();
    const { res, location, state, cookie } = await startJoin(e);
    expect(res.status).toBe(302);
    expect(location!.origin + location!.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location!.searchParams.get("scope")).toBe("identify guilds.join");
    expect(location!.searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/join/callback",
    );
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie).toContain("__Host-two_join_state=");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("remembers a valid source and next, drops hostile values", async () => {
    const { env: e } = isolated();
    const { res } = await startJoin(e, "?source=web-homepage&next=/events");
    expect(res.status).toBe(302);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toContain("__Host-two_join_source=");
    expect(set).toContain("__Host-two_join_next=");
    const hostile = await startJoin(e, "?source=a/b&next=https://evil.test/");
    expect(hostile.res.status).toBe(302);
    expect(hostile.res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_join_source=");
  });

  it("refuses the 11th start in one minute with 429 + Retry-After", async () => {
    const { fake, env: e } = isolated({ now: () => 1_791_000_000_000 });
    for (let i = 0; i < 10; i++) {
      expect((await app.request("/join/discord", {}, e)).status).toBe(302);
    }
    const limited = await app.request(
      "/join/discord",
      { headers: { accept: "application/json" } },
      e,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ reason: "rate_limited" });
    expect(fake.throttle).toHaveLength(10);
  });
});

describe("GET /join/callback (synchronous bot add + sign-in)", () => {
  it("adds the member, signs them in and records the attempt", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");

    const put = calls.find((c) => c.url.includes("/members/42") && c.init?.method === "PUT")!;
    expect((put.init?.headers as Record<string, string>).authorization).toBe("Bot bot-token");
    expect(JSON.parse(put.init?.body as string)).toEqual({ access_token: "user-token" });

    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).toContain("Rick");

    expect(fake.attempts).toEqual([
      { outcome: "added", source: "web-homepage", requestId: null, discordId: "42" },
    ]);
  });

  it("treats 204 as already a member and honors a safe next", async () => {
    const { env: e } = isolated();
    mockDiscord({ joinStatus: 204 });
    const { state, cookie } = await startJoin(e, "?next=/events");
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.headers.get("location")).toBe("/events");
  });

  it("renders the recovery page with the invite fallback when the bot refuses", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("https://discord.gg/invite");
    expect(html).toContain('data-testid="recovery-retry"');
    expect(fake.attempts[0]).toMatchObject({ outcome: "degraded", discordId: "42" });
  });

  it("renders the recovery page (never an error echo) when consent is denied", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const res = await app.request(
      "/join/callback?error=access_denied&error_description=ashould-never-appear",
      {},
      e,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).not.toContain("ashould-never-appear");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: null, requestId: null, discordId: null },
    ]);
  });

  it("renders the expired-link page when state is missing or forged", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const { cookie } = await startJoin(e);
    for (const q of ["code=abc&state=forged", "code=abc"]) {
      const res = await app.request(`/join/callback?${q}`, { headers: { cookie } }, e);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Join link expired");
    }
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(2);
  });

  it("503s the recovery page when Discord is unreachable", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ token: "EXCHANGE_FAILS" });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Discord is unreachable");
    expect(fake.attempts[0]).toMatchObject({ outcome: "error" });
  });

  it("throttles the callback on the same shared budget", async () => {
    const { env: e } = isolated({ now: () => 1_791_000_000_000 });
    for (let i = 0; i < 10; i++) {
      await app.request("/join/callback?error=access_denied", {}, e);
    }
    const limited = await app.request("/join/callback?error=access_denied", {}, e);
    expect(limited.status).toBe(429);
  });
});

describe("token hygiene (W6 acceptance)", () => {
  it("the live member token never reaches the journey store", async () => {
    const probe = `tok-hygiene-probe-${Date.now()}`;
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 201, token: probe });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(302);
    // Nothing the journey persisted quotes the token: the only values that
    // reach the store are outcome, source, request_id and discord_id.
    expect(JSON.stringify(fake.attempts)).not.toContain(probe);
    expect(JSON.stringify(fake.throttle)).not.toContain(probe);
  });
});

// Live against agent-testdb in a throwaway schema. Skipped when DATABASE_URL is
// unset (CI has no test-DB access). Never point this at anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("join journey (agent-testdb)", () => {
  const schemaName = `w6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;
  const TOKEN = `tok-live-probe-${schemaName}`;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, connection: { search_path: schemaName } });
    // Canonical migration SQL is the source of truth, not the runtime DDL.
    for (const stmt of joinMigration.split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
    await migrate(sql as unknown as Sql);
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("migrateJoin is a no-op on a migrated database and heals a fresh one", async () => {
    await migrateJoin(sql as unknown as Sql);
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName}
      AND tablename IN ('join_attempts', 'web_throttle_hits')`;
    expect(tables.map((t) => t.tablename).sort()).toEqual(["join_attempts", "web_throttle_hits"]);
  });

  it("full round trip: throttle counts, attempt lands, token appears in no table", async () => {
    const store = createPostgresSessionStore(sql as unknown as Sql);
    const e = {
      ...env,
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => sql as unknown as Sql },
    } as unknown as Env;
    mockDiscord({ joinStatus: 201, token: TOKEN });

    const start = await app.request("/join/discord?source=web-homepage", {}, e);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    const cb = await app.request(
      `/join/callback?code=abc&state=${location.searchParams.get("state")}`,
      {
        headers: { cookie: cookiesFrom(start) },
      },
      e,
    );
    expect(cb.headers.get("location")).toBe("/?n=joined");

    const attempts = await sql<
      { outcome: string; source: string | null; discord_id: string | null }[]
    >`
      SELECT outcome, source, discord_id FROM join_attempts`;
    expect(attempts).toEqual([{ outcome: "added", source: "web-homepage", discord_id: "42" }]);
    const hits = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM web_throttle_hits`;
    expect(Number(hits[0]!.n)).toBeGreaterThanOrEqual(2);

    // Token hygiene against the real tables: no text column quotes the token.
    for (const table of ["join_attempts", "web_throttle_hits"] as const) {
      const cols = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schemaName} AND table_name = ${table}
        AND data_type IN ('text', 'character varying')`;
      for (const { column_name } of cols) {
        const found = (await sql.unsafe(
          `SELECT count(*)::int AS n FROM ${schemaName}.${table} WHERE ${column_name} LIKE '%${TOKEN}%'`,
        )) as unknown as { n: number }[];
        expect(found[0]!.n, `${table}.${column_name}`).toBe(0);
      }
    }
  });
});
