/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { recordAttempt } from "../src/join/service";
import type { JoinRouteDeps } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Acceptance: a throwing analytics write must never 500 the join callback.
//
// `recordAttempt` writes one queryable `join_attempts` row per terminal join
// path (the funnel's analytics). That row is never worth the member's join:
// when the INSERT throws, every callback path must still answer exactly as
// it does with a healthy store — denied/expired/degraded render their
// recovery page, an outage keeps its 503 recovery status, and success still
// signs the member in and redirects. The failure may be bounded-logged
// (exception class only) or silently skipped, but neither the response nor
// any log line may quote the thrown error's message or the live user token.
//
// Hermetic: an in-memory Sql double (throttle statements succeed, only the
// `join_attempts` INSERT throws), a memory session store, and a stubbed
// Discord fetch. No database, no network, no live Discord.

const MOD_ROLE = "1546777856984481792";
// Embedded in the thrown INSERT error's message: if any response or log line
// quotes that message, this probe shows up and the test fails.
const INSERT_PROBE = "attempt-insert-probe-must-never-surface";
const USER_TOKEN = "user-token-probe-must-never-surface";

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

// In-memory Sql double for the journey's statements. Understands exactly the
// queries checkJoinThrottle/recordAttempt emit; anything else is a test bug,
// surfaced loudly. With `throwOnAttemptInsert`, only the analytics INSERT
// fails — throttle and every other statement behave as the healthy store.
function fakeSql({ throwOnAttemptInsert = false } = {}) {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  let attemptInsertTries = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("pg_advisory_xact_lock")) return [];
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
      attemptInsertTries += 1;
      if (throwOnAttemptInsert) {
        throw new Error(`join_attempts insert failed: ${INSERT_PROBE}`);
      }
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
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return {
    sql,
    throttle,
    attempts,
    get attemptInsertTries() {
      return attemptInsertTries;
    },
  };
}

/** Fresh memory session store + env carrying the journey store, per test. */
function isolated(throwOnAttemptInsert: boolean, deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql({ throwOnAttemptInsert });
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, fake, env: e };
}

type DiscordStubOpts = {
  joinStatus?: number;
  memberRoles?: string[];
  tokenMode?: "ok" | "expired_grant" | "outage";
};

function mockDiscord({
  joinStatus = 201,
  memberRoles = [],
  tokenMode = "ok",
}: DiscordStubOpts = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        if (tokenMode === "expired_grant")
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        if (tokenMode === "outage") return new Response("bad", { status: 500 });
        return Response.json({ access_token: USER_TOKEN });
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

// Capture warn/error output so each throwing-store test can prove the
// failure is logged class-only (or not at all) — never with the thrown
// message or the live token. Errors serialize with their message, so a
// `console.warn(err)` slip is caught here rather than hidden by JSON.
function captureLogs() {
  const lines: string[] = [];
  const render = (args: unknown[]) =>
    args
      .map((a) =>
        a instanceof Error ? `${a.name}: ${a.message}` : (JSON.stringify(a) ?? String(a)),
      )
      .join(" ");
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(render(args));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(render(args));
  });
  return lines;
}

function expectNoLeak(lines: string[], body: string) {
  expect(body).not.toContain(INSERT_PROBE);
  expect(body).not.toContain(USER_TOKEN);
  const logged = lines.join("\n");
  expect(logged).not.toContain(INSERT_PROBE);
  expect(logged).not.toContain(USER_TOKEN);
}

const sessionCookie = (res: Response) => res.headers.getSetCookie().join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("join callback with an INSERT-throwing analytics store", () => {
  it("denied consent still renders the recovery page (200, never 500)", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated(true);
    const calls = mockDiscord();
    const start = await startJoin(e, "?source=web-homepage");
    const res = await app.request(
      `/join/callback?error=access_denied&error_description=never-echo&state=${start.state}`,
      { headers: { cookie: start.cookie } },
      e,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).toContain("https://discord.gg/invite");
    expect(sessionCookie(res)).not.toContain("__Host-two_session=");
    expect(calls).toHaveLength(0);
    // The analytics write was attempted exactly once and landed nothing.
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectNoLeak(lines, html);
  });

  it("an expired approval (400 invalid_grant) still renders the expired page (200, never 500)", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated(true);
    mockDiscord({ tokenMode: "expired_grant" });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join approval expired");
    expect(sessionCookie(res)).not.toContain("__Host-two_session=");
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectNoLeak(lines, html);
  });

  it("a lost code on an admitted journey still renders the expired-link page (200, never 500)", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated(true);
    const calls = mockDiscord();
    const { state, cookie } = await startJoin(e);
    // Valid consumed state, but Discord came back without a code.
    const res = await app.request(`/join/callback?state=${state}`, { headers: { cookie } }, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join link expired");
    expect(sessionCookie(res)).not.toContain("__Host-two_session=");
    expect(calls).toHaveLength(0);
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectNoLeak(lines, html);
  });

  it("a Discord outage keeps its 503 recovery status (never turned into a bare 500)", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated(true);
    mockDiscord({ tokenMode: "outage" });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(sessionCookie(res)).not.toContain("__Host-two_session=");
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectNoLeak(lines, html);
  });

  it("a refused bot add (degraded) still renders the invite fallback (200, never 500)", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated(true);
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("https://discord.gg/invite");
    expect(sessionCookie(res)).not.toContain("__Host-two_session=");
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectNoLeak(lines, html);
  });

  it.each([
    [201, "/?n=joined"],
    [204, "/?n=already_member"],
  ])(
    "success (bot add %i) still signs the member in and redirects to %s (never 500)",
    async (joinStatus, redirect) => {
      const lines = captureLogs();
      const { fake, env: e } = isolated(true);
      mockDiscord({ joinStatus });
      const { state, cookie } = await startJoin(e, "?source=web-homepage");
      const res = await finishJoinCb(e, state!, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(redirect);
      // Sign-in really happened: a live session cookie is issued and
      // renders the signed-in home page, analytics row or not.
      expect(sessionCookie(res)).toMatch(/__Host-two_session=[^;]/);
      const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
      expect(await home.text()).toContain("Rick");
      expect(fake.attemptInsertTries).toBe(1);
      expect(fake.attempts).toEqual([]);
      expectNoLeak(lines, await res.clone().text());
    },
  );

  it("a throwing recordAttempt store never rejects", async () => {
    const lines = captureLogs();
    const { sql } = fakeSql({ throwOnAttemptInsert: true });
    await expect(
      recordAttempt(sql, {
        outcome: "added",
        source: "web-homepage",
        requestId: null,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expectNoLeak(lines, "");
  });
});

describe("healthy-store controls (same journeys, analytics rows land)", () => {
  it("denied consent records the denied row and renders the recovery page", async () => {
    const { fake, env: e } = isolated(false);
    mockDiscord();
    const start = await startJoin(e, "?source=web-homepage");
    const res = await app.request(
      `/join/callback?error=access_denied&state=${start.state}`,
      { headers: { cookie: start.cookie } },
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join cancelled");
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: "web-homepage", requestId, discordId: null },
    ]);
  });

  it("an expired approval records the error row and renders the expired page", async () => {
    const { fake, env: e } = isolated(false);
    mockDiscord({ tokenMode: "expired_grant" });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join approval expired");
    expect(fake.attempts).toMatchObject([{ outcome: "error", discordId: null }]);
  });

  it("a Discord outage records the error row and keeps the 503 recovery page", async () => {
    const { fake, env: e } = isolated(false);
    mockDiscord({ tokenMode: "outage" });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Discord is unreachable");
    expect(fake.attempts).toMatchObject([{ outcome: "error", discordId: null }]);
  });

  it("a refused bot add records degraded and renders the invite fallback", async () => {
    const { fake, env: e } = isolated(false);
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    expect(fake.attempts).toMatchObject([{ outcome: "degraded", discordId: "42" }]);
  });

  it("success records added, signs the member in and redirects", async () => {
    const { fake, env: e } = isolated(false);
    mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(sessionCookie(res)).toMatch(/__Host-two_session=[^;]/);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "web-homepage", requestId: null, discordId: "42" },
    ]);
  });
});
