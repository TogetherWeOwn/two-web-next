// TOG-10355: OAuth failure classification + redaction acceptance net.
// Failure-path suite for GET /join/callback (no new routes).
// route-inventory: GET /join/callback
//
// Ports the two legacy failure suites onto the Workers stack:
//   - two-web JoinCallbackFailureTest: a 400 + `invalid_grant` body (or a
//     lost/replayed state) is "expired, retry right now" (200 recovery);
//     EVERYTHING else is an outage (503) — including a 503 whose body says
//     invalid_grant, invalid_client, unparseable bodies, 429, transport
//     failures and unknown exceptions. Status governs; the body can never
//     reclassify a server error.
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

const mergeCookies = (...headers: string[]) => {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const pair of header.split(/;\s*/)) {
      const separator = pair.indexOf("=");
      if (separator <= 0) throw new Error("invalid fixture cookie pair");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
};

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
  expect(text.includes(TOK), "synthetic token in a response or recorded surface").toBe(false);
  expect(text.includes(SECRET), "synthetic secret in a response or recorded surface").toBe(false);
};

const responseSurface = (res: Response) => ({
  status: res.status,
  headers: [...res.headers],
  setCookies: res.headers.getSetCookie(),
});

const safeText = async (res: Response) => {
  const body = await res.clone().text();
  leakFree(body, responseSurface(res));
  return body;
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
function fakeSql(attemptError?: unknown) {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: Record<string, unknown>[] = [];
  const attemptedWrites: Record<string, unknown>[] = [];
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
      expect(values.length, "join_attempts bind count").toBe(4);
      const row = {
        outcome: values[0],
        source: values[1],
        requestId: values[2],
        discordId: values[3],
      };
      attemptedWrites.push(row);
      if (attemptError !== undefined) throw attemptError;
      attempts.push(row);
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), attempts, attemptedWrites };
}

/** Env with a memory session store + the fake journey store. */
function isolatedJoin(attemptError?: unknown) {
  const fake = fakeSql(attemptError);
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
  return { logs, calls, res, html: await safeText(res) };
}

async function joinErrorRoundTrip(
  e: Env,
  oauthError: string,
  { admitted = true }: { admitted?: boolean } = {},
) {
  const calls = stubFetch(() => new Response("unexpected exchange", { status: 500 }));
  const start = await app.request("/join/discord", {}, e);
  const expectedState = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const state = admitted ? expectedState : `${expectedState}x`;
  const description = encodeURIComponent(`provider detail ${TOK} ${SECRET}`);
  const logs = captureDiagnosticStream();
  const res = await app.request(
    `/join/callback?error=${encodeURIComponent(oauthError)}&error_description=${description}&state=${state}`,
    { headers: { cookie: cookiesFrom(start) } },
    e,
  );
  return { logs, calls, res, html: await safeText(res) };
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
  await safeText(res);
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
      expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
      const requestId = res.headers.get("x-request-id");
      expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
        { outcome: "error", source: null, requestId, discordId: null },
      ]);
      expect(
        res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
      ).toBe(false);
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
      expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
      expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
      expect(
        res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
      ).toBe(false);
      const home = await app.request("/?n=signin_failed", {}, e);
      const html = await safeText(home);
      expect(html).toContain("Sign in with Discord");
      streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );
});

describe("OAuth callback length refusals keep canaries out of response and diagnostics", () => {
  const oversized = `${TOK}${"x".repeat(8192)}${SECRET}`;

  it.each([
    ["join", "code"],
    ["join", "state"],
    ["login", "code"],
    ["login", "state"],
  ] as const)(
    "%s callback rejects canary-bearing oversized %s before exchange",
    async (flow, param) => {
      const { fake, env: e } = isolatedJoin();
      const startPath = flow === "join" ? "/join/discord" : "/auth/discord";
      const callbackPath = flow === "join" ? JOIN_ROUTE : LOGIN_ROUTE;
      const warning = flow === "join" ? JOIN_LOG : LOGIN_LOG;
      const start = await app.request(startPath, {}, e);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const sessionStore = (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE;
      const sessionCalls: string[] = [];
      (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE = new Proxy(sessionStore, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            sessionCalls.push(String(property));
            return Reflect.apply(value, target, args);
          };
        },
      });
      const logs = captureDiagnosticStream();
      const calls = stubFetch(() => new Response("unexpected exchange", { status: 500 }));
      const query =
        param === "code"
          ? `code=${encodeURIComponent(oversized)}&state=${encodeURIComponent(state)}`
          : `code=abc&state=${encodeURIComponent(oversized)}`;
      const res = await app.request(
        `${callbackPath}?${query}`,
        { headers: { cookie: cookiesFrom(start) } },
        e,
      );
      const body = await safeText(res);
      const requestId = res.headers.get("x-request-id");
      const metadata =
        flow === "join"
          ? {
              exception: "OversizedOAuthParams",
              source: null,
              outcome: "expired",
              request_id: requestId,
            }
          : { exception: "OversizedOAuthParams", request_id: requestId };

      leakFree(body, responseSurface(res), fake.attempts, fake.attemptedWrites);
      expect(calls).toEqual([]);
      expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
      expect(withheld(fake.attemptedWrites, [TOK, SECRET])).toEqual([]);
      expect(sessionCalls).toEqual([]);
      expect(
        res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
      ).toBe(false);
      if (flow === "join") {
        expect(res.status).toBe(200);
        expect(body).toContain("Join link expired");
      } else {
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/?n=signin_failed");
      }
      expect(recordsFor(logs, warning).map((record) => record.args)).toEqual([[warning, metadata]]);
      expect(channelCounts(logs)).toEqual({ log: 1, info: 0, debug: 0, warn: 1, error: 0 });
      streamClean(logs, callbackPath, [warning]);

      const home = flow === "login" ? await app.request("/?n=signin_failed", {}, e) : undefined;
      leakFree(
        body,
        res.headers.get("location"),
        responseSurface(res),
        home && (await safeText(home)),
        home && responseSurface(home),
        fake.attempts,
        fake.attemptedWrites,
      );
    },
  );
});

describe("join callback: consent errors stay out of response, attempts and diagnostics", () => {
  it.each([
    ["explicit denial", "access_denied", "Join cancelled"],
    ["unrecognized provider error", "unexpected_provider_error", "Join didn&#39;t complete"],
  ])(
    "records %s as a denial without echoing provider details",
    async (_name, oauthError, title) => {
      const { fake, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinErrorRoundTrip(e, oauthError);
      expect(res.status).toBe(200);
      expect(html).toContain(title);
      expect(calls).toEqual([]);
      const requestId = res.headers.get("x-request-id");
      expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
        { outcome: "denied", source: null, requestId, discordId: null },
      ]);
      expect(recordsFor(logs, JOIN_LOG)).toEqual([]);
      expect(channelCounts(logs)).toEqual({ log: 1, info: 0, debug: 0, warn: 0, error: 0 });
      streamClean(logs, JOIN_ROUTE);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it("unadmitted provider error ignores canary description and records no denial", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinErrorRoundTrip(e, "access_denied", {
      admitted: false,
    });
    expect(res.status).toBe(200);
    expect(html).toContain("Join link expired");
    expect(calls).toEqual([]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    const requestId = res.headers.get("x-request-id");
    expect(recordsFor(logs, JOIN_LOG).map((record) => record.args)).toEqual([
      [
        JOIN_LOG,
        { exception: "InvalidState", source: null, outcome: "expired", request_id: requestId },
      ],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 1, info: 0, debug: 0, warn: 1, error: 0 });
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
  });
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
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "error", source: null, requestId, discordId: null },
    ]);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html, fake.attempts, res.headers.getSetCookie());
  });

  it.each([
    [401, "provider_reject"],
    [403, "provider_reject"],
    [429, "rate_limited"],
    [500, "provider_outage"],
    [503, "provider_outage"],
  ] as [number, DiscordError["kind"]][])(
    "HTTP %i with invalid_grant cannot select expired join recovery",
    async (status, kind) => {
      const { fake, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinRoundTrip(e, () => invalidGrant(status));
      expect(res.status).toBe(503);
      expect(html).toContain("Discord is unreachable");
      expect(html).not.toContain("approval expired");
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
      expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
        { outcome: "error", source: null, requestId, discordId: null },
      ]);
      streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it("exchange 429 rejects a marker-bearing Retry-After value", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinRoundTrip(e, () =>
      Response.json(
        { error: "rate_limited", error_description: `provider detail ${SECRET}` },
        { status: 429, headers: { "Retry-After": TOK } },
      ),
    );
    expect(res.status).toBe(503);
    expect(html).toContain("Discord is unreachable");
    expect(res.headers.get("Retry-After") === null).toBe(true);
    expect(calls).toHaveLength(1);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      {
        outcome: "error",
        source: null,
        requestId: res.headers.get("x-request-id"),
        discordId: null,
      },
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html, responseSurface(res), fake.attempts);
  });

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
    expect(await safeText(res)).toContain("Join link expired");
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

  it("bot 429 rejects a marker-bearing Retry-After value from response surfaces", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinRoundTrip(e, (url) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42"))
        return Response.json(
          { message: `rate limited ${SECRET}` },
          { status: 429, headers: { "Retry-After": TOK } },
        );
      throw new Error("unexpected Discord call");
    });
    expect(res.status).toBe(200);
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(res.headers.get("Retry-After") === null).toBe(true);
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
    ).toBe(false);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
    ]);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      "/api/v10/guilds/326474832151838730/members/42",
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, JOIN_ROUTE);
    leakFree(html, responseSurface(res), fake.attempts);
  });

  it("bot refusal with a marker-bearing body: 200 recovery, no session, one degraded attempt, clean stream", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res, html } = await joinRoundTrip(e, botRefusalWithMarkers);
    expect(res.status).toBe(200);
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("use the invite link below");
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("Try again");
    expect(html).toContain("https://discord.gg/invite");
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
    ).toBe(false);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "degraded", source: null, requestId: null, discordId: "42" },
    ]);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      "/api/v10/guilds/326474832151838730/members/42",
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 0, error: 0 });
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
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
    ).toBe(false);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "degraded", source: null, requestId: null, discordId: "42" },
    ]);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      "/api/v10/guilds/326474832151838730/members/42",
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 0, error: 0 });
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
    await safeText(res);
    return { logs, calls, res };
  }

  it("moderator transport throw after a successful bot add: 302, non-moderator session, bounded stream", async () => {
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
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-two_session=[^;]/);
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await safeText(home)).toContain("Rick");
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, JOIN_ROUTE);
    leakFree(
      await safeText(res),
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
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(recordsFor(logs, MODERATOR_LOOKUP_LOG).map((r) => r.args)).toEqual([
      [MODERATOR_LOOKUP_LOG, { status: 500, guild_id: "326474832151838730" }],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-two_session=[^;]/);
    streamClean(logs, JOIN_ROUTE, [MODERATOR_LOOKUP_LOG]);
    leakFree(
      await safeText(res),
      res.headers.get("location"),
      [...res.headers],
      setCookie,
      fake.attempts,
      created,
    );
  });

  it("moderator malformed JSON after a successful bot add: non-moderator session, bounded warning", async () => {
    const { fake, env: e } = isolatedJoin();
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(
      e,
      () => new Response(`not JSON ${TOK} ${SECRET}`, { status: 200 }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(calls[3]!.method).toBe("GET");
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(
      recordsFor(logs, "moderator recompute lookup returned non-JSON").map((r) => r.args),
    ).toEqual([
      ["moderator recompute lookup returned non-JSON", { guild_id: env.DISCORD_GUILD_ID }],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    streamClean(logs, JOIN_ROUTE, ["moderator recompute lookup returned non-JSON"]);
    leakFree(
      await safeText(res),
      res.headers.get("location"),
      [...res.headers],
      res.headers.getSetCookie(),
      fake.attempts,
      created,
    );
  });

  it("attempt-write failure after a successful bot add: sign-in continues with a bounded warning", async () => {
    const failure = new Error(`insert failed ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
    const { fake, env: e } = isolatedJoin(failure);
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(e, () =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(withheld(fake.attemptedWrites, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    expect(recordsFor(logs, "join attempt write failed").map((r) => r.args)).toEqual([
      ["join attempt write failed", { exception: "Error", outcome: "added" }],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    streamClean(logs, JOIN_ROUTE, ["join attempt write failed"]);
    leakFree(
      await safeText(res),
      res.headers.get("location"),
      [...res.headers],
      res.headers.getSetCookie(),
      fake.attempts,
      created,
    );
  });

  it("roster write failure after a successful bot add: session issues with a bounded warning", async () => {
    const { fake, env: baseEnv } = isolatedJoin();
    const throwingRoster = (async () => {
      throw new Error(`roster insert ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
    }) as unknown as Sql;
    const e = { ...baseEnv, ROSTER_STORE: throwingRoster } as Env;
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(e, () =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(recordsFor(logs, "roster upsert failed").map((r) => r.args)).toEqual([
      ["roster upsert failed", { request_id: res.headers.get("x-request-id"), exception: "Error" }],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    streamClean(logs, JOIN_ROUTE, ["roster upsert failed"]);
    leakFree(
      await safeText(res),
      res.headers.get("location"),
      [...res.headers],
      res.headers.getSetCookie(),
      fake.attempts,
      created,
    );
  });

  it("prior-session sweep failure after a successful bot add: session issues with a bounded warning", async () => {
    const { fake, env: e } = isolatedJoin();
    const store = (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE;
    (store as unknown as { revokeUserSessions: () => Promise<never> }).revokeUserSessions =
      async () => {
        throw new Error(`session sweep ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
      };
    const created = captureIssuedSessions(e);
    const { logs, calls, res } = await postBotRoundTrip(e, () =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(recordsFor(logs, "prior session sweep failed").map((r) => r.args)).toEqual([
      [
        "prior session sweep failed",
        { request_id: res.headers.get("x-request-id"), exception: "Error" },
      ],
    ]);
    expect(channelCounts(logs)).toEqual({ log: 2, info: 0, debug: 0, warn: 1, error: 0 });
    expect(created).toEqual([{ moderator: false, userId: "42", member: true }]);
    streamClean(logs, JOIN_ROUTE, ["prior session sweep failed"]);
    leakFree(
      await safeText(res),
      res.headers.get("location"),
      [...res.headers],
      res.headers.getSetCookie(),
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
    const html = await safeText(res);
    expect(res.status).toBe(500);
    expect(html).toContain("Something broke on our side");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).not.toContain("__Host-two_session=");
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await safeText(home)).not.toContain("Rick");
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 0, error: 1 });
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

  it("session-replace throw after a successful bot add: bounded alert, no new session cookie", async () => {
    __resetAlertRateLimitForTests();
    const { fake, env: e } = isolatedJoin();
    stubSignInDiscord();
    const loginStart = await app.request("/auth/discord", {}, e);
    const loginState = new URL(loginStart.headers.get("location")!).searchParams.get("state")!;
    const login = await app.request(
      `/auth/discord/callback?code=abc&state=${loginState}`,
      { headers: { cookie: cookiesFrom(loginStart) } },
      e,
    );
    const priorCookie = cookiesFrom(login);
    expect(priorCookie).toContain("__Host-two_session=");

    const joinStart = await app.request("/join/discord", { headers: { cookie: priorCookie } }, e);
    const state = new URL(joinStart.headers.get("location")!).searchParams.get("state")!;
    const priorCookies = priorCookie.split(/;\s*/);
    const joinCookies = cookiesFrom(joinStart).split(/;\s*/);
    const callbackCookie = mergeCookies(priorCookie, joinCookies.join("; "));
    const callbackCookies = callbackCookie.split(/;\s*/);
    const sessionCookie = priorCookies.find((cookie) => cookie.startsWith("__Host-two_session="));
    expect(sessionCookie !== undefined).toBe(true);
    expect(callbackCookies.includes(sessionCookie!)).toBe(true);
    expect(joinCookies.length).toBeGreaterThan(0);
    expect(joinCookies.every((cookie) => callbackCookies.includes(cookie))).toBe(true);
    const logs = captureDiagnosticStream();
    const store = (e as unknown as { SESSION_STORE: SessionStore }).SESSION_STORE;
    store.replace = async () => {
      throw new Error(`session replace ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
    };
    const calls = stubPostBotDiscord(() =>
      Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" }),
    );
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie: callbackCookie } },
      e,
    );
    const html = await safeText(res);
    expect(res.status).toBe(500);
    expect(html).toContain("Something broke on our side");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/oauth2/token",
      "/api/v10/users/@me",
      MEMBER_PATH,
      MEMBER_PATH,
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.includes("__Host-two_session=")),
    ).toBe(false);
    expect(channelCounts(logs)).toEqual({ log: 1, info: 0, debug: 0, warn: 0, error: 1 });
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
    leakFree(html, [...res.headers], res.headers.getSetCookie(), fake.attempts);
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
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(
      e,
      () => new Response("{}", { status: 200 }),
      `error=access_denied&error_description=${encodeURIComponent(`member denied with ${TOK}`)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_denied");
    const home = await app.request("/?n=signin_denied", {}, e);
    const html = await safeText(home);
    expect(html).toContain("You cancelled the Discord sign-in");
    expect(html).not.toContain("did not answer");
    expect(calls).toHaveLength(0); // no exchange is attempted for a consent refusal
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, LOGIN_ROUTE);
    leakFree(html, responseSurface(res), responseSurface(home), fake.attempts);
  });

  it("renders the generic banner for any other OAuth error", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(
      e,
      () => new Response("{}", { status: 200 }),
      `error=server_error&error_description=${encodeURIComponent(`upstream says ${SECRET}`)}`,
    );
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(0);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    const home = await app.request("/?n=signin_failed", {}, e);
    const html = await safeText(home);
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 0, error: 0 });
    streamClean(logs, LOGIN_ROUTE);
    leakFree(html, responseSurface(res), responseSurface(home), fake.attempts);
  });

  it("expired grant on login: generic banner, bounded log", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(e, () => invalidGrant(400));
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(1);
    const home = await app.request("/?n=signin_failed", {}, e);
    const html = await safeText(home);
    const signLine = recordsFor(logs, LOGIN_LOG);
    expect(signLine).toHaveLength(1);
    expect(signLine[0]!.args[1]).toEqual({
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
      request_id: res.headers.get("x-request-id"),
    });
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 1, error: 0 });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(html, responseSurface(res), responseSurface(home), fake.attempts);
  });

  it("outage on login: the unavailable banner says it is on Discord, not you", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(e, () => invalidGrant(503));
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    expect(calls).toHaveLength(1);
    const home = await app.request("/?n=signin_unavailable", {}, e);
    const html = await safeText(home);
    expect(html).toContain("Discord did not answer just now");
    expect(html).toContain("This is on Discord, not you");
    expect(recordsFor(logs, LOGIN_LOG).map((record) => record.args)).toEqual([
      [
        LOGIN_LOG,
        {
          exception: "DiscordError",
          kind: "provider_outage",
          status: 503,
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 1, error: 0 });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(html, responseSurface(res), responseSurface(home), fake.attempts);
  });

  it("transport failure on login: unavailable banner, token dropped from the log", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, calls, res } = await loginRoundTrip(e, () => {
      throw new TypeError(`failed sending ${TOK}`);
    });
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    expect(calls).toHaveLength(1);
    const home = await app.request("/?n=signin_unavailable", {}, e);
    const html = await safeText(home);
    expect(recordsFor(logs, LOGIN_LOG).map((record) => record.args)).toEqual([
      [
        LOGIN_LOG,
        {
          exception: "DiscordError",
          kind: "transport_failure",
          status: 0,
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    expect(withheld(fake.attempts, [TOK, SECRET])).toEqual([]);
    expect(channelCounts(logs)).toEqual({ log: 3, info: 0, debug: 0, warn: 1, error: 0 });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(html, responseSurface(res), responseSurface(home), fake.attempts);
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
    const body = await safeText(res);
    expect(body).toContain('<a class="brand" href="/"');
    expect(body).not.toMatch(/ECONNREFUSED|postgres:\/\/|db\.internal/);
    expect(body).not.toContain(SECRET);
    const gateLine = recordsFor(logs, "profiles could not resolve the session; refusing.");
    expect(gateLine).toHaveLength(1);
    expect(gateLine[0]!.args[1]).toEqual({ exception: "Error" });
    streamClean(logs, "/profile", ["profiles could not resolve the session; refusing."]);
  });
});
