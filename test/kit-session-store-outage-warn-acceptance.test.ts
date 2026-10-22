// route-inventory: GET /auth/status
//
// ACCEPTANCE-OWNED (E4 Kit session-store outage warns): the Builder builds on
// this branch and never edits this file. Fail-first contract for the four
// silent session-store legs:
//
//   - GET /auth/status with a failing store (isActive/get/storeFor throw)
//     warns AUTH_STATUS_STORE_DOWN once (exception class + validated
//     request_id); the 503 {authenticated:false} body is unchanged.
//   - resolveRequestSession with a throwing store.get warns KIT_SESSION_DOWN
//     once (exception class only, no Hono context); UNKNOWN is unchanged.
//   - kitSessionBridge with a throwing store acquisition warns KIT_BRIDGE_DOWN
//     once (exception class only); UNKNOWN with the journey kept is unchanged.
//     A throwing store.get warns via the inner resolve line once, never twice.
//   - kitEventsSessionFor with a throwing store acquisition warns
//     KIT_EVENTS_DOWN once (exception class only); null is unchanged. A
//     throwing store.get warns via the inner resolve line once, never twice.
//
// Boundaries: success paths, expected-null reads (unknown token, missing or
// tampered cookie, expired/revoked row) and no-secret UNKNOWN stay silent.
// Every new field is class-only — never a message, token, cookie, Discord ID
// or secret. At most one line per leg per request (no warn storms).
//
// Hermetic only: memory session store, serializeSigned-minted cookies. No
// DATABASE_URL, no live Discord.
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
  type Sql,
} from "../src/sessions";
import { kitEventsSessionFor, kitSessionBridge, resolveRequestSession } from "../src/kit-session";
import type { HookEventLike } from "../src/route-ownership";
import { LOGIN_NEXT_COOKIE } from "../src/return-journey";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  scanDiagnosticStream,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";

const TOK = "***synthetic-kit-access-9q2m***";
const SECRET_MARK = "***synthetic-kit-secret-8w1p***";

const AUTH_STATUS_STORE_DOWN = "auth status store unavailable";
const KIT_SESSION_DOWN = "kit session store unavailable";
const KIT_BRIDGE_DOWN = "kit session bridge store unavailable";
const KIT_EVENTS_DOWN = "kit events session store unavailable";

const AUTH_STATUS_ROUTE = "/auth/status";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

/** An admitting budget store: GET /auth/status passes the shared read guard (which warns when no store is bound) so only the session-store legs under test write a line. */
const admittingThrottleSql = Object.assign(
  async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("SELECT count(*)")) return [{ n: 0, wait: 0 }];
    return [];
  },
  {
    begin: (run: (tx: Sql) => Promise<unknown>) => run(admittingThrottleSql as unknown as Sql),
    unsafe: async () => [],
  },
) as unknown as Sql;

const baseEnv = {
  THROTTLE_STORE: async () => admittingThrottleSql,
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
} as Env;

const isolated = () => {
  const store = createMemorySessionStore();
  return { store, env: { ...baseEnv, SESSION_STORE: store } as Env };
};

/** Every console channel and every field: the full stream a request can write. */
const streamClean = (logs: DiagnosticRecord[], request: string, messages: string[] = []) =>
  expectDiagnosticStreamClean(logs, [TOK, SECRET_MARK], { request, messages });

/** The records written under one message, marker-free so a failing diff cannot print a leak. */
const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, SECRET_MARK]) as unknown[],
    }));

/** Nothing a member, an operator or a log tail can read may carry a synthetic secret. */
const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text.includes(TOK), "synthetic token on a readable surface").toBe(false);
  expect(text.includes(SECRET_MARK), "synthetic secret on a readable surface").toBe(false);
};

/** Pure-function legs write no http.request line: scan the stream directly for leaks. */
const scanClean = (logs: DiagnosticRecord[]) => {
  const scan = scanDiagnosticStream(logs, [TOK, SECRET_MARK]);
  expect(scan.incomplete, "every diagnostic value inspected to the end").toEqual([]);
  expect(scan.hits, "marker found in diagnostic stream (labels only)").toEqual([]);
};

class AuthStatusStoreOutage extends Error {}
class KitSessionStoreOutage extends Error {}
class KitBridgeAcquisitionFailed extends Error {}
class KitEventsAcquisitionFailed extends Error {}

const outageOf = (ErrorClass: new (message: string, options?: { cause?: unknown }) => Error) =>
  new ErrorClass(`store down ${TOK}`, { cause: new Error(`nested ${SECRET_MARK}`) });

/** Env whose session-store acquisition rejects: exercises the null-store paths. */
function throwingStoreEnv(
  ErrorClass: new (message: string, options?: { cause?: unknown }) => Error,
): Env {
  const e = { ...baseEnv } as Env;
  Object.defineProperty(e, "SESSION_STORE", {
    enumerable: true,
    configurable: true,
    get(): SessionStore {
      throw outageOf(ErrorClass);
    },
  });
  return e;
}

const signedCookie = async (name: string, value: string, secret: string = SESSION_SECRET) =>
  (
    await serializeSigned(name, value, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;

/** A live memory-store session plus its signed cookie, without the QA seam. */
async function liveSession(store: SessionStore) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId: "100000000000000102",
    username: "w15-member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { token, tokenHash, cookie: await signedCookie(SESSION_COOKIE, token) };
}

const requestWith = (pairs: string[], method = "GET", path = "/events/past") =>
  new Request(`https://next.example.test${path}`, {
    method,
    headers: pairs.length ? { cookie: pairs.join("; ") } : {},
  });

const bridgeEnvFor = (store: SessionStore, sessionSecret: string = SESSION_SECRET) =>
  ({ SESSION_SECRET: sessionSecret, SESSION_STORE: store }) as unknown as Env;

const bridgeEventFor = (pairs: string[] = [], method = "GET"): HookEventLike => {
  const request = new Request("https://next.example.test/events/past", {
    method,
    headers: pairs.length ? { cookie: pairs.join("; ") } : {},
  });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /auth/status warns once on store failure; the 503 is unchanged", () => {
  it("isActive throw warns once, class-only plus request_id; 503 {authenticated:false}", async () => {
    const { store, env: e } = isolated();
    const live = await liveSession(store);
    const key = (await store.statusHash(live.tokenHash))!;
    const cookie = await signedCookie(AUTH_STATUS_COOKIE, key);
    const isActive = vi.spyOn(store, "isActive").mockRejectedValue(outageOf(AuthStatusStoreOutage));
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/status", { headers: { cookie } }, e);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ authenticated: false });
    expect(isActive).toHaveBeenCalledOnce();
    const line = recordsFor(logs, AUTH_STATUS_STORE_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      AUTH_STATUS_STORE_DOWN,
      { exception: "AuthStatusStoreOutage", request_id: res.headers.get("x-request-id") },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE, [AUTH_STATUS_STORE_DOWN]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("session get throw warns once; 503 {authenticated:false}", async () => {
    const { store, env: e } = isolated();
    const live = await liveSession(store);
    const get = vi.spyOn(store, "get").mockRejectedValue(outageOf(AuthStatusStoreOutage));
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/status", { headers: { cookie: live.cookie } }, e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authenticated: false });
    expect(get).toHaveBeenCalledOnce();
    const line = recordsFor(logs, AUTH_STATUS_STORE_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      AUTH_STATUS_STORE_DOWN,
      { exception: "AuthStatusStoreOutage", request_id: res.headers.get("x-request-id") },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE, [AUTH_STATUS_STORE_DOWN]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("store acquisition throw warns once; 503 {authenticated:false}", async () => {
    const e = throwingStoreEnv(AuthStatusStoreOutage);
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/status", { headers: { cookie: live.cookie } }, e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authenticated: false });
    const line = recordsFor(logs, AUTH_STATUS_STORE_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      AUTH_STATUS_STORE_DOWN,
      { exception: "AuthStatusStoreOutage", request_id: res.headers.get("x-request-id") },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE, [AUTH_STATUS_STORE_DOWN]);
    leakFree(line, [...res.headers], res.headers.getSetCookie());
  });

  it("probe hit stays silent with {authenticated:true}", async () => {
    const { store, env: e } = isolated();
    const live = await liveSession(store);
    const key = (await store.statusHash(live.tokenHash))!;
    const logs = captureDiagnosticStream();
    const res = await app.request(
      "/auth/status",
      { headers: { cookie: await signedCookie(AUTH_STATUS_COOKIE, key) } },
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE);
  });

  it("unknown session token stays silent with {authenticated:false}", async () => {
    const { env: e } = isolated();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      "/auth/status",
      { headers: { cookie: await signedCookie(SESSION_COOKIE, newSessionToken()) } },
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE);
  });

  it("missing cookies stay silent with {authenticated:false}", async () => {
    const { env: e } = isolated();
    const logs = captureDiagnosticStream();
    const res = await app.request("/auth/status", {}, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    streamClean(logs, AUTH_STATUS_ROUTE);
  });
});

describe("resolveRequestSession warns once on store failure; UNKNOWN is unchanged", () => {
  it("store.get throw warns once, class-only; UNKNOWN with null session", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const get = vi.spyOn(store, "get").mockRejectedValue(outageOf(KitSessionStoreOutage));
    const logs = captureDiagnosticStream();
    const decision = await resolveRequestSession(requestWith([live.cookie]), {
      sessionSecret: SESSION_SECRET,
      store,
    });
    expect(decision).toEqual({ status: "unknown", session: null });
    expect(get).toHaveBeenCalledOnce();
    const line = recordsFor(logs, KIT_SESSION_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([KIT_SESSION_DOWN, { exception: "KitSessionStoreOutage" }]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    scanClean(logs);
    leakFree(line, decision);
  });

  it("control: an authenticated read stays silent", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const decision = await resolveRequestSession(requestWith([live.cookie]), {
      sessionSecret: SESSION_SECRET,
      store,
    });
    expect(decision.status).toBe("authenticated");
    expect(decision.session?.userId).toBe("100000000000000102");
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("unknown token (expected null row) stays silent as guest", async () => {
    const store = createMemorySessionStore();
    const logs = captureDiagnosticStream();
    const decision = await resolveRequestSession(
      requestWith([await signedCookie(SESSION_COOKIE, newSessionToken())]),
      { sessionSecret: SESSION_SECRET, store },
    );
    expect(decision).toEqual({ status: "guest", session: null });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("missing secret (expected UNKNOWN, preview Worker) stays silent", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const decision = await resolveRequestSession(requestWith([live.cookie]), {
      sessionSecret: "",
      store,
    });
    expect(decision).toEqual({ status: "unknown", session: null });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });
});

describe("kitSessionBridge warns once on store failure; UNKNOWN keeps the journey", () => {
  it("store acquisition throw warns once, class-only; UNKNOWN with the journey kept", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const env = throwingStoreEnv(KitBridgeAcquisitionFailed);
    const logs = captureDiagnosticStream();
    const locals = await kitSessionBridge(env)(
      bridgeEventFor([live.cookie, await signedCookie(LOGIN_NEXT_COOKIE, "/events")]),
    );
    expect(locals.status).toBe("unknown");
    expect(locals.session).toBeNull();
    expect(locals.returnTo).toBe("/events");
    const line = recordsFor(logs, KIT_BRIDGE_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([KIT_BRIDGE_DOWN, { exception: "KitBridgeAcquisitionFailed" }]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    scanClean(logs);
    leakFree(line, locals);
  });

  it("store.get throw warns once via the inner resolve line, never twice", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const get = vi.spyOn(store, "get").mockRejectedValue(outageOf(KitSessionStoreOutage));
    const logs = captureDiagnosticStream();
    const locals = await kitSessionBridge(bridgeEnvFor(store))(
      bridgeEventFor([live.cookie, await signedCookie(LOGIN_NEXT_COOKIE, "/events")]),
    );
    expect(locals.status).toBe("unknown");
    expect(locals.session).toBeNull();
    expect(locals.returnTo).toBe("/events");
    expect(get).toHaveBeenCalledOnce();
    expect(recordsFor(logs, KIT_SESSION_DOWN)).toHaveLength(1);
    expect(recordsFor(logs, KIT_BRIDGE_DOWN)).toHaveLength(0);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    scanClean(logs);
    leakFree(
      logs.map((r) => withheld(r.args, [TOK, SECRET_MARK])),
      locals,
    );
  });

  it("control: an authenticated bridge read stays silent", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const locals = await kitSessionBridge(bridgeEnvFor(store))(bridgeEventFor([live.cookie]));
    expect(locals.status).toBe("authenticated");
    expect(locals.session?.userId).toBe("100000000000000102");
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("tampered cookie stays silent as guest with the journey kept", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const tampered = `${live.cookie.slice(0, -1)}${live.cookie.endsWith("A") ? "B" : "A"}`;
    const logs = captureDiagnosticStream();
    const locals = await kitSessionBridge(bridgeEnvFor(store))(
      bridgeEventFor([tampered, await signedCookie(LOGIN_NEXT_COOKIE, "/events")]),
    );
    expect(locals.status).toBe("guest");
    expect(locals.session).toBeNull();
    expect(locals.returnTo).toBe("/events");
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("missing secret stays silent as UNKNOWN with an empty journey", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const locals = await kitSessionBridge(bridgeEnvFor(store, ""))(bridgeEventFor([live.cookie]));
    expect(locals).toEqual({
      status: "unknown",
      session: null,
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });
});

describe("kitEventsSessionFor warns once on store failure; null is unchanged", () => {
  it("store acquisition throw warns once, class-only; null", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const env = throwingStoreEnv(KitEventsAcquisitionFailed);
    const logs = captureDiagnosticStream();
    const session = await kitEventsSessionFor(env)(requestWith([live.cookie]));
    expect(session).toBeNull();
    const line = recordsFor(logs, KIT_EVENTS_DOWN);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([KIT_EVENTS_DOWN, { exception: "KitEventsAcquisitionFailed" }]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    scanClean(logs);
    leakFree(line, session);
  });

  it("store.get throw warns once via the inner resolve line, never twice", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const get = vi.spyOn(store, "get").mockRejectedValue(outageOf(KitSessionStoreOutage));
    const logs = captureDiagnosticStream();
    const session = await kitEventsSessionFor(bridgeEnvFor(store))(requestWith([live.cookie]));
    expect(session).toBeNull();
    expect(get).toHaveBeenCalledOnce();
    expect(recordsFor(logs, KIT_SESSION_DOWN)).toHaveLength(1);
    expect(recordsFor(logs, KIT_EVENTS_DOWN)).toHaveLength(0);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    scanClean(logs);
    leakFree(
      logs.map((r) => withheld(r.args, [TOK, SECRET_MARK])),
      session,
    );
  });

  it("control: an authenticated events read stays silent with member bits", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const session = await kitEventsSessionFor(bridgeEnvFor(store))(requestWith([live.cookie]));
    expect(session).toEqual({ member: true, moderator: false });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("unknown token stays silent as null", async () => {
    const store = createMemorySessionStore();
    const logs = captureDiagnosticStream();
    const session = await kitEventsSessionFor(bridgeEnvFor(store))(
      requestWith([await signedCookie(SESSION_COOKIE, newSessionToken())]),
    );
    expect(session).toBeNull();
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });

  it("missing secret stays silent as null", async () => {
    const store = createMemorySessionStore();
    const live = await liveSession(store);
    const logs = captureDiagnosticStream();
    const session = await kitEventsSessionFor(bridgeEnvFor(store, ""))(requestWith([live.cookie]));
    expect(session).toBeNull();
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
    scanClean(logs);
  });
});
