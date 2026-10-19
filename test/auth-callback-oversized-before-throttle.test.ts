// Auth callback refuses oversized OAuth params before throttle.
// route-inventory: GET /auth/discord/callback
//
// Oversized code/state on GET /auth/discord/callback is refused before
// `throttleGuard` spend (zero login-callback budget consumed) with the same
// 302 `/?n=signin_failed` and state/next/intended cookies intact. The branch
// emits its own warn class (never InvalidState, never the values);
// replay/invalid-state lines stay unchanged (silent). Hermetic: memory session
// store, in-memory throttle double, stubbed fetch — no live Discord.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  withheld,
} from "./helpers/diagnostic-stream";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { Env } from "../src/env";
import type { EnvWithThrottle } from "../src/throttle";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "",
};

const OVERSIZED = 8192;
const LOGIN_LOG = "discord sign-in failed";
const LOGIN_ROUTE = "/auth/discord/callback";

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="));

// In-memory stand-in for the shared Postgres fixed-window counter. Records
// every debited bucket so tests assert exactly which bucket a request spent.
function fakeThrottleStore() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) {
      const rows = hits.filter((h) => h.bucket === v[0] && h.at > Date.now() - 60_000);
      return [{ n: rows.length, wait: 30 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      hits.push({ bucket: v[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error(`fakeThrottle: unexpected statement ${head.slice(0, 80)}`);
  }) as unknown as Sql & { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> };
  sql.begin = (run) => run(sql);
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), hits };
}

function exhaustedThrottleStore() {
  const sql = withThrottleTx((async (strings: TemplateStringsArray) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) return [{ n: 999, wait: 30 }];
    return [];
  }) as unknown as Sql);
  return sql;
}

function fixture(throttleSql?: Sql) {
  const throttle = throttleSql ? null : fakeThrottleStore();
  const store = createMemorySessionStore(() => Date.now());
  const create = vi.spyOn(store, "create");
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    THROTTLE_STORE: async () => throttleSql ?? throttle!.sql,
  } as unknown as EnvWithThrottle as Env;
  return { env, create, hits: throttle?.hits ?? [] };
}

function mockDiscord() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "fixture-access-token" });
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "42", username: "Fixture", global_name: null, avatar: null });
    if (url.includes("/members/42") && init?.method === "PUT")
      return new Response(null, { status: 204 });
    if (url.includes("/members/42"))
      return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
    throw new Error("Unexpected network request in oversized-before-throttle fixture");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function start(env: Env, next = "") {
  const res = await app.request(`/auth/discord${next}`, {}, env);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res), res };
}

const recordsFor = (logs: ReturnType<typeof captureDiagnosticStream>, message: string) =>
  logs
    .filter((r) => r.args[0] === message)
    .map((r) => ({ channel: r.channel, args: withheld(r.args, []) as unknown[] }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth callback refuses oversized OAuth params before throttle", () => {
  it("oversized code with a valid state spends zero login-callback budget", async () => {
    const f = fixture();
    const begun = await start(f.env, "?next=%2Fevents");
    const fetch = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "a".repeat(OVERSIZED);
    const res = await app.request(
      `/auth/discord/callback?code=${oversized}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(sessionCookie(res)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    // Zero login-callback spend: only the start's login-redirect hit exists.
    expect(f.hits.filter((h) => h.bucket.startsWith("login-callback:"))).toHaveLength(0);
    expect(f.hits.filter((h) => h.bucket.startsWith("login-redirect:"))).toHaveLength(1);
    // Cookies intact: no state/next/intended clearing and no session issue.
    const setCookies = res.headers.getSetCookie().join("\n");
    expect(setCookies).not.toContain("__Host-two_oauth_state=");
    expect(setCookies).not.toContain("__Host-two_login_next=");
    expect(setCookies).not.toContain("__Host-two_login_intended=");
    // Own warn class, never InvalidState, never the values.
    const line = recordsFor(logs, LOGIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    expect(JSON.stringify(line)).not.toContain("InvalidState");
    expect(JSON.stringify(logs.map((r) => r.args))).not.toContain(oversized.slice(0, 32));
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], {
      request: LOGIN_ROUTE,
      messages: [LOGIN_LOG],
    });
  });

  it("oversized state spends zero login-callback budget", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const fetch = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "s".repeat(OVERSIZED);
    const res = await app.request(
      `/auth/discord/callback?code=c${"c".repeat(31)}&state=${oversized}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(sessionCookie(res)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.hits.filter((h) => h.bucket.startsWith("login-callback:"))).toHaveLength(0);
    const line = recordsFor(logs, LOGIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], {
      request: LOGIN_ROUTE,
      messages: [LOGIN_LOG],
    });
  });

  it("replayed state stays silent and still spends throttle (unchanged line)", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const fetch = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/auth/discord/callback?code=${"c".repeat(32)}&state=mismatch`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    // Replay passes the size gate, so it reaches (and spends) the throttle.
    expect(f.hits.filter((h) => h.bucket.startsWith("login-callback:"))).toHaveLength(1);
    // Replay/invalid-state line unchanged: no sign-in warn for the stray hit.
    expect(recordsFor(logs, LOGIN_LOG)).toHaveLength(0);
    expectDiagnosticStreamClean(logs, [], { request: LOGIN_ROUTE });
  });

  it("throttle-exhausted plus oversized still refuses with the generic failure (precedence)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      THROTTLE_STORE: async () => exhaustedThrottleStore(),
    } as unknown as Env;
    const fetch = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/auth/discord/callback?code=${"a".repeat(OVERSIZED)}&state=${"s".repeat(32)}`,
      {},
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(fetch).not.toHaveBeenCalled();
    const line = recordsFor(logs, LOGIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
  });

  it("throttle-exhausted plus normal-length still answers 429 (throttle intact)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      THROTTLE_STORE: async () => exhaustedThrottleStore(),
    } as unknown as Env;
    const res = await app.request("/auth/discord/callback?code=abc&state=x", {}, env);
    expect(res.status).toBe(429);
  });

  it("normal-length code still reaches the exchange", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const fetch = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/auth/discord/callback?code=${"c".repeat(32)}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(sessionCookie(res)).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/oauth2/token"))).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.hits.filter((h) => h.bucket.startsWith("login-callback:"))).toHaveLength(1);
    expect(recordsFor(logs, LOGIN_LOG)).toHaveLength(0);
  });
});
