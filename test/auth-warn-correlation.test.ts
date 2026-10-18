// Acceptance: auth failure warns carry request and guild IDs.
// route-inventory: GET /auth/discord/callback, GET /join/callback
//
// Every failure warn on the two Discord callbacks is an operator's only
// thread back to the request that produced it, so each one carries the
// correlation IDs already in scope at its call site:
//   - "discord sign-in failed" carries request_id
//   - "guild auto-join failed" carries request_id AND guild_id
//   - "discord token exchange failed on the join journey" (all three
//     branches: oversized params, lost/replayed state, exchange failure)
//     carries request_id
// The request_id is the validated correlation ID for the request — the same
// value the response echoes as x-request-id and the join_attempts row stores
// — never raw caller text. Redaction stays class-only: exception class, kind,
// status, source, outcome; never a message, a body, a token or a Discord user
// ID. Exact deep-equals below pin both halves at once.
//
// The synthetic secrets are asterisk-padded on purpose (see
// test/oauth-failure.test.ts): punctuation outside token alphabets keeps them
// from matching any secret scanner while staying unique enough to grep for.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  captureDiagnosticStream,
  expectDiagnosticStreamClean,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";
import { createMemorySessionStore } from "../src/sessions";
import type { EnvWithJoin } from "../src/join/route";
import type { Sql } from "../src/sessions";
import type { Env } from "../src/env";

const TOK = "***synthetic-access-7f3a***";
const SECRET = "***synthetic-secret-4t8z***";
// A syntactically valid cf-ray drives requestId deterministically: the
// middleware adopts it verbatim, so the warn must carry exactly this value.
const RAY = "0123456789abcdef";
const GUILD = "326474832151838730";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const JOIN_LOG = "discord token exchange failed on the join journey";
const LOGIN_LOG = "discord sign-in failed";
const AUTO_JOIN_LOG = "guild auto-join failed";
const JOIN_ROUTE = "/join/callback";
const LOGIN_ROUTE = "/auth/discord/callback";

const streamClean = (logs: DiagnosticRecord[], request: string, messages: string[] = []) =>
  expectDiagnosticStreamClean(logs, [TOK, SECRET], { request, messages });

/** The records a journey writes under one message, marker-free so a failing deep-equal cannot print a leak. */
const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, SECRET]) as unknown[],
    }));

/** The single warn payload under a message; fails unless exactly one was written. */
const onlyPayload = (logs: DiagnosticRecord[], message: string) => {
  const lines = recordsFor(logs, message);
  expect(lines, `exactly one "${message}" warn`).toHaveLength(1);
  expect(lines[0]!.channel).toBe("warn");
  return lines[0]!.args[1] as Record<string, unknown>;
};

/** Stub that answers only via the handler and records every URL it saw. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
}

// In-memory Sql double: understands exactly the queries the join journey emits.
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: Record<string, unknown>[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      return [{ n: throttle.filter((r) => r.bucket === bucket).length, wait: 1 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      attempts.push({
        outcome: values[0],
        source: values[1],
        requestId: values[2],
        discordId: values[3],
      });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), attempts };
}

/** Env with a memory session store + the fake journey store. */
function isolatedJoin(overrides: Partial<Env> = {}) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    ...overrides,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as EnvWithJoin;
  return { fake, env: e as Env };
}

/** Drive /join/discord then its callback under the pinned cf-ray. */
async function joinRoundTrip(e: Env, handler: (url: string) => Response | Promise<Response>) {
  const logs = captureDiagnosticStream();
  const calls = stubFetch(handler);
  const start = await app.request("/join/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await app.request(
    `/join/callback?code=abc&state=${state}`,
    { headers: { cookie: cookiesFrom(start), "cf-ray": RAY } },
    e,
  );
  return { logs, calls, res, html: await res.text() };
}

async function loginRoundTrip(
  e: Env,
  handler: (url: string) => Response | Promise<Response>,
  query = "code=abc",
) {
  const logs = captureDiagnosticStream();
  const calls = stubFetch(handler);
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await app.request(
    `/auth/discord/callback?${query}&state=${state}`,
    { headers: { cookie: cookiesFrom(start), "cf-ray": RAY } },
    e,
  );
  return { logs, calls, res };
}

/** The sign-in stub: token -> user -> PUT member (auto-join) -> GET member (roles). */
function stubSignInDiscord(putStatus = 201, memberStatus = 200) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      calls.push({ url, method });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && method === "PUT")
        return new Response(null, { status: putStatus });
      if (url.includes("/members/42"))
        return memberStatus === 200
          ? Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" })
          : new Response(JSON.stringify({ message: `lookup failed ${TOK}` }), {
              status: memberStatus,
            });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

/** Drive the login start + callback under the pinned cf-ray with the sign-in stub live. */
async function signInCallback(e: Env) {
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return app.request(
    `/auth/discord/callback?code=abc&state=${state}`,
    { headers: { cookie: cookiesFrom(start), "cf-ray": RAY } },
    e,
  );
}

const invalidGrant = (status: number) =>
  new Response(
    JSON.stringify({ error: "invalid_grant", error_description: `refresh ${TOK} revoked` }),
    { status },
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("discord sign-in failed warn carries request_id", () => {
  it("expired grant: payload is class/kind/status plus the validated request_id", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => invalidGrant(400));
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(onlyPayload(logs, LOGIN_LOG)).toEqual({
      request_id: RAY,
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
    });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
  });

  it("transport failure: request_id present, the raw message (carrying the token) never is", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => {
      throw new TypeError(`failed sending ${TOK}`);
    });
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    const payload = onlyPayload(logs, LOGIN_LOG);
    expect(payload).toEqual({
      request_id: RAY,
      exception: "DiscordError",
      kind: "transport_failure",
      status: 0,
    });
    expect(payload).not.toHaveProperty("message");
    expect(JSON.stringify(payload)).not.toContain(TOK);
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
  });

  it("provider outage: request_id present alongside the outage classification", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => invalidGrant(503));
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    expect(onlyPayload(logs, LOGIN_LOG)).toEqual({
      request_id: RAY,
      exception: "DiscordError",
      kind: "provider_outage",
      status: 503,
    });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
  });
});

describe("guild auto-join failed warn carries guild_id", () => {
  it("provider outage on the bot add: request_id, kind and the configured guild_id", async () => {
    const store = createMemorySessionStore();
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(500);
    const res = await signInCallback(e);
    // A failed auto-join never blocks sign-in.
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const payload = onlyPayload(logs, AUTO_JOIN_LOG);
    expect(payload).toEqual({ request_id: RAY, kind: "provider_outage", guild_id: GUILD });
    // The guild is a public routing ID; the member's Discord user ID is not logged.
    expect(JSON.stringify(payload)).not.toContain('"42"');
    streamClean(logs, LOGIN_ROUTE, [AUTO_JOIN_LOG]);
  });

  it("blank bot token (fail-closed, no Discord call): guild_id still names the target guild", async () => {
    const store = createMemorySessionStore();
    const e = { ...env, DISCORD_BOT_TOKEN: "", SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    const calls = stubFetch((url) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      throw new Error("no guild call may be attempted without a bot token");
    });
    const res = await signInCallback(e);
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
    ]);
    expect(onlyPayload(logs, AUTO_JOIN_LOG)).toEqual({
      request_id: RAY,
      kind: "failed",
      guild_id: GUILD,
    });
    streamClean(logs, LOGIN_ROUTE, [AUTO_JOIN_LOG]);
  });
});

describe("join-callback token-exchange warns carry request_id", () => {
  it("exchange failure: warn request_id joins the attempt row and the response header", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, res, html } = await joinRoundTrip(e, () => invalidGrant(400));
    expect(res.status).toBe(200);
    expect(html).toContain("Join approval expired");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(onlyPayload(logs, JOIN_LOG)).toEqual({
      request_id: RAY,
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
      source: null,
      outcome: "expired",
    });
    // The same correlation ID three ways: warn, response header, funnel row.
    expect(fake.attempts).toEqual([
      { outcome: "error", source: null, requestId: RAY, discordId: null },
    ]);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
  });

  it("lost or replayed state: the InvalidState warn carries request_id, no exchange attempted", async () => {
    const { env: e } = isolatedJoin();
    const logs = captureDiagnosticStream();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const res = await app.request(
      "/join/callback?code=abc&state=forged",
      { headers: { "cf-ray": RAY } },
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(onlyPayload(logs, JOIN_LOG)).toEqual({
      request_id: RAY,
      exception: "InvalidState",
      source: null,
      outcome: "expired",
    });
    expect(calls).toHaveLength(0);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
  });

  it("oversized OAuth params: the refusal warn carries request_id before any exchange", async () => {
    const { env: e } = isolatedJoin();
    const logs = captureDiagnosticStream();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const res = await app.request(
      `/join/callback?code=${"a".repeat(8192)}&state=whatever`,
      { headers: { "cf-ray": RAY } },
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(onlyPayload(logs, JOIN_LOG)).toEqual({
      request_id: RAY,
      exception: "InvalidState",
      source: null,
      outcome: "expired",
    });
    expect(calls).toHaveLength(0);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
  });

  it("exchange outage: request_id present, status still governs over an invalid_grant body", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, res, html } = await joinRoundTrip(e, () => invalidGrant(503));
    expect(res.status).toBe(503);
    expect(html).toContain("Discord is unreachable");
    expect(onlyPayload(logs, JOIN_LOG)).toEqual({
      request_id: RAY,
      exception: "DiscordError",
      kind: "provider_outage",
      status: 503,
      source: null,
      outcome: "error",
    });
    expect(fake.attempts).toEqual([
      { outcome: "error", source: null, requestId: RAY, discordId: null },
    ]);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
  });
});

describe("positive controls: correlation already present elsewhere stays exact", () => {
  it("roster upsert failure warn already carries request_id and the class only", async () => {
    const store = createMemorySessionStore();
    const throwingRoster = (async () => {
      throw new Error(`insert failed: ${TOK}`);
    }) as unknown as Sql;
    const e = { ...env, SESSION_STORE: store, ROSTER_STORE: throwingRoster } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(201);
    const res = await signInCallback(e);
    expect(res.headers.get("location")).toBe("/?n=joined"); // roster failure never blocks sign-in
    expect(onlyPayload(logs, "roster upsert failed")).toEqual({
      request_id: RAY,
      exception: "Error",
    });
    streamClean(logs, LOGIN_ROUTE, ["roster upsert failed"]);
  });

  it("moderator recompute lookup warn already carries guild_id and status only", async () => {
    const store = createMemorySessionStore();
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(201, 500);
    const res = await signInCallback(e);
    expect(res.headers.get("location")).toBe("/?n=joined"); // lookup failure fails closed, not out
    expect(onlyPayload(logs, "moderator recompute lookup failed")).toEqual({
      status: 500,
      guild_id: GUILD,
    });
    streamClean(logs, LOGIN_ROUTE, ["moderator recompute lookup failed"]);
  });

  it("a successful sign-in writes neither target warn", async () => {
    const store = createMemorySessionStore();
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(201);
    const res = await signInCallback(e);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(recordsFor(logs, LOGIN_LOG)).toEqual([]);
    expect(recordsFor(logs, AUTO_JOIN_LOG)).toEqual([]);
    streamClean(logs, LOGIN_ROUTE);
  });

  it("a denied consent writes no sign-in warn and keeps the denied redirect", async () => {
    const { env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(
      e,
      () => new Response("{}", { status: 200 }),
      `error=access_denied&error_description=${encodeURIComponent(`member denied with ${TOK}`)}`,
    );
    expect(res.headers.get("location")).toBe("/?n=signin_denied");
    expect(calls).toHaveLength(0);
    expect(recordsFor(logs, LOGIN_LOG)).toEqual([]);
    streamClean(logs, LOGIN_ROUTE);
  });
});
