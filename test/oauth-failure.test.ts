// TOG-10355: OAuth failure classification + redaction acceptance net.
// Failure-path suite for GET /join/callback (no new routes).
// route-inventory: GET /join/callback
//
// Ports the two legacy failure suites onto the Workers stack:
//   - two-web JoinCallbackFailureTest: a 400 + `invalid_grant` body (or a
//     lost/replayed state) is "expired, retry right now" (200 recovery);
//     EVERYTHING else is a 503 — a throttled 429 gets the throttle copy,
//     and the rest (a 503 whose body says invalid_grant, invalid_client,
//     unparseable bodies, transport failures, unknown exceptions) get the
//     outage copy. Status governs; the body can never reclassify.
//   - two-web AccessTokenIsNeverLoggedTest + DiscordLoginTest failure rows:
//     synthetic secrets injected into nested exception message/cause/response
//     objects vanish from every log line, every rendered page, every redirect
//     and every journey row. Logs carry the exception class, the failure kind
//     and the status — never a message, never a body.
//
// The synthetic secrets are asterisk-padded on purpose (legacy suite used
// '***REDACTED***'): punctuation outside token alphabets keeps them from
// matching any secret scanner, and they are still unique enough to grep for.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import {
  DiscordError,
  exchangeCode,
  failureMeta,
  fetchUser,
  isProviderOutage,
} from "../src/discord";
import type { EnvWithJoin } from "../src/join/route";
import type { Sql } from "../src/sessions";
import type { Env } from "../src/env";

const TOK = "***synthetic-access-7f3a***";
const SECRET = "***synthetic-secret-4t8z***";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
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

const JOIN_ROUTE = "/join/callback";
const LOGIN_ROUTE = "/auth/discord/callback";

/** Every console channel and every field: the full stream a failed callback can write. */
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

/** Nothing a member or an operator can read may carry a synthetic secret. */
const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text.includes(TOK), "synthetic token in a member-facing surface").toBe(false);
  expect(text.includes(SECRET), "synthetic secret in a member-facing surface").toBe(false);
};

/** Stub that answers only the given URL and fails the test on anything else. */
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
function isolatedJoin() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as EnvWithJoin;
  return { fake, env: e as Env };
}

/** Drive /join/discord then its callback with the fixture answer. */
async function joinRoundTrip(e: Env, handler: (url: string) => Response | Promise<Response>) {
  const logs = captureDiagnosticStream();
  const calls = stubFetch(handler);
  const start = await app.request("/join/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await app.request(
    `/join/callback?code=abc&state=${state}`,
    {
      headers: { cookie: cookiesFrom(start) },
    },
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
    {
      headers: { cookie: cookiesFrom(start) },
    },
    e,
  );
  return { logs, calls, res };
}

/** The sign-in stub: token → user → PUT member (auto-join) → GET roles. */
function stubSignInDiscord(token = TOK, putStatus = 201) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      calls.push({ url, method });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: token });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && method === "PUT")
        return new Response(null, { status: putStatus });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A 200 body is never asked for a code — only 4xx bodies are parsed.
const invalidGrant = (status: number) =>
  new Response(
    JSON.stringify({ error: "invalid_grant", error_description: `refresh ${TOK} revoked` }),
    { status },
  );

const exchange = () =>
  exchangeCode("code", "client-id", SECRET, "https://next.example.test/auth/discord/callback");

describe("exchange failure classification (legacy JoinCallbackFailureTest contract)", () => {
  it("classifies 400 + invalid_grant as expired_grant and never quotes the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => invalidGrant(400)),
    );
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    const discordError = err as DiscordError;
    expect(discordError.kind).toBe("expired_grant");
    expect(discordError.providerCode).toBe("invalid_grant");
    expect(discordError.status).toBe(400);
    expect(discordError.message).toBe("discord token_exchange failed with HTTP 400");
    leakFree(discordError.message, discordError.providerCode);
  });

  it.each([
    ["401 with an invalid_grant body is provider_reject", invalidGrant(401), "provider_reject"],
    ["403 with an invalid_grant body is provider_reject", invalidGrant(403), "provider_reject"],
    [
      "503 with an invalid_grant body is an outage — status governs",
      invalidGrant(503),
      "provider_outage",
    ],
    [
      "other 400 bodies (invalid_client) are provider_reject",
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }),
      "provider_reject",
    ],
    [
      "unparseable 400 bodies are provider_reject",
      new Response(`<html>err</html>`, { status: 400 }),
      "provider_reject",
    ],
    [
      "non-object JSON 400 bodies are provider_reject",
      new Response('"invalid_grant"', { status: 400 }),
      "provider_reject",
    ],
    [
      "429 is rate_limited whatever the body says",
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 429 }),
      "rate_limited",
    ],
    [
      "a 200 without a token field is provider_reject",
      new Response("{}", { status: 200 }),
      "provider_reject",
    ],
  ] as [string, Response, DiscordError["kind"]][])("%s", async (_name, response, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const err = (await exchange().catch((e: unknown) => e)) as DiscordError;
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(response.status);
    if (response.status >= 500 || response.status === 429) expect(err.providerCode).toBeNull();
    expect(err.message).toBe(`discord token_exchange failed with HTTP ${err.status}`);
    leakFree(err.message, err.providerCode);
  });

  it("wraps transport failures — the raw error message (which can quote a token) is dropped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`failed sending ${TOK}`);
      }),
    );
    const err = (await exchange().catch((e: unknown) => e)) as DiscordError;
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.kind).toBe("transport_failure");
    expect(err.status).toBe(0);
    expect(err.message).toBe("discord token_exchange failed with HTTP 0");
    leakFree(err.message, (err as unknown as { cause?: unknown }).cause);
  });

  it("failureMeta reduces a foreign error to its class name — never its message", () => {
    class SecretLeakError extends Error {}
    const leaky = Object.assign(new SecretLeakError(`outer carries ${TOK}`), {
      cause: Object.assign(new SecretLeakError(`middle carries ${SECRET}`), {
        response: { body: `{"access_token":"${TOK}"}`, headers: { "x-leak": TOK } },
      }),
    });
    expect(failureMeta(leaky)).toEqual({
      exception: "SecretLeakError",
      kind: "unknown",
      status: null,
    });
    leakFree(failureMeta(leaky));
    expect(failureMeta(undefined)).toEqual({ exception: "unknown", kind: "unknown", status: null });
  });

  it("isProviderOutage splits retry-now from come-back-later", () => {
    expect(isProviderOutage("expired_grant")).toBe(false);
    expect(isProviderOutage("provider_reject")).toBe(false);
    expect(isProviderOutage("provider_outage")).toBe(true);
    expect(isProviderOutage("transport_failure")).toBe(true);
    expect(isProviderOutage("rate_limited")).toBe(true);
    // Unknown (a bug of ours, not Discord's) keeps the generic banner — legacy
    // login only reserved "unavailable" for ConnectionException.
    expect(isProviderOutage("unknown")).toBe(false);
  });
});

// Fresh responses per row: both callbacks must contain malformed successful
// user lookups, including stream errors whose message/cause carry credentials.
const malformedUserAnswers: [string, () => Response][] = [
  ["invalid JSON", () => new Response(`not JSON ${TOK} ${SECRET}`, { status: 200 })],
  [
    "body-read failure",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new Error(`read failed ${TOK}`, { cause: new Error(`nested ${SECRET}`) }),
            );
          },
        }),
        { status: 200 },
      ),
  ],
  ["null", () => Response.json(null)],
  ["array", () => Response.json([])],
  ["string", () => Response.json(TOK)],
  ["missing fields", () => Response.json({ diagnostic: SECRET })],
  [
    "invalid id",
    () => Response.json({ id: 42, username: "member", global_name: null, avatar: null }),
  ],
  [
    "empty id",
    () => Response.json({ id: "", username: "member", global_name: null, avatar: null }),
  ],
  [
    "invalid username",
    () =>
      Response.json({ id: "42", username: { diagnostic: TOK }, global_name: null, avatar: null }),
  ],
  [
    "invalid display name",
    () =>
      Response.json({
        id: "42",
        username: "member",
        global_name: { diagnostic: SECRET },
        avatar: null,
      }),
  ],
  [
    "invalid avatar",
    () =>
      Response.json({
        id: "42",
        username: "member",
        global_name: null,
        avatar: { diagnostic: TOK },
      }),
  ],
];

const userLookupAnswer = (answer: () => Response) => (url: string) => {
  if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
  if (url.endsWith("/users/@me")) return answer();
  throw new Error("No guild request is allowed after a malformed user response");
};

const rejectedUserMeta = { exception: "DiscordError", kind: "provider_reject", status: 200 };

describe("malformed HTTP-200 user responses stay inside callback recovery", () => {
  it.each(malformedUserAnswers)(
    "fetchUser rejects %s with bounded facts and no cause",
    async (_name, answer) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer()),
      );
      const err = await fetchUser(TOK).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscordError);
      const discordError = err as DiscordError;
      expect(failureMeta(discordError)).toEqual(rejectedUserMeta);
      expect(discordError.step).toBe("fetch_user");
      expect(discordError.message).toBe("discord fetch_user failed with HTTP 200");
      expect(discordError.providerCode).toBeNull();
      expect(discordError.cause).toBeUndefined();
      leakFree(discordError, discordError.message);
    },
  );

  it.each(malformedUserAnswers)(
    "join contains %s and records exactly one failure",
    async (_name, answer) => {
      const { fake, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinRoundTrip(e, userLookupAnswer(answer));
      expect(res.status).toBe(503);
      expect(html).toContain("Discord is unreachable");
      expect(html).not.toContain("approval expired");
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        "/api/v10/oauth2/token",
        "/api/v10/users/@me",
      ]);
      expect(recordsFor(logs, JOIN_LOG).map((r) => r.args)).toEqual([
        [
          JOIN_LOG,
          {
            ...rejectedUserMeta,
            source: null,
            outcome: "error",
            request_id: res.headers.get("x-request-id"),
          },
        ],
      ]);
      expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 1, error: 0 });
      const requestId = res.headers.get("x-request-id");
      expect(fake.attempts).toEqual([
        { outcome: "error", source: null, requestId, discordId: null },
      ]);
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
      streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it.each(malformedUserAnswers)(
    "login contains %s and redirects without issuing a session",
    async (_name, answer) => {
      const { fake, env: e } = isolatedJoin();
      const { logs, calls, res } = await loginRoundTrip(e, userLookupAnswer(answer));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?n=signin_failed");
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        "/api/v10/oauth2/token",
        "/api/v10/users/@me",
      ]);
      expect(recordsFor(logs, LOGIN_LOG).map((r) => r.args)).toEqual([
        [LOGIN_LOG, { ...rejectedUserMeta, request_id: res.headers.get("x-request-id") }],
      ]);
      expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 1, error: 0 });
      expect(fake.attempts).toEqual([]);
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
      const html = await (await app.request("/?n=signin_failed", {}, e)).text();
      expect(html).toContain("Sign in with Discord");
      streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );
});

describe("join callback: expired recovery versus outage 503", () => {
  it("expired grant: 200 immediate-retry recovery, bounded log, nothing echoed", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, res, html } = await joinRoundTrip(e, () => invalidGrant(400));
    expect(res.status).toBe(200);
    expect(html).toContain("Join approval expired");
    expect(html).toContain("That Discord approval expired. Try again or use the invite below.");
    expect(html).toContain('href="/join/discord"'); // immediate retry
    expect(html).toContain("https://discord.gg/invite"); // invite fallback survives
    expect(html).not.toContain("Discord is unreachable");

    // One bounded correlation line: class + kind + status + source + outcome.
    const exchangeLine = recordsFor(logs, JOIN_LOG);
    expect(exchangeLine).toHaveLength(1);
    expect(exchangeLine[0]!.args[1]).toEqual({
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
      source: null,
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });

    // The funnel row is the legacy enum's error row; its four columns carry no secret.
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html, fake.attempts, res.headers.getSetCookie());
  });

  it.each([
    [401, "provider_reject", "Discord is unreachable"],
    [403, "provider_reject", "Discord is unreachable"],
    [429, "rate_limited", "Discord throttled the approval"],
    [500, "provider_outage", "Discord is unreachable"],
    [503, "provider_outage", "Discord is unreachable"],
  ] as [number, DiscordError["kind"], string][])(
    "HTTP %i with invalid_grant cannot select expired join recovery",
    async (status, kind, title) => {
      const { fake, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinRoundTrip(e, () => invalidGrant(status));
      expect(res.status).toBe(503);
      expect(html).toContain(title);
      expect(html).not.toContain("approval expired");
      // The throttle and outage pages never share copy: a throttled 429
      // names the wait instead of "unreachable", and no other status names
      // a throttle.
      if (status === 429) {
        expect(html).toContain("rate-limiting approvals");
        expect(html).not.toContain("Discord is unreachable");
      } else {
        expect(html).not.toContain("throttled");
      }
      expect(calls).toHaveLength(1); // no user lookup or guild mutation after a rejected exchange
      const exchangeLine = recordsFor(logs, JOIN_LOG);
      expect(exchangeLine).toHaveLength(1);
      expect(exchangeLine[0]!.args[1]).toEqual({
        exception: "DiscordError",
        kind,
        outcome: "error",
        status,
        source: null,
        request_id: res.headers.get("x-request-id"),
      });
      const requestId = res.headers.get("x-request-id");
      expect(fake.attempts).toEqual([
        { outcome: "error", source: null, requestId, discordId: null },
      ]);
      streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it("transport failure with the token inside the raw message: 503, bounded log", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res, html } = await joinRoundTrip(e, () => {
      throw new TypeError(`failed sending ${TOK}`);
    });
    expect(res.status).toBe(503);
    expect(html).toContain("Discord is unreachable");
    const exchangeLine = recordsFor(logs, JOIN_LOG);
    expect(exchangeLine[0]!.args[1]).toMatchObject({
      exception: "DiscordError",
      kind: "transport_failure",
      outcome: "error",
    });
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html);
  });

  it("an exception that escapes the classifier still leaks nothing: class name only", async () => {
    const { env: e } = isolatedJoin();
    // A hostile response object whose `ok` getter throws a secret-bearing,
    // deeply-nested error. failureMeta must reduce it to the class name.
    class SecretLeakError extends Error {}
    const leaky = Object.assign(new SecretLeakError(`outer carries ${TOK}`), {
      cause: Object.assign(new SecretLeakError(`middle carries ${SECRET}`), {
        response: { body: `{"access_token":"${TOK}"}`, headers: { "x-leak": TOK } },
      }),
    });
    const { logs, res, html } = await joinRoundTrip(e, () => {
      const hostile = {} as Response;
      Object.defineProperty(hostile, "ok", {
        get() {
          throw leaky;
        },
      });
      return hostile;
    });
    expect(res.status).toBe(503);
    expect(html).toContain("Discord is unreachable");
    const exchangeLine = recordsFor(logs, JOIN_LOG);
    expect(exchangeLine[0]!.args[1]).toEqual({
      exception: "SecretLeakError",
      kind: "unknown",
      status: null,
      source: null,
      outcome: "error",
      request_id: res.headers.get("x-request-id"),
    });
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html);
  });

  it("lost or replayed state is expired: bounded log, no exchange attempted", async () => {
    const { env: e } = isolatedJoin();
    const logs = captureDiagnosticStream();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const res = await app.request("/join/callback?code=abc&state=forged", {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(recordsFor(logs, JOIN_LOG)[0]!.args[1]).toMatchObject({
      exception: "InvalidState",
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });
    expect(calls).toHaveLength(0);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
  });
});

describe("join callback: post-exchange bot failures stay redacted (degraded recovery)", () => {
  const botRefusalWithMarkers = (url: string) => {
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
    if (url.includes("/members/42"))
      return new Response(JSON.stringify({ message: `forbidden ${TOK} ${SECRET}`, code: 50013 }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    throw new Error("unexpected Discord call");
  };

  const botTransportThrowWithCanaries = (url: string) => {
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
    if (url.includes("/members/42"))
      throw new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
    throw new Error("unexpected Discord call");
  };

  it("bot refusal with a marker-bearing body: 200 recovery, no session, one degraded attempt, clean stream", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinRoundTrip(e, botRefusalWithMarkers);
    expect(res.status).toBe(200);
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("use the invite link below");
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("Try again");
    expect(html).toContain("https://discord.gg/invite");
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(fake.attempts).toEqual([
      { outcome: "degraded", source: null, requestId: null, discordId: "42" },
    ]);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      "/api/v10/guilds/326474832151838730/members/42",
    ]);
    expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, JOIN_ROUTE);
    leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
  });

  it("bot transport throw carrying canaries: 200 recovery, no session, one degraded attempt, clean stream", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinRoundTrip(e, botTransportThrowWithCanaries);
    expect(res.status).toBe(200);
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("use the invite link below");
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("Try again");
    expect(html).toContain("https://discord.gg/invite");
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(fake.attempts).toEqual([
      { outcome: "degraded", source: null, requestId: null, discordId: "42" },
    ]);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      "/api/v10/guilds/326474832151838730/members/42",
    ]);
    expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, JOIN_ROUTE);
    leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
  });

  it("negative control: a planted marker fails the same inspection without printing marker bytes", async () => {
    const { env: e } = isolatedJoin();
    const { logs } = await joinRoundTrip(e, botRefusalWithMarkers);
    console.warn("planted leak", { detail: TOK });
    let failure: unknown;
    try {
      streamClean(logs, JOIN_ROUTE);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("marker found in diagnostic stream");
    expect((failure as Error).message).not.toContain(TOK);
    expect((failure as Error).message).not.toContain(SECRET);
  });
});

describe("join callback: post-bot-success downstream failures stay redacted", () => {
  const MODERATOR_LOOKUP_LOG = "moderator recompute lookup failed";
  const MEMBER_PATH = "/api/v10/guilds/326474832151838730/members/42";

  type RecordedCall = { url: string; method: string };

  /** Successful exchange + user + bot add; the moderator GET answer is injected. */
  function stubPostBotDiscord(moderatorAnswer: () => Response | Promise<Response>) {
    const calls: RecordedCall[] = [];
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
          return new Response(null, { status: 201 });
        if (url.includes("/members/42")) return moderatorAnswer();
        throw new Error(`unexpected Discord call ${method} ${url}`);
      }),
    );
    return calls;
  }

  /** Capture the session row issueSession writes, to prove the moderator flag. */
  function captureIssuedSessions(e: Env) {
    const store = (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE;
    const created: { moderator: boolean; userId: string; member: boolean }[] = [];
    const origCreate = store.create.bind(store);
    const origReplace = store.replace.bind(store);
    store.create = async (s) => {
      created.push({
        moderator: (s as { moderator: boolean }).moderator,
        userId: (s as { userId: string }).userId,
        member: (s as { member: boolean }).member,
      });
      return origCreate(s);
    };
    store.replace = async (oldHash, s) => {
      created.push({
        moderator: (s as { moderator: boolean }).moderator,
        userId: (s as { userId: string }).userId,
        member: (s as { member: boolean }).member,
      });
      return origReplace(oldHash, s);
    };
    return created;
  }

  async function postBotRoundTrip(e: Env, moderatorAnswer: () => Response | Promise<Response>) {
    const logs = captureDiagnosticStream();
    const calls = stubPostBotDiscord(moderatorAnswer);
    const start = await app.request("/join/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    return { logs, calls, res };
  }

  it("moderator transport throw after a successful bot add: 302, non-moderator session, clean stream", async () => {
    const { fake, env: e } = isolatedJoin();
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(e, () => {
      throw new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(calls[2]!.method).toBe("PUT");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-two_session=[^;]/);
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).toContain("Rick");
    expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, JOIN_ROUTE);
    leakFree(
      await res.text(),
      res.headers.get("location"),
      [...res.headers],
      setCookie,
      fake.attempts,
      created,
    );
  });

  it("moderator 500 with a marker body after a successful bot add: 302, status-only log, clean stream", async () => {
    const { fake, env: e } = isolatedJoin();
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(e, () =>
      Response.json(
        { roles: ["1546777856984481792"], diagnostic: `boom ${TOK} ${SECRET}` },
        { status: 500 },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(recordsFor(logs, MODERATOR_LOOKUP_LOG).map((r) => r.args)).toEqual([
      [MODERATOR_LOOKUP_LOG, { status: 500, guild_id: "326474832151838730" }],
    ]);
    expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-two_session=[^;]/);
    streamClean(logs, JOIN_ROUTE, [MODERATOR_LOOKUP_LOG]);
    leakFree(
      await res.text(),
      res.headers.get("location"),
      [...res.headers],
      setCookie,
      fake.attempts,
      created,
    );
  });

  it("session-create throw after a successful bot add: 500, no usable session, clean stream", async () => {
    __resetAlertRateLimitForTests();
    const { fake, env: e } = isolatedJoin();
    const store = (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE;
    const nested = new Error(`nested ${SECRET}`, {
      cause: new Map([["detail", TOK]]),
    });
    const failure = new Error(`insert failed ${TOK}`, { cause: nested });
    store.create = async () => {
      throw failure;
    };
    store.replace = async () => {
      throw failure;
    };
    const logs = captureDiagnosticStream();
    const calls = stubPostBotDiscord(() =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    const start = await app.request("/join/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    const html = await res.text();
    expect(res.status).toBe(500);
    expect(html).toContain("Something broke on our side");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).not.toContain("__Host-two_session=");
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).not.toContain("Rick");
    expect(channelCounts(logs)).toMatchObject({ info: 0, debug: 0, warn: 0, error: 1 });
    streamClean(logs, JOIN_ROUTE);
    const alertArgs = withheld(logs.find((r) => r.channel === "error")!.args, [
      TOK,
      SECRET,
    ]) as unknown[];
    expect(alertArgs).toHaveLength(1);
    expect(JSON.parse(alertArgs[0] as string)).toMatchObject({
      level: "critical",
      event: "error.alert",
      fingerprint: `Error@${JOIN_ROUTE}`,
      exception: "Error",
      method: "GET",
      route: JOIN_ROUTE,
    });
    leakFree(html, [...res.headers], setCookie, fake.attempts);
  });

  it("negative control: a planted post-bot-success marker fails the same inspection without printing marker bytes", async () => {
    const { env: e } = isolatedJoin();
    const { logs } = await postBotRoundTrip(e, () =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    console.warn("planted leak", new Error("outer", { cause: new Error(`inner ${TOK}`) }));
    let failure: unknown;
    try {
      streamClean(logs, JOIN_ROUTE);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("marker found in diagnostic stream");
    expect((failure as Error).message).not.toContain(TOK);
    expect((failure as Error).message).not.toContain(SECRET);
  });
});

describe("ordinary login: denial, outage, generic (legacy DiscordLoginTest failure rows)", () => {
  it("renders the denied banner for access_denied and never echoes the description", async () => {
    const { env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(
      e,
      () => new Response("{}", { status: 200 }),
      `error=access_denied&error_description=${encodeURIComponent(`member denied with ${TOK}`)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_denied");
    const home = await app.request("/?n=signin_denied", {}, e);
    const html = await home.text();
    expect(html).toContain("You cancelled the Discord sign-in");
    expect(html).not.toContain("did not answer");
    expect(calls).toHaveLength(0); // no exchange is attempted for a consent refusal
    streamClean(logs, LOGIN_ROUTE);
    leakFree(html, res.headers.get("location"));
  });

  it("renders the generic banner for any other OAuth error", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(
      e,
      () => new Response("{}", { status: 200 }),
      `error=server_error&error_description=${encodeURIComponent(`upstream says ${SECRET}`)}`,
    );
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    streamClean(logs, LOGIN_ROUTE);
    leakFree(res.headers.get("location"));
  });

  it("expired grant on login: generic banner, bounded log", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => invalidGrant(400));
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    const signLine = recordsFor(logs, LOGIN_LOG);
    expect(signLine).toHaveLength(1);
    expect(signLine[0]!.args[1]).toEqual({
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
      request_id: res.headers.get("x-request-id"),
    });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(res.headers.get("location"));
  });

  it("outage on login: the unavailable banner says it is on Discord, not you", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => invalidGrant(503));
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    const home = await app.request("/?n=signin_unavailable", {}, e);
    const html = await home.text();
    expect(html).toContain("Discord did not answer just now");
    expect(html).toContain("This is on Discord, not you");
    expect(recordsFor(logs, LOGIN_LOG)).toHaveLength(1);
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(html);
  });

  it("transport failure on login: unavailable banner, token dropped from the log", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => {
      throw new TypeError(`failed sending ${TOK}`);
    });
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(res.headers.get("location"));
  });
});

describe("adjacent auth log paths stay bounded", () => {
  it("roster upsert failure: sign-in completes, the log carries the class only", async () => {
    const store = createMemorySessionStore();
    const throwingRoster = (async () => {
      throw new Error(`insert failed: ${TOK}`);
    }) as unknown as Sql;
    const e = { ...env, SESSION_STORE: store, ROSTER_STORE: throwingRoster } as Env;
    const logs = captureDiagnosticStream();
    const calls = stubSignInDiscord(TOK, 201);
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie: cookiesFrom(start) },
      },
      e,
    );
    expect(res.headers.get("location")).toBe("/?n=joined"); // roster failure never blocks sign-in
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/members/42"))).toBe(true);
    const rosterLine = recordsFor(logs, "roster upsert failed");
    expect(rosterLine).toHaveLength(1);
    expect(rosterLine[0]!.args[1]).toEqual({
      request_id: res.headers.get("x-request-id"),
      exception: "Error",
    });
    streamClean(logs, LOGIN_ROUTE, ["roster upsert failed"]);
    leakFree(res.headers.getSetCookie());
  });

  it("prior session sweep failure: sign-in completes, the log carries request_id and no Discord ID", async () => {
    const store = createMemorySessionStore();
    (store as unknown as { revokeUserSessions: () => Promise<never> }).revokeUserSessions =
      async () => {
        throw new Error(`sweep failed ${TOK}`);
      };
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord();
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    const sweepLine = recordsFor(logs, "prior session sweep failed");
    expect(sweepLine).toHaveLength(1);
    expect(sweepLine[0]!.args[1]).toEqual({
      request_id: res.headers.get("x-request-id"),
      exception: "Error",
    });
    streamClean(logs, LOGIN_ROUTE, ["prior session sweep failed"]);
    leakFree(res.headers.getSetCookie());
  });

  it("guild auto-join failure: sign-in completes and the log carries request_id, never the Discord ID", async () => {
    const store = createMemorySessionStore();
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(TOK, 500);
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    const joinLine = recordsFor(logs, "guild auto-join failed");
    expect(joinLine).toHaveLength(1);
    expect(joinLine[0]!.args[1]).toEqual({
      request_id: res.headers.get("x-request-id"),
      guild_id: env.DISCORD_GUILD_ID,
      kind: "provider_outage",
    });
    streamClean(logs, LOGIN_ROUTE, ["guild auto-join failed"]);
    leakFree(res.headers.getSetCookie(), res.headers.get("location"));
  });

  it("profiles session gate: a store failure answers 503 and logs the class only", async () => {
    // A real session first (so the cookie is genuinely signed), then a store
    // whose get() throws with the DSN in the message.
    const good = createMemorySessionStore();
    const signedIn = { ...env, SESSION_STORE: good } as Env;
    stubSignInDiscord();
    const start = await app.request("/auth/discord", {}, signedIn);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const login = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie: cookiesFrom(start) },
      },
      signedIn,
    );
    const cookie = cookiesFrom(login);
    expect(cookie).toContain("__Host-two_session=");

    const throwing = createMemorySessionStore();
    (throwing as unknown as { get: () => Promise<never> }).get = async () => {
      throw new Error(`connect ECONNREFUSED postgres://bot:${SECRET}@db.internal:5432/two`);
    };
    const logs = captureDiagnosticStream();
    const res = await app.request("/profile", { headers: { cookie } }, {
      ...env,
      SESSION_STORE: throwing,
    } as Env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.text();
    expect(body).toContain('<a class="brand" href="/"');
    expect(body).not.toMatch(/ECONNREFUSED|postgres:\/\/|db\.internal/);
    expect(body).not.toContain(SECRET);
    const gateLine = recordsFor(logs, "profiles could not resolve the session; refusing.");
    expect(gateLine).toHaveLength(1);
    expect(gateLine[0]!.args[1]).toEqual({ exception: "Error" });
    streamClean(logs, "/profile", ["profiles could not resolve the session; refusing."]);
  });
});
