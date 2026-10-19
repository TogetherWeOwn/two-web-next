// Acceptance: a stray hit on the ordinary-login callback must not burn
// the stored return target. Browsers and intermediaries produce stray
// GETs — prefetch, double-click, back-button re-GET, a replayed URL from
// an abandoned attempt — and today every such hit clears the signed
// return-journey cookies before the callback knows whether the hit is
// the real one, so the genuine sign-in that follows lands on the default
// page instead of where the member was headed.
//
// The line this suite pins is admission:
// - NOT admitted (stray): the state does not match the pending journey,
//   the params are oversized, or an OAuth error arrives without a
//   matching state. These hits keep answering the generic failure
//   redirect, but they must leave the whole pending journey intact —
//   the explicit-next cookie, the gate-recorded intended cookie AND the
//   OAuth state cookie (burning the state cookie would make the real
//   hit inadmissible even if the target survived). The next real hit on
//   the same cookie jar still lands on the stored target.
// - Admitted (terminal): the presented state matches and the journey is
//   consumed — success, a real consent denial, or a failed code
//   exchange. Every terminal path still clears both return cookies (and
//   the state cookie), so no target sticks around for a later sign-in.
//   The one deliberate exception is a failed auto-join re-recording the
//   target as the intended page for its retry landing; that behavior is
//   pinned by test/login-return.test.ts and is out of scope here.
//
// Hermetic: every Discord call is mocked, the session store is in
// memory, and no database is touched. One cookie jar per scenario,
// applied the way a browser applies Set-Cookie (later wins, Max-Age=0
// deletes).
import { afterEach, describe, expect, it, vi } from "vitest";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import app from "./app";
import type { Env } from "../src/env";
import { LOGIN_INTENDED_COOKIE, LOGIN_NEXT_COOKIE } from "../src/return-journey";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Not exported by the auth routes; the literal is the pending journey's
// third cookie and is asserted by name like the session cookie elsewhere.
const STATE_COOKIE = "__Host-two_oauth_state";
const SESSION_COOKIE = "__Host-two_session";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const TARGET = "/e/sunday-squad-01";
const INTENDED = "/profile";
const USER_ID = "420000000000000042";
// Comfortably above the inbound code/state bound, far below any URL limit.
const OVERSIZED = "x".repeat(3000);

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// In-memory Sql double for the throttle statements — same shape as
// test/login-return.test.ts.
function fakeSql() {
  const sql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return withThrottleTx(sql);
}

function isolated() {
  const store = createMemorySessionStore();
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fakeSql() },
  } as unknown as Env;
  return { store, env };
}

/** Discord stub with an exchange counter; optionally fails the exchange. */
function mockDiscord({ failExchange = false } = {}) {
  const calls = { exchange: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) {
        calls.exchange += 1;
        if (failExchange) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "user-token" });
      }
      if (url.endsWith("/users/@me"))
        return Response.json({ id: USER_ID, username: "rick", global_name: "Rick", avatar: null });
      if (url.includes(`/members/${USER_ID}`) && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes(`/members/${USER_ID}`))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

// Minimal cookie jar: later Set-Cookie wins, Max-Age=0 deletes — what a
// browser would send back on the next hit.
type Jar = Record<string, string>;
const jarFrom = (res: Response, into: Jar = {}): Jar => {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (value === "" || attrs.some((a) => /max-age=0/i.test(a.trim()))) delete into[name];
    else into[name] = value;
  }
  return into;
};
const sendJar = (j: Jar) =>
  Object.entries(j)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
const setCookies = (res: Response) => res.headers.getSetCookie().join("\n");
const clears = (res: Response, name: string) => setCookies(res).includes(`${name}=; Max-Age=0`);

/**
 * Build one pending login journey in a fresh jar: optionally bounce off
 * the auth gate first (records the intended page), then start OAuth
 * (records the explicit next and the state). Returns the issued state.
 */
async function pendingJourney(env: Env, { intended = true, next = TARGET as string | null } = {}) {
  const jar: Jar = {};
  if (intended) {
    const bounce = await app.request(INTENDED, {}, env);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    jarFrom(bounce, jar);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
  }
  const start = await app.request(
    `/auth/discord${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    { headers: { cookie: sendJar(jar) } },
    env,
  );
  expect(start.status).toBe(302);
  jarFrom(start, jar);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  expect(state).toBeTruthy();
  expect(jar[STATE_COOKIE]).toBeTruthy();
  if (next) expect(jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
  return { jar, state: state! };
}

const callback = (env: Env, query: string, jar: Jar) =>
  app.request(
    `/auth/discord/callback${query ? `?${query}` : ""}`,
    { headers: { cookie: sendJar(jar) } },
    env,
  );

afterEach(() => vi.unstubAllGlobals());

describe("stray callback hits keep the stored return target", () => {
  // Each stray is a hit that must NOT be admitted: it cannot name the
  // pending journey's state (or, for the oversized-code case, it is
  // refused before admission despite naming it).
  const strays: [string, (state: string) => string][] = [
    ["a mismatched state", () => "code=abc&state=not-the-issued-state"],
    ["a bare hit with no params at all", () => ""],
    [
      "an OAuth error without a matching state",
      () => "error=access_denied&state=not-the-issued-state",
    ],
    ["an oversized code with the real state", (state) => `code=${OVERSIZED}&state=${state}`],
    ["an oversized state", () => `code=abc&state=${OVERSIZED}`],
  ];

  it.each(strays)(
    "stray hit (%s) then the real hit still lands on the stored target",
    async (_name, strayQuery) => {
      const calls = mockDiscord();
      const { env } = isolated();
      const { jar, state } = await pendingJourney(env);

      const stray = await callback(env, strayQuery(state), jar);

      // The stray's visible answer is unchanged: the generic failure
      // landing (an unadmitted denial is a failed sign-in, not the
      // cancelled-consent copy), no session, no code exchange.
      expect(stray.status).toBe(302);
      expect(stray.headers.get("location")).toBe("/?n=signin_failed");
      expect(calls.exchange).toBe(0);

      // But the pending journey survives it untouched: the response
      // clears neither return cookie nor the state cookie, so the jar
      // a browser would send next still carries all three.
      expect(clears(stray, LOGIN_NEXT_COOKIE)).toBe(false);
      expect(clears(stray, LOGIN_INTENDED_COOKIE)).toBe(false);
      expect(clears(stray, STATE_COOKIE)).toBe(false);
      jarFrom(stray, jar);
      expect(jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
      expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
      expect(jar[STATE_COOKIE]).toBeTruthy();
      expect(jar[SESSION_COOKIE]).toBeUndefined();

      // The real hit on the same jar is admitted and returns the member
      // to the stored target (explicit next beats intended), then the
      // journey is consumed: both return cookies cleared.
      const real = await callback(env, `code=abc&state=${state}`, jar);
      expect(real.status).toBe(302);
      expect(real.headers.get("location")).toBe(TARGET);
      expect(calls.exchange).toBe(1);
      expect(clears(real, LOGIN_NEXT_COOKIE)).toBe(true);
      expect(clears(real, LOGIN_INTENDED_COOKIE)).toBe(true);
      jarFrom(real, jar);
      expect(jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
      expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
      expect(jar[SESSION_COOKIE]).toBeTruthy();
    },
  );

  it("repeated stray hits in a row still keep the target for the real hit", async () => {
    const calls = mockDiscord();
    const { env } = isolated();
    const { jar, state } = await pendingJourney(env);

    for (const query of [
      "code=abc&state=not-the-issued-state",
      `code=${OVERSIZED}&state=${state}`,
      "",
    ]) {
      const stray = await callback(env, query, jar);
      expect(stray.headers.get("location")).toBe("/?n=signin_failed");
      jarFrom(stray, jar);
      expect(jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
      expect(jar[STATE_COOKIE]).toBeTruthy();
    }
    expect(calls.exchange).toBe(0);

    const real = await callback(env, `code=abc&state=${state}`, jar);
    expect(real.headers.get("location")).toBe(TARGET);
    expect(calls.exchange).toBe(1);
  });

  it("the gate-recorded intended page alone (no explicit next) also survives a stray hit", async () => {
    mockDiscord();
    const { env } = isolated();
    const { jar, state } = await pendingJourney(env, { next: null });
    expect(jar[LOGIN_NEXT_COOKIE]).toBeUndefined();

    const stray = await callback(env, "code=abc&state=not-the-issued-state", jar);
    expect(stray.headers.get("location")).toBe("/?n=signin_failed");
    expect(clears(stray, LOGIN_INTENDED_COOKIE)).toBe(false);
    jarFrom(stray, jar);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    expect(jar[STATE_COOKIE]).toBeTruthy();

    const real = await callback(env, `code=abc&state=${state}`, jar);
    expect(real.status).toBe(302);
    expect(real.headers.get("location")).toBe(INTENDED);
    expect(clears(real, LOGIN_INTENDED_COOKIE)).toBe(true);
  });
});

describe("terminal callback paths still clear the return journey", () => {
  it("success clears both cookies and nothing sticks for the next sign-in", async () => {
    mockDiscord();
    const { env } = isolated();
    const { jar, state } = await pendingJourney(env);

    const real = await callback(env, `code=abc&state=${state}`, jar);
    expect(real.status).toBe(302);
    expect(real.headers.get("location")).toBe(TARGET);
    expect(clears(real, LOGIN_NEXT_COOKIE)).toBe(true);
    expect(clears(real, LOGIN_INTENDED_COOKIE)).toBe(true);
    expect(clears(real, STATE_COOKIE)).toBe(true);
    jarFrom(real, jar);
    expect(jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();

    // No sticky reuse: a later sign-in from the same jar (no explicit
    // next this time) lands on the default notice, not the old target.
    const second = await pendingJourney(env, { intended: false, next: null });
    Object.assign(jar, second.jar);
    const again = await callback(env, `code=abc&state=${second.state}`, jar);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/?n=joined");
  });

  it("a real consent denial (matching state) clears both cookies", async () => {
    const calls = mockDiscord();
    const { env } = isolated();
    const { jar, state } = await pendingJourney(env);

    const denied = await callback(env, `error=access_denied&state=${state}`, jar);
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/?n=signin_denied");
    expect(calls.exchange).toBe(0);
    expect(clears(denied, LOGIN_NEXT_COOKIE)).toBe(true);
    expect(clears(denied, LOGIN_INTENDED_COOKIE)).toBe(true);
    expect(clears(denied, STATE_COOKIE)).toBe(true);
    jarFrom(denied, jar);
    expect(jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
    expect(jar[SESSION_COOKIE]).toBeUndefined();
  });

  it("a failed code exchange after admission clears both cookies", async () => {
    const calls = mockDiscord({ failExchange: true });
    const { env } = isolated();
    const { jar, state } = await pendingJourney(env);

    const failed = await callback(env, `code=abc&state=${state}`, jar);
    expect(failed.status).toBe(302);
    expect(failed.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls.exchange).toBe(1);
    expect(clears(failed, LOGIN_NEXT_COOKIE)).toBe(true);
    expect(clears(failed, LOGIN_INTENDED_COOKIE)).toBe(true);
    expect(clears(failed, STATE_COOKIE)).toBe(true);
    jarFrom(failed, jar);
    expect(jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
    expect(jar[SESSION_COOKIE]).toBeUndefined();
  });
});
