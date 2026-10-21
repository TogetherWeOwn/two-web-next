// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// Acceptance: a rate-limited bot add answers an honored throttle.
//
// The classified bot-add contract (test/guild-join-failure-classification.test.ts)
// distinguishes Discord's 429 (`rate_limited`) from its 403 (`forbidden`),
// and the join callback keeps the two distinct member-facing: a
// `rate_limited` bot add answers 503 with the provider's bounded backoff as
// `Retry-After` and copy that names the throttle, while `forbidden` and
// every other classified failure keep the 200 blocked-copy recovery with no
// header and the "degraded" row. A 200 would tell clients and caches
// success, and `Retry-After` on 200 is ignored — status, header and copy
// agree instead. The login auto-join still redirects to /?n=join_failed
// (302): only the join callback renders the throttle page.
//
// Pinned contract (status, header, copy and funnel row agree):
//   - GET /join/callback with a `rate_limited` bot add renders the 503
//     throttle page — distinct title and message from the `forbidden`
//     recovery — plus a `Retry-After` header carrying the provider's
//     bounded backoff: the same admission as the exchange 429 branch
//     (trimmed digits with an optional fraction, rounded UP, minimum 1,
//     capped at 86400; absent, malformed or body-only values are unusable
//     and keep the headerless 503 — never "0", never a raw provider string);
//   - that callback records the DISTINCT attempt outcome "rate_limited"
//     (a canonical JOIN_OUTCOMES value) instead of "degraded", whether or
//     not the provider sent a usable backoff; the other three safe columns
//     (source, request_id, discord_id) are unchanged;
//   - `forbidden` and every other classified failure carry NEITHER: no
//     `Retry-After` (even when the provider response sent one) and the
//     attempt outcome stays "degraded";
//   - the seam that carries the backoff is the existing BotAdd answer: a
//     rate-limited answer may carry `retryAfter` (bounded integer seconds,
//     the same field name as DiscordError.retryAfter / ThrottleVerdict),
//     which finishJoin surfaces on its recoverable result only for
//     `rate_limited` — a `retryAfter` riding on any other result is dropped;
//   - login auto-join (GET /auth/discord/callback) gets the same header
//     treatment: a rate-limited auto-join still signs in as a non-member to
//     /?n=join_failed (302), now with `Retry-After`; a forbidden auto-join
//     and every success stay headerless. Login records no attempt row, so
//     no outcome changes there;
//   - neither journey retries the bot add (exactly one PUT), signs the
//     member in on a failed join-callback add, or lets a token or provider
//     body byte reach a page, header, cookie, attempt row or log line.
//
// Mounted-app + seam suite with local fixtures only: the global fetch is
// stubbed and the bot seam is stubbed where named, no live Discord, no
// database, no credentials beyond inert fixtures. The synthetic secrets
// are asterisk-padded on purpose so they stay grep-able without matching
// any secret scanner.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { captureDiagnosticStream, expectDiagnosticStreamClean } from "./helpers/diagnostic-stream";
import type { JoinResult } from "../src/discord";
import type { Env } from "../src/env";
import { finishJoin, JOIN_OUTCOMES, liveBotAdd, type BotAdd } from "../src/join/service";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";

const TOK = "***synthetic-access-7f3a***";
const BOT = "***synthetic-bot-9k2m***";
const SECRET = "***synthetic-secret-4t8z***";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: BOT,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Nothing a member or an operator can read may carry a synthetic secret. */
const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text.includes(TOK), "synthetic access token on a readable surface").toBe(false);
  expect(text.includes(BOT), "synthetic bot token on a readable surface").toBe(false);
  expect(text.includes(SECRET), "synthetic body secret on a readable surface").toBe(false);
};

/** The bounded backoff a BotAdd / finishJoin answer carries, when it carries one. */
const retryAfterOf = (answer: unknown) => (answer as { retryAfter?: unknown }).retryAfter;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// In-memory Sql double for the journey's two statements. Mirrors
// test/guild-join-failure-classification.test.ts; anything else is a test bug.
function fakeSql() {
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
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
  return { sql: withThrottleTx(sql), attempts };
}

type PutAnswer = () => Response | Promise<Response>;

/** Full Discord stub: token -> user -> PUT member (injected) -> GET roles. */
function stubDiscord(putAnswer: PutAnswer) {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      calls.push({ path: new URL(url).pathname, method });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && method === "PUT") return putAnswer();
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      throw new Error(`unexpected Discord call ${method} ${new URL(url).pathname}`);
    }),
  );
  return calls;
}

const putsOf = (calls: { path: string; method: string }[]) =>
  calls.filter((c) => c.method === "PUT" && c.path.endsWith("/members/42"));

// A provider answer whose body must never be echoed or mined: it carries a
// marker string and a body-level retry_after (77) that is NOT the header.
const providerPut =
  (status: number, retryAfter?: string): PutAnswer =>
  async () =>
    new Response(
      JSON.stringify({ message: `provider detail ${SECRET} for ${TOK}`, retry_after: 77 }),
      {
        status,
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      },
    );

function isolatedJoin(bot?: (botToken: string) => BotAdd) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const create = vi.spyOn(store, "create");
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...(bot ? { bot } : {}) },
  } as unknown as Env;
  return { fake, create, env: e };
}

async function joinRoundTrip(e: Env, putAnswer: PutAnswer) {
  const logs = captureDiagnosticStream();
  const calls = stubDiscord(putAnswer);
  const start = await app.request("/join/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await app.request(
    `/join/callback?code=abc&state=${state}`,
    { headers: { cookie: cookiesFrom(start) } },
    e,
  );
  return { logs, calls, res, html: await res.text() };
}

/** The throttle recovery every rate-limited join-callback bot add must keep. */
function expectThrottleRecovery(res: Response, html: string) {
  expect(res.status).toBe(503);
  expect(html).toContain("Discord throttled the automatic add");
  expect(html).toContain("rate-limiting automatic adds");
  expect(html).toContain("Wait a moment, then try again below, or use the invite link.");
  expect(html).toContain('data-testid="recovery-retry"');
  expect(html).toContain('data-testid="recovery-invite"');
  expect(html).toContain("https://discord.gg/invite");
  expect(html).not.toContain("Discord is unreachable");
  expect(html).not.toContain("We couldn&#39;t add you automatically");
  expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
}

/** The blocked-copy recovery every refused join-callback bot add must keep. */
function expectBlockedRecovery(res: Response, html: string) {
  expect(res.status).toBe(200);
  expect(html).toContain("We couldn&#39;t add you automatically");
  expect(html).toContain('data-testid="recovery-invite"');
  expect(html).toContain("https://discord.gg/invite");
  expect(html).not.toContain("Discord is unreachable");
  expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
}

describe("join callback: a rate-limited bot add surfaces Retry-After and a distinct outcome", () => {
  it.each([
    ["120", "120"],
    ["1", "1"],
    ["86400", "86400"],
    // Fractional provider values round UP: never retry sooner than asked.
    ["2.5", "3"],
    ["0.4", "1"],
  ])(
    "PUT 429 with retry-after %s: 503 throttle + Retry-After: %s + rate_limited attempt",
    async (provider, expected) => {
      const { fake, create, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinRoundTrip(e, providerPut(429, provider));
      expectThrottleRecovery(res, html);
      expect(res.headers.get("retry-after")).toBe(expected);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(fake.attempts).toEqual([
        { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
      ]);
      expect(putsOf(calls)).toHaveLength(1);
      expect(create).not.toHaveBeenCalled();
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], { request: "/join/callback" });
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it("caps an absurd but representable provider value at the 86400s ceiling", async () => {
    const { fake, env: e } = isolatedJoin();
    const { res, html } = await joinRoundTrip(e, providerPut(429, "999999999"));
    expectThrottleRecovery(res, html);
    const header = res.headers.get("retry-after");
    expect(header).not.toBeNull();
    expect(header).toMatch(/^\d+$/);
    expect(Number(header)).toBeGreaterThanOrEqual(1);
    expect(Number(header)).toBeLessThanOrEqual(86400);
    expect(header).not.toBe("999999999");
    expect(fake.attempts).toEqual([
      { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
    ]);
  });

  it.each([
    ["absent header", undefined],
    ["HTTP-date", "Wed, 21 Oct 2015 07:28:00 GMT"],
    ["non-numeric", "abc"],
    ["negative", "-5"],
    ["exponent", "1e3"],
    ["units", "12 seconds"],
    ["empty", ""],
    ["unrepresentable magnitude", "999999999999999999999999"],
  ] as [string, string | undefined][])(
    "PUT 429 with unusable backoff (%s): 503 throttle, outcome still rate_limited, no Retry-After",
    async (_name, provider) => {
      const { fake, env: e } = isolatedJoin();
      const { res, html } = await joinRoundTrip(e, providerPut(429, provider));
      expectThrottleRecovery(res, html);
      // The body's own retry_after (77) is never mined as a substitute.
      expect(res.headers.get("retry-after")).toBeNull();
      if (provider) expect(html).not.toContain(provider);
      expect(fake.attempts).toEqual([
        { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
      ]);
      leakFree(html, fake.attempts, [...res.headers]);
    },
  );

  it('PUT 429 with retry-after "0" never emits Retry-After: 0, outcome still distinct', async () => {
    const { fake, env: e } = isolatedJoin();
    const { res, html } = await joinRoundTrip(e, providerPut(429, "0"));
    expectThrottleRecovery(res, html);
    const header = res.headers.get("retry-after");
    expect(header === null || (/^\d+$/.test(header) && Number(header) >= 1)).toBe(true);
    expect(fake.attempts).toEqual([
      { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
    ]);
  });
});

describe("join callback: forbidden and other failures carry neither header nor distinct outcome", () => {
  it.each([
    ["403 forbidden", providerPut(403, "120")],
    ["500 provider_outage", providerPut(500, "120")],
    ["503 provider_outage", providerPut(503, "120")],
    ["400 failed", providerPut(400, "120")],
    [
      "transport throw quoting the token",
      (async () => {
        throw new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
      }) as PutAnswer,
    ],
  ] as [string, PutAnswer][])(
    "PUT %s with a provider retry-after: 200 recovery, no Retry-After, degraded attempt",
    async (_name, putAnswer) => {
      const { fake, create, env: e } = isolatedJoin();
      const { logs, calls, res, html } = await joinRoundTrip(e, putAnswer);
      expectBlockedRecovery(res, html);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(fake.attempts).toEqual([
        { outcome: "degraded", source: null, requestId: null, discordId: "42" },
      ]);
      expect(putsOf(calls)).toHaveLength(1);
      expect(create).not.toHaveBeenCalled();
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], { request: "/join/callback" });
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it("throttle and forbidden recoveries differ in status, header and copy — and both stay leak-free", async () => {
    const limited = isolatedJoin();
    const { res: limitedRes, html: limitedHtml } = await joinRoundTrip(
      limited.env,
      providerPut(429, "37"),
    );
    const forbidden = isolatedJoin();
    const { res: forbiddenRes, html: forbiddenHtml } = await joinRoundTrip(
      forbidden.env,
      providerPut(403, "37"),
    );
    // Status, header and copy agree per path: 503 + backoff + throttle copy
    // for the rate-limited add, 200 + headerless blocked copy for the refusal.
    expectThrottleRecovery(limitedRes, limitedHtml);
    expectBlockedRecovery(forbiddenRes, forbiddenHtml);
    expect(limitedRes.headers.get("retry-after")).toBe("37");
    expect(forbiddenRes.headers.get("retry-after")).toBeNull();
    expect(limited.fake.attempts.map((a) => a.outcome)).toEqual(["rate_limited"]);
    expect(forbidden.fake.attempts.map((a) => a.outcome)).toEqual(["degraded"]);
    // The two pages share the recovery shell (retry + invite anchors, support
    // reference) but never each other's copy.
    for (const html of [limitedHtml, forbiddenHtml]) {
      expect(html).toContain('data-testid="recovery-retry"');
      expect(html).toContain('data-testid="error-support-reference"');
    }
    expect(forbiddenHtml).not.toContain("Discord throttled the automatic add");
  });

  it.each([
    [201, "/?n=joined", "added"],
    [204, "/?n=already_member", "already_member"],
  ] as [number, string, string][])(
    "PUT %i success control carrying retry-after: redirect %s, attempt %s, header never forwarded",
    async (status, location, outcome) => {
      const { fake, env: e } = isolatedJoin();
      const { calls, res } = await joinRoundTrip(
        e,
        async () => new Response(null, { status, headers: { "retry-after": "37" } }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
      expect(fake.attempts).toEqual([{ outcome, source: null, requestId: null, discordId: "42" }]);
      expect(putsOf(calls)).toHaveLength(1);
    },
  );
});

describe("BotAdd seam: retryAfter rides only on rate_limited, through finishJoin to the callback", () => {
  const botReturning = (
    result: string,
    requestId: string | null = null,
    retryAfter?: number,
  ): BotAdd =>
    (async () => ({
      result: result as JoinResult,
      requestId,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    })) as unknown as BotAdd;

  it("liveBotAdd threads the PUT 429 backoff out as retryAfter alongside rate_limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: SECRET, retry_after: 77 }), {
            status: 429,
            headers: { "retry-after": "37" },
          }),
      ),
    );
    const outcome = await liveBotAdd(BOT)("326474832151838730", "42", TOK);
    expect(outcome.result as string).toBe("rate_limited");
    expect(outcome.requestId).toBeNull();
    expect(retryAfterOf(outcome)).toBe(37);
    leakFree(outcome);
  });

  it.each([
    [403, "forbidden"],
    [500, "provider_outage"],
    [201, "joined"],
  ] as [number, string][])(
    "liveBotAdd on PUT %i (%s) carrying retry-after surfaces no retryAfter",
    async (status, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status, headers: { "retry-after": "37" } })),
      );
      const outcome = await liveBotAdd(BOT)("326474832151838730", "42", TOK);
      expect(outcome.result as string).toBe(expected);
      expect(retryAfterOf(outcome)).toBeUndefined();
      leakFree(outcome);
    },
  );

  it("liveBotAdd on PUT 429 without a usable header surfaces rate_limited and no retryAfter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ retry_after: 77 }), { status: 429 })),
    );
    const outcome = await liveBotAdd(BOT)("326474832151838730", "42", TOK);
    expect(outcome.result as string).toBe("rate_limited");
    expect(retryAfterOf(outcome)).toBeUndefined();
  });

  it("finishJoin maps rate_limited to the distinct outcome and surfaces its retryAfter", async () => {
    const done = await finishJoin(botReturning("rate_limited", "req-rl", 37), "g", "u", TOK, null);
    expect(done).toMatchObject({
      kind: "recoverable",
      outcome: "rate_limited",
      requestId: "req-rl",
    });
    expect(retryAfterOf(done)).toBe(37);
    leakFree(done);
  });

  it("finishJoin keeps a rate_limited answer without backoff distinct but headerless", async () => {
    const done = await finishJoin(botReturning("rate_limited", "req-rl"), "g", "u", TOK, null);
    expect(done).toMatchObject({
      kind: "recoverable",
      outcome: "rate_limited",
      requestId: "req-rl",
    });
    expect(retryAfterOf(done)).toBeUndefined();
  });

  it.each(["forbidden", "provider_outage", "transport_failure", "failed"])(
    "finishJoin drops a retryAfter riding on %s: still degraded, never surfaces it",
    async (classified) => {
      const done = await finishJoin(botReturning(classified, "req-7", 37), "g", "u", TOK, null);
      expect(done).toMatchObject({
        kind: "recoverable",
        outcome: "degraded",
        requestId: "req-7",
      });
      expect(retryAfterOf(done)).toBeUndefined();
      leakFree(done);
    },
  );

  it("the distinct outcome is canonical: JOIN_OUTCOMES contains rate_limited exactly once", () => {
    expect(JOIN_OUTCOMES.filter((o) => o === ("rate_limited" as string))).toHaveLength(1);
    // The pre-existing outcomes keep their meaning alongside the new one.
    for (const existing of ["added", "already_member", "error", "denied", "degraded"]) {
      expect(JOIN_OUTCOMES as readonly string[]).toContain(existing);
    }
  });

  it("a stubbed JOIN_DEPS.bot rate_limited answer reaches the callback response and attempt row", async () => {
    const bot: (botToken: string) => BotAdd = () => botReturning("rate_limited", "req-rl", 37);
    const { fake, create, env: e } = isolatedJoin(bot);
    // Token + user still come from Discord; the PUT must never happen
    // because the injected bot replaces the live call.
    const { calls, res, html } = await joinRoundTrip(e, async () => {
      throw new Error("the live PUT must not run when JOIN_DEPS.bot is injected");
    });
    expectThrottleRecovery(res, html);
    expect(res.headers.get("retry-after")).toBe("37");
    expect(fake.attempts).toEqual([
      { outcome: "rate_limited", source: null, requestId: "req-rl", discordId: "42" },
    ]);
    expect(putsOf(calls)).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    leakFree(html, fake.attempts, [...res.headers]);
  });

  it("a stubbed JOIN_DEPS.bot forbidden answer stays headerless + degraded even with retryAfter set", async () => {
    const bot: (botToken: string) => BotAdd = () => botReturning("forbidden", "req-fb", 37);
    const { fake, env: e } = isolatedJoin(bot);
    const { res, html } = await joinRoundTrip(e, async () => {
      throw new Error("the live PUT must not run when JOIN_DEPS.bot is injected");
    });
    expectBlockedRecovery(res, html);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(fake.attempts).toEqual([
      { outcome: "degraded", source: null, requestId: "req-fb", discordId: "42" },
    ]);
  });
});

describe("login auto-join: a rate-limited auto join carries Retry-After on the same redirect", () => {
  async function loginRoundTrip(putAnswer: PutAnswer) {
    const store = createMemorySessionStore();
    const e = { ...env, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    const calls = stubDiscord(putAnswer);
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    return { store, logs, calls, res };
  }

  async function sessionRowOf(store: ReturnType<typeof createMemorySessionStore>, res: Response) {
    const signed = decodeURIComponent(
      res.headers
        .getSetCookie()
        .find((c) => c.startsWith("__Host-two_session="))!
        .split(";")[0]!
        .split("=")[1]!,
    );
    // hono signs `token.signature`; the bearer token is the part before the dot.
    return store.get(await hashToken(signed.split(".")[0]!));
  }

  it.each([
    ["45", "45"],
    // Bounded exactly like the join callback: rounded UP, capped at 86400.
    ["2.5", "3"],
  ])(
    "PUT 429 with retry-after %s: 302 /?n=join_failed + Retry-After: %s, still signed in as non-member",
    async (provider, expected) => {
      const { store, logs, calls, res } = await loginRoundTrip(providerPut(429, provider));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?n=join_failed");
      expect(res.headers.get("retry-after")).toBe(expected);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(await sessionRowOf(store, res)).toMatchObject({
        userId: "42",
        member: false,
        moderator: false,
      });
      expect(putsOf(calls)).toHaveLength(1);
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], {
        request: "/auth/discord/callback",
        messages: ["guild auto-join failed"],
      });
      leakFree(res.headers.get("location"), [...res.headers], res.headers.getSetCookie());
    },
  );

  it("PUT 429 without a usable backoff: same redirect, no Retry-After (body retry_after never mined)", async () => {
    const { store, res } = await loginRoundTrip(providerPut(429));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await sessionRowOf(store, res)).toMatchObject({ userId: "42", member: false });
  });

  it.each([
    ["403 forbidden", providerPut(403, "45")],
    ["500 provider_outage", providerPut(500, "45")],
  ] as [string, PutAnswer][])(
    "PUT %s carrying retry-after: same redirect, header not forwarded, still signed in",
    async (_name, putAnswer) => {
      const { store, calls, res } = await loginRoundTrip(putAnswer);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?n=join_failed");
      expect(res.headers.get("retry-after")).toBeNull();
      expect(await sessionRowOf(store, res)).toMatchObject({
        userId: "42",
        member: false,
        moderator: false,
      });
      expect(putsOf(calls)).toHaveLength(1);
      leakFree(res.headers.get("location"), [...res.headers]);
    },
  );

  it.each([
    [201, "/?n=joined"],
    [204, "/?n=already_member"],
  ] as [number, string][])(
    "PUT %i success control carrying retry-after: redirect %s unchanged, no Retry-After",
    async (status, location) => {
      const { calls, res } = await loginRoundTrip(
        async () => new Response(null, { status, headers: { "retry-after": "45" } }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
      expect(putsOf(calls)).toHaveLength(1);
    },
  );
});
