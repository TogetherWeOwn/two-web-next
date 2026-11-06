import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore } from "../src/sessions";

// Native Hono request characterization, not built-Worker or cross-renderer parity.
// Existing auth suites own outcome/redirect matrices and broad oversized probes;
// these cases add exact cap edges, an independent cookie oracle and dispatch variants.
const NOW = Date.UTC(2026, 9, 1);
const STATE = "00000000-0000-4000-8000-000000000001";
const STATE_COOKIE = "__Host-two_oauth_state";
const SESSION_COOKIE = "__Host-two_session";
const STATUS_COOKIE = "__Host-two_session_status";
const TTL_MS = 7_200_000;
const ACCEPTS = ["text/html", "application/json", "*/*"];
const KEYS = [
  "fixture-auth-signing-key-at-least-32-bytes",
  "second-fixture-auth-key-at-least-32-bytes",
];
const baseEnv: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-client-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: KEYS[0]!,
  QA_AUTH_TOKEN: "fixture-qa-token-at-least-32-bytes-long",
};

// Do not use the Hono/Kit serializer to build its own expected bytes. The shipped
// wire is URI-encoded value + '.' + padded standard-base64 HMAC-SHA256(value).
const signedPair = (name: string, value: string, key = baseEnv.SESSION_SECRET) =>
  `${name}=${encodeURIComponent(`${value}.${createHmac("sha256", key).update(value).digest("base64")}`)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieFlags = "; Path=/; HttpOnly; Secure; SameSite=Lax";
const jar = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function fixture(secret = baseEnv.SESSION_SECRET) {
  let now = NOW;
  const store = createMemorySessionStore(() => now);
  const create = vi.spyOn(store, "create");
  const consume = vi.spyOn(store.journeys, "consume");
  const issue = vi.spyOn(store.journeys, "issue");
  const revoke = vi.spyOn(store, "revoke");
  const revokeUserSessions = vi.spyOn(store, "revokeUserSessions");
  const selectThrottle = vi.fn(async () => null);
  const selectStore = vi.fn(() => store);
  const bindings = Object.defineProperty(
    {
      ...baseEnv,
      SESSION_SECRET: secret,
      THROTTLE_STORE: selectThrottle,
      ADMIN_DB: {
        transaction: async () => {
          throw new Error("fixture has no suggestions");
        },
      },
    },
    "SESSION_STORE",
    { get: selectStore },
  ) as Env;
  const request = (path: string, method = "GET", accept = "*/*", cookie = "") =>
    app.request(
      path,
      {
        method,
        headers: {
          accept,
          cookie,
          origin: STAGING_APP_URL,
          [QA_HEADER]: baseEnv.QA_AUTH_TOKEN!,
          "cf-ray": "0123456789abcdef-LHR",
        },
      },
      bindings,
    );
  return {
    store,
    create,
    consume,
    issue,
    revoke,
    revokeUserSessions,
    selectThrottle,
    selectStore,
    request,
    bindings,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(STATE);
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    return array;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected fixture network call");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hono auth callback cap edges", () => {
  const rows = ["code", "state"].flatMap((field) =>
    [2048, 2049].flatMap((length) => ACCEPTS.map((accept) => ({ field, length, accept }))),
  );

  it.each(rows)("$field length $length with Accept $accept", async ({ field, length, accept }) => {
    const f = fixture();
    const state = field === "state" ? "s".repeat(length) : STATE;
    const code = field === "code" ? "c".repeat(length) : "fixture-code";
    await f.store.journeys.issue(hash(state), "auth");
    const provider = vi
      .mocked(fetch)
      .mockResolvedValue(new Response("fixture rejected code", { status: 401 }));
    const res = await f.request(
      `/auth/discord/callback?${new URLSearchParams({ code, state })}`,
      "GET",
      accept,
      signedPair(STATE_COOKIE, state),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(f.create).not.toHaveBeenCalled();
    if (length === 2049) {
      expect(f.selectThrottle).not.toHaveBeenCalled();
      expect(f.selectStore).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie()).toEqual([]);
      // A rejected over-cap hit must not consume the still-pending journey.
      expect(await f.store.journeys.consume(hash(state), "auth")).toBe(true);
    } else {
      expect(f.selectThrottle).toHaveBeenCalledTimes(1);
      expect(f.consume).toHaveBeenCalledExactlyOnceWith(hash(state), "auth");
      expect(provider).toHaveBeenCalledTimes(1);
      const [url, init] = provider.mock.calls[0]!;
      expect(url).toBe("https://discord.com/api/v10/oauth2/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("code")).toBe(code);
      expect(body.get("redirect_uri")).toBe(`${STAGING_APP_URL}/auth/discord/callback`);
      expect(res.headers.getSetCookie()).toContain(`${STATE_COOKIE}=; Max-Age=0${cookieFlags}`);
      expect(await f.store.journeys.consume(hash(state), "auth")).toBe(false);
    }
  });
});

describe("Hono auth signed-cookie HTTP wire", () => {
  it.each(KEYS)("emits independently verifiable OAuth and QA cookies with key %s", async (key) => {
    const f = fixture(key);
    const start = await f.request("/auth/discord");
    expect(start.status).toBe(302);
    expect(start.headers.getSetCookie()).toContain(
      `${signedPair(STATE_COOKIE, STATE, key)}; Max-Age=600${cookieFlags}`,
    );
    expect(f.issue).toHaveBeenCalledExactlyOnceWith(hash(STATE), "auth");
    const target = new URL(start.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(target.searchParams.get("state")).toBe(STATE);

    const login = await f.request("/auth/qa/qa-member", "POST");
    expect(login.status).toBe(204);
    expect(await login.text()).toBe("");
    const bearerCookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const bearer = decodeURIComponent(
      bearerCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1),
    ).split(".")[0]!;
    expect(bearer).toMatch(/^two_[A-Za-z0-9_-]{43}$/);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![0].tokenHash).toBe(hash(bearer));
    expect(login.headers.getSetCookie().sort()).toEqual(
      [
        `${signedPair(SESSION_COOKIE, bearer, key)}; Max-Age=7200${cookieFlags}`,
        `${signedPair(STATUS_COOKIE, hash(bearer), key)}; Max-Age=7200${cookieFlags}`,
      ].sort(),
    );
    // Probe reads must not extend the QA-issued initial 120-minute window.
    f.advance(TTL_MS - 1);
    const live = await f.request("/auth/status", "GET", "application/json", jar(login));
    expect(await live.json()).toEqual({ authenticated: true });
    expect(live.headers.getSetCookie()).toEqual([]);
    f.advance(1);
    const expired = await f.request("/auth/status", "GET", "application/json", jar(login));
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ authenticated: false });
    expect(expired.headers.getSetCookie()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([SESSION_COOKIE, STATUS_COOKIE])(
    "reads independent %s signatures without renewing, through exact expiry and logout",
    async (name) => {
      const f = fixture();
      const bearer = `two_${"a".repeat(43)}`;
      await f.store.create({
        tokenHash: hash(bearer),
        userId: "fixture-user",
        username: "Fixture",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(NOW + TTL_MS),
      });
      const value = name === SESSION_COOKIE ? bearer : hash(bearer);
      const cookie = signedPair(name, value);
      const rotate = vi.spyOn(f.store, "rotate");
      const renew = vi.spyOn(f.store, "renew");
      const probe = async (authenticated: boolean) => {
        const res = await f.request("/auth/status", "GET", "text/html", cookie);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.headers.get("cache-control")).toBe("no-store, private");
        expect(res.headers.get("vary")).toBe("Cookie");
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await res.json()).toEqual({ authenticated });
      };
      f.advance(TTL_MS - 1);
      await probe(true);
      f.advance(1);
      await probe(false);
      expect(rotate).not.toHaveBeenCalled();
      expect(renew).not.toHaveBeenCalled();
      // An expired but correctly signed bearer still gets the idempotent logout,
      // including exact clearing flags; never mint a replacement on this path.
      const logout = await f.request(
        "/logout",
        "POST",
        "application/json",
        `${signedPair(SESSION_COOKIE, bearer)}; ${signedPair(STATUS_COOKIE, hash(bearer))}`,
      );
      expect(logout.status).toBe(303);
      expect(logout.headers.get("location")).toBe("/");
      expect(await logout.text()).toBe("");
      expect(f.revoke).toHaveBeenCalledExactlyOnceWith(hash(bearer));
      expect(logout.headers.getSetCookie()).toEqual(
        expect.arrayContaining([
          `${SESSION_COOKIE}=; Max-Age=0${cookieFlags}`,
          `${STATUS_COOKIE}=; Max-Age=0${cookieFlags}`,
        ]),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

const reads = [
  { path: "/auth/discord", status: 302 },
  { path: "/auth/discord/callback", status: 302 },
  { path: "/auth/discord/redirect", status: 302 },
  { path: "/auth/status", status: 200 },
  { path: "/auth/recover", status: 200 },
];
const routes = [
  ...reads.map((r) => ({ ...r, method: "GET" })),
  { path: "/logout", method: "POST", status: 303 },
  { path: "/logout/everywhere", method: "POST", status: 303 },
  { path: "/auth/qa/qa-member", method: "POST", status: 204 },
];

describe("Hono auth method, slash and Accept dispatch", () => {
  it.each(routes.flatMap((r) => ACCEPTS.map((accept) => ({ ...r, accept }))))(
    "$method $path with Accept $accept keeps dispatch exact",
    async ({ path, method, status, accept }) => {
      const f = fixture();
      const baseline = await f.request("/fixture-auth-unknown", "GET", accept);
      expect(baseline.status).toBe(404);
      const missing = await baseline.text();
      // QA wrong methods already have their own complete matrix. Add its slash
      // refusal only; for the other routes exercise every unregistered verb.
      const wrong = path.startsWith("/auth/qa/")
        ? []
        : ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter(
            (m) => m !== method && !(method === "GET" && m === "HEAD"),
          );
      for (const [probePath, probeMethod] of [
        ...wrong.map((m) => [path, m]),
        [path + "/", method],
      ]) {
        const res = await f.request(probePath!, probeMethod, accept);
        expect(res.status, `${probeMethod} ${probePath}`).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toBe(baseline.headers.get("content-type"));
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await res.text()).toBe(probeMethod === "HEAD" ? "" : missing);
      }
      expect(f.selectThrottle).not.toHaveBeenCalled();
      expect(f.selectStore).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.revoke).not.toHaveBeenCalled();
      expect(f.revokeUserSessions).not.toHaveBeenCalled();
      // Positive control prevents a miss-only matrix from passing if the real
      // route were removed. Accept must not change its successful media type.
      const canonical = await f.request(path, method, accept);
      expect(canonical.status).toBe(status);
      if (path === "/auth/status") {
        expect(await canonical.json()).toEqual({ authenticated: false });
      } else if (path === "/auth/recover") {
        expect(await canonical.text()).toContain("Your session expired");
      } else if (path === "/auth/discord/redirect") {
        expect(canonical.headers.get("location")).toBe("/auth/discord");
      } else if (path === "/auth/discord/callback") {
        expect(canonical.headers.get("location")).toBe("/?n=signin_failed");
        expect(f.selectThrottle).toHaveBeenCalledTimes(1);
      } else if (path === "/auth/discord") {
        expect(f.issue).toHaveBeenCalledTimes(1);
        expect(canonical.headers.get("location")).toContain(
          "https://discord.com/oauth2/authorize?",
        );
      } else if (path.startsWith("/logout")) {
        expect(canonical.headers.get("location")).toBe("/");
        expect(canonical.headers.getSetCookie()).toContain(
          `${SESSION_COOKIE}=; Max-Age=0${cookieFlags}`,
        );
      } else {
        expect(f.create).toHaveBeenCalledTimes(1);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(reads.flatMap((r) => ACCEPTS.map((accept) => ({ ...r, accept }))))(
    "HEAD $path retains GET headers/effects with Accept $accept but no body",
    async ({ path, status, accept }) => {
      const getFixture = fixture();
      const headFixture = fixture();
      const get = await getFixture.request(path, "GET", accept);
      const head = await headFixture.request(path, "HEAD", accept);
      expect(get.status).toBe(status);
      expect(head.status).toBe(status);
      expect([...head.headers]).toEqual([...get.headers]);
      expect(await head.text()).toBe("");
      expect(jar(head)).toBe(jar(get));
      expect(headFixture.selectThrottle.mock.calls.length).toBe(
        getFixture.selectThrottle.mock.calls.length,
      );
      expect(headFixture.issue.mock.calls).toEqual(getFixture.issue.mock.calls);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
