// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: POST /logout
//
// ACCEPTANCE-OWNED (V6 auth store-failure logging): the Builder builds on this
// branch and never edits this file. Fail-first contract for the three silent
// session-store failures in src/auth/routes.ts:
//
//   - GET /auth/discord with an unacquirable store warns LOGIN_NULL_STORE once
//     (exception class + request_id); the redirect stays signin_failed.
//   - GET /auth/discord with a throwing journeys sweep/issue warns
//     LOGIN_JOURNEY_FAILED once (exception class + request_id); signin_failed.
//   - POST /logout with a throwing revoke/revokeLineage errors
//     LOGOUT_REVOKE_FAILED once (exception class + request_id); the
//     authoritative 503 ("Sign-out temporarily unavailable", zero Set-Cookie)
//     is unchanged.
//
// Boundaries: issue() returning false (not a throw) stays silent; stray
// callback hits and consent denials stay silent; the callback-consume and
// exchange-failure lines are untouched. Every new field is class-only plus
// request_id — never a message, token, cookie, Discord ID or secret.
//
// Hermetic only: memory session store, serializeSigned-minted cookies, stubbed
// fetch. No DATABASE_URL, no live Discord.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";

const TOK = "***synthetic-access-7f3a***";
const SECRET = "***synthetic-secret-4t8z***";

const LOGIN_NULL_STORE = "auth login-start store unavailable";
const LOGIN_JOURNEY_FAILED = "auth login-start journey failed";
const LOGOUT_REVOKE_FAILED = "logout revocation failed";
const LOGIN_LOG = "discord sign-in failed";

const LOGIN_START_ROUTE = "/auth/discord";
const LOGIN_ROUTE = "/auth/discord/callback";
const LOGOUT_ROUTE = "/logout";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const isolated = () => {
  const store = createMemorySessionStore();
  return { store, env: { ...baseEnv, SESSION_STORE: store } as Env };
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Every console channel and every field: the full stream a request can write. */
const streamClean = (logs: DiagnosticRecord[], request: string, messages: string[] = []) =>
  expectDiagnosticStreamClean(logs, [TOK, SECRET], { request, messages });

/** The records written under one message, marker-free so a failing diff cannot print a leak. */
const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, SECRET]) as unknown[],
    }));

// The null throttle store intentionally warns once per guarded request
// (fail-open allow, contracted by the silent-fallback slice and pinned by
// its own acceptance); this file only owns V6 session-store silence, so it
// filters that contracted line before asserting channel counts. The line
// stays in streamClean's leak scan.
const THROTTLE_NULL_STORE_WARN = "Throttle store unavailable; allowing the request.";
const v6ChannelCounts = (logs: DiagnosticRecord[]) =>
  channelCounts(logs.filter((record) => record.args[0] !== THROTTLE_NULL_STORE_WARN));

/** Nothing a member, an operator or a log tail can read may carry a synthetic secret. */
const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text.includes(TOK), "synthetic token on a readable surface").toBe(false);
  expect(text.includes(SECRET), "synthetic secret on a readable surface").toBe(false);
};

class StoreAcquisitionFailed extends Error {}
class JourneyWriteFailed extends Error {}
class RevocationFailed extends Error {}

/** Env whose session-store acquisition rejects: exercises the login-start null-store path. */
function nullStoreEnv(): Env {
  const e = { ...baseEnv } as Env;
  Object.defineProperty(e, "SESSION_STORE", {
    enumerable: true,
    configurable: true,
    get(): SessionStore {
      throw new StoreAcquisitionFailed(`connect ECONNREFUSED ${TOK}`, {
        cause: new Error(`nested ${SECRET}`),
      });
    },
  });
  return e;
}

const signedSessionCookie = async (token: string) =>
  (
    await serializeSigned(SESSION_COOKIE, token, baseEnv.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;

const signedStatusCookie = async (value: string) =>
  (
    await serializeSigned(AUTH_STATUS_COOKIE, value, baseEnv.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;

/** A live memory-store session plus its signed cookie, without the QA seam. */
async function liveSession(store: SessionStore) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000102",
    username: "w15-member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return signedSessionCookie(token);
}

const logout = (e: Env, cookie: string) =>
  app.request("/logout", { method: "POST", headers: { cookie, origin: e.APP_URL } }, e);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("login start warns on session-store failure", () => {
  it("null store warns once, class-only plus request_id; the redirect stays signin_failed", async () => {
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/discord", {}, nullStoreEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.getSetCookie().join(";")).not.toContain("__Host-two_oauth_state=");
    const line = recordsFor(logs, LOGIN_NULL_STORE);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      LOGIN_NULL_STORE,
      { exception: "StoreAcquisitionFailed", request_id: res.headers.get("x-request-id") },
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, LOGIN_START_ROUTE, [LOGIN_NULL_STORE]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("a throwing journey sweep warns once; the redirect stays signin_failed", async () => {
    const { store, env: e } = isolated();
    store.journeys.sweepExpired = async () => {
      throw new JourneyWriteFailed(`sweep ECONNREFUSED ${TOK}`, {
        cause: new Error(`nested ${SECRET}`),
      });
    };
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/discord", {}, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    const line = recordsFor(logs, LOGIN_JOURNEY_FAILED);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      LOGIN_JOURNEY_FAILED,
      { exception: "JourneyWriteFailed", request_id: res.headers.get("x-request-id") },
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, LOGIN_START_ROUTE, [LOGIN_JOURNEY_FAILED]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("a throwing journey issue warns once; the redirect stays signin_failed", async () => {
    const { store, env: e } = isolated();
    store.journeys.issue = async () => {
      throw new JourneyWriteFailed(`issue ECONNREFUSED ${TOK}`, {
        cause: new Error(`nested ${SECRET}`),
      });
    };
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/discord", {}, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    const line = recordsFor(logs, LOGIN_JOURNEY_FAILED);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      LOGIN_JOURNEY_FAILED,
      { exception: "JourneyWriteFailed", request_id: res.headers.get("x-request-id") },
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, LOGIN_START_ROUTE, [LOGIN_JOURNEY_FAILED]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("issue() returning false is not a store failure: silent signin_failed", async () => {
    const { store, env: e } = isolated();
    store.journeys.issue = async () => false;
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/discord", {}, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGIN_START_ROUTE);
  });

  it("control: a healthy login start stays silent and mints the OAuth state", async () => {
    const { env: e } = isolated();
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/discord", {}, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://discord.com/oauth2/authorize");
    expect(res.headers.getSetCookie().join(";")).toContain("__Host-two_oauth_state=");
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGIN_START_ROUTE);
  });
});

describe("callback strays and denials stay silent; the callback path is untouched", () => {
  it.each([
    ["bare hit", "/auth/discord/callback", ""],
    ["forged state without a cookie", "/auth/discord/callback?code=abc&state=forged", ""],
  ])("stray %s: silent signin_failed", async (_name, path, cookie) => {
    const { env: e } = isolated();
    const logs = captureDiagnosticStream();
    const res = await app.request(path, { headers: { cookie } }, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGIN_ROUTE);
  });

  it("stray forged state presenting a real cookie: silent signin_failed", async () => {
    const { env: e } = isolated();
    const start = await app.request("/auth/discord", {}, e);
    const logs = captureDiagnosticStream();
    const res = await app.request(
      "/auth/discord/callback?code=abc&state=forged",
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGIN_ROUTE);
  });

  it("admitted consent denial: silent signin_denied with zero exchange calls", async () => {
    const { env: e } = isolated();
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
        calls.push(url);
        return new Response("{}", { status: 200 });
      }),
    );
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/auth/discord/callback?error=access_denied&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_denied");
    expect(calls).toHaveLength(0);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGIN_ROUTE);
  });

  it("untouched pin: an admitted exchange failure keeps the legacy line exactly", async () => {
    const { env: e } = isolated();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_grant", error_description: `refresh ${TOK} revoked` },
          {
            status: 400,
          },
        ),
      ),
    );
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(recordsFor(logs, LOGIN_LOG).map((r) => r.args)).toEqual([
      [
        LOGIN_LOG,
        {
          exception: "DiscordError",
          kind: "expired_grant",
          status: 400,
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
  });
});

describe("logout revocation failure errors once; the 503 behavior is unchanged", () => {
  it("revoke throw errors once, class-only plus request_id; 503 with zero Set-Cookie", async () => {
    const { store, env: e } = isolated();
    const cookie = await liveSession(store);
    const revoke = vi.spyOn(store, "revoke").mockRejectedValue(
      new RevocationFailed(`revoke ECONNREFUSED ${TOK}`, {
        cause: new Error(`nested ${SECRET}`),
      }),
    );
    const logs = captureDiagnosticStream();
    const res = await logout(e, cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toBe("Sign-out temporarily unavailable");
    const line = recordsFor(logs, LOGOUT_REVOKE_FAILED);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("error");
    expect(line[0]!.args).toEqual([
      LOGOUT_REVOKE_FAILED,
      { exception: "RevocationFailed", request_id: res.headers.get("x-request-id") },
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 1 });
    streamClean(logs, LOGOUT_ROUTE, [LOGOUT_REVOKE_FAILED]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("lineage-revocation throw errors once; 503 with zero Set-Cookie", async () => {
    const { store, env: e } = isolated();
    const cookie = `${await liveSession(store)}; ${await signedStatusCookie("a".repeat(64))}`;
    const revokeLineage = vi.spyOn(store, "revokeLineage").mockRejectedValue(
      new RevocationFailed(`lineage ECONNREFUSED ${TOK}`, {
        cause: new Error(`nested ${SECRET}`),
      }),
    );
    const logs = captureDiagnosticStream();
    const res = await logout(e, cookie);
    expect(res.status).toBe(503);
    expect(revokeLineage).toHaveBeenCalledOnce();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toBe("Sign-out temporarily unavailable");
    const line = recordsFor(logs, LOGOUT_REVOKE_FAILED);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("error");
    expect(line[0]!.args).toEqual([
      LOGOUT_REVOKE_FAILED,
      { exception: "RevocationFailed", request_id: res.headers.get("x-request-id") },
    ]);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 1 });
    streamClean(logs, LOGOUT_ROUTE, [LOGOUT_REVOKE_FAILED]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("control: a healthy logout stays silent, clears the session and 303s", async () => {
    const { store, env: e } = isolated();
    const cookie = await liveSession(store);
    const revoke = vi.spyOn(store, "revoke");
    const logs = captureDiagnosticStream();
    const res = await logout(e, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(revoke).toHaveBeenCalledOnce();
    expect(
      res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`)).length,
    ).toBeGreaterThan(0);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGOUT_ROUTE);
  });

  it("malformed bearer with a down store: silent 303 that still clears, zero store calls", async () => {
    const { store, env: e } = isolated();
    const revoke = vi
      .spyOn(store, "revoke")
      .mockRejectedValue(new Error(`store down ${TOK} ${SECRET}`));
    const logs = captureDiagnosticStream();
    const res = await logout(e, await signedSessionCookie("two_abc"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(revoke).not.toHaveBeenCalled();
    expect(
      res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`)).length,
    ).toBeGreaterThan(0);
    expect(v6ChannelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, LOGOUT_ROUTE);
  });
});
