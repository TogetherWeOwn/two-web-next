// route-inventory: GET /join
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// Acceptance (E1: the join funnel tells the truth): silent and mislabeled
// join recovery paths name the real failure with a working way forward.
//
// Pinned contract, per path (status, header and copy agree):
//   1. Store-down start: GET /join/discord with a failing journey store still
//      degrades (never 500), but the landing page carries a VISIBLE explanation
//      naming the failed start plus the one-click retry — not today's silent
//      bounce to a notice-less /join. The redirect chain terminates: no loop.
//   2. Unadmitted access_denied: a Cancel that arrives without an admitted
//      journey (forged/stray state) renders the same cancelled-consent copy as
//      the admitted denial ("Join cancelled"), never the expiry sentence.
//      True expired-state (no error) keeps the expiry copy.
//   3. Rate-limited bot add: a classified `rate_limited` add answers 503 +
//      `Retry-After` with copy that names throttling — 200 tells clients and
//      caches success, and Retry-After on 200 is ignored. The forbidden path
//      keeps its non-throttle copy: the two pages are no longer identical.
//   4. Exchange 429: a throttled token exchange (or user fetch) keeps 503 +
//      `Retry-After` but its copy names throttling/wait instead of
//      "unreachable". A true outage (5xx, transport throw) keeps the
//      unreachable copy. Status governs classification on every path: a 429
//      with an invalid_grant/forbidden body is still throttled, a 503 with an
//      invalid_grant body is still an outage, and throttle words never leak
//      onto the forbidden/outage/expired pages.
//   5. Nowhere is a provider detail or `error_description` echoed.
//
// Fail-first suite: the RED tests below fail at the evidence pin and green up
// under the E1 build, which owns the exact new copy within the worded
// contracts above. The builder also updates the two suites that pin today's
// contradictory contracts (the 200 + byte-identical pin in
// test/join-bot-add-rate-limited-acceptance.test.ts and the unreachable-for-429
// pin in test/join-discord-429-backoff.test.ts) but MUST NOT edit this file.
//
// Mounted-app suite with local fixtures only: the global fetch is stubbed, the
// journey store is the memory store (poisoned where named), no live Discord,
// no database, no credentials beyond inert fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, type Sql } from "../src/sessions";

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

const DESCRIPTION_SECRET = "denied-description-must-never-appear";
const PROVIDER_MARKER = "provider-body-must-never-appear";

// The store-down explanation names the failed start in plain words. None of
// these match the plain /join render, so each alternative is a real RED pin:
// bare /wait/ is ruled out by "no invite link, no waiting", and /unavailable/
// by the widget fallback ("Live server preview is unavailable").
const START_FAILURE_WORDS =
  /couldn.t start|failed to start|went wrong|unable to start|trouble starting/i;

// Throttle copy names throttling in plain words. None match today's blocked
// copy ("You're nearly there — ...") or today's outage copy ("Discord is
// unreachable ... Try again in a moment ..."), so each is a real RED pin.
// "Try again in" is deliberately NOT listed: the outage page already says it.
const THROTTLE_WORDS = /throttl|rate.limit|backoff|too many requests|slow down/i;

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the journey's two statements. Mirrors
// test/join-recovery-support-reference.test.ts: the throttle bucket never
// fills, attempts record the four safe columns.
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

function isolated() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { store, fake, env: e };
}

type Store = ReturnType<typeof createMemorySessionStore>;

type Answer = () => Response | Promise<Response>;

type DiscordCall = { path: string; method: string };

// Full Discord stub (token -> user -> PUT member -> GET roles); any leg can be
// overridden per test. A PUT the test did not configure is a test bug.
function stubDiscord(config: { token?: Answer; user?: Answer; put?: Answer } = {}) {
  const calls: DiscordCall[] = [];
  const tokenAnswer =
    config.token ?? (async () => Response.json({ access_token: "fixture-access-token" }));
  const userAnswer =
    config.user ??
    (async () => Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null }));
  const putAnswer =
    config.put ??
    (async () => {
      throw new Error("unexpected PUT /members/42: the test did not configure a bot answer");
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      calls.push({ path: new URL(url).pathname, method });
      if (url.endsWith("/oauth2/token")) return tokenAnswer();
      if (url.endsWith("/users/@me")) return userAnswer();
      if (url.includes("/members/42") && method === "PUT") return putAnswer();
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      throw new Error(`unexpected Discord call ${method} ${new URL(url).pathname}`);
    }),
  );
  return calls;
}

const putsOf = (calls: DiscordCall[]) =>
  calls.filter((c) => c.method === "PUT" && c.path.endsWith("/members/42"));

async function startJoin(e: Env) {
  const res = await app.request("/join/discord", {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res) };
}

// Follow a redirect chain manually (the test client never follows): fail on a
// repeated Location (loop) and on a chain that does not terminate.
async function followRedirects(e: Env, res: Response, cookie: string) {
  const seen: string[] = [];
  let current = res;
  while (current.status >= 300 && current.status < 400) {
    const location = current.headers.get("location");
    expect(location, "redirect without a Location header").toBeTruthy();
    expect(seen, `redirect loop: ${location} visited twice`).not.toContain(location);
    seen.push(location!);
    expect(seen.length, "redirect chain did not terminate (loop)").toBeLessThanOrEqual(3);
    current = await app.request(location!, cookie ? { headers: { cookie } } : {}, e);
  }
  return current;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("store-down join start surfaces a visible explanation on /join", () => {
  async function expectStoreDownExplanation(poison: (store: Store) => void) {
    const { store, env: e } = isolated();
    poison(store);
    const res = await app.request("/join/discord", {}, e);
    // The degrade itself is unchanged: 302 to the journey page (a notice query
    // still lands on /join), uncacheable, minting no journey.
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.split("?")[0]).toBe("/join");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.getSetCookie().join("\n")).not.toMatch(/__Host-two_join_state=[^;]/);

    // The landing terminates (no loop) on a rendered page that EXPLAINS the
    // failed start and keeps the one-click retry: visibly different from the
    // plain /join render under the same bindings.
    const landing = await followRedirects(e, res, cookiesFrom(res));
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");
    const html = await landing.text();
    expect(html).toMatch(START_FAILURE_WORDS);
    expect(html).toContain('href="/join/discord"');
    const plain = await (await app.request("/join", {}, e)).text();
    expect(html).not.toBe(plain);
  }

  it("names the failed start when sweeping expired journeys throws", async () => {
    await expectStoreDownExplanation((store) => {
      store.journeys.sweepExpired = async () => {
        throw new Error("journey store down");
      };
    });
  });

  it("names the failed start when issuing the journey throws", async () => {
    await expectStoreDownExplanation((store) => {
      store.journeys.issue = async () => {
        throw new Error("journey store down");
      };
    });
  });

  it("names the failed start when issuing the journey is refused", async () => {
    await expectStoreDownExplanation((store) => {
      store.journeys.issue = async () => false;
    });
  });
});

describe("unadmitted access_denied renders cancelled-consent copy", () => {
  async function expectCancelledRecovery(res: Response, calls: DiscordCall[]) {
    expect(res.status).toBe(200);
    const html = await res.text();
    // The same cancelled-consent copy as the admitted denial — and never the
    // expiry sentence, which blames a ten-minute clock for a Cancel click.
    expect(html).toContain("Join cancelled");
    expect(html).toContain("You cancelled the Discord approval");
    expect(html).not.toContain("Join link expired");
    expect(html).not.toContain("Approvals last ten minutes");
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain('data-testid="recovery-invite"');
    expect(html).toContain("https://discord.gg/invite");
    expect(html).not.toContain(DESCRIPTION_SECRET);
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(calls).toHaveLength(0);
  }

  it("forged state with access_denied renders cancelled copy, never expiry", async () => {
    const { env: e } = isolated();
    const calls = stubDiscord();
    const start = await startJoin(e);
    const res = await app.request(
      `/join/callback?error=access_denied&error_description=${DESCRIPTION_SECRET}&state=forged-callback-state`,
      { headers: { cookie: start.cookie } },
      e,
    );
    await expectCancelledRecovery(res, calls);
  });

  it("stray callback without cookies with access_denied renders cancelled copy", async () => {
    const { env: e } = isolated();
    const calls = stubDiscord();
    const res = await app.request(
      `/join/callback?error=access_denied&error_description=${DESCRIPTION_SECRET}&state=stray-state`,
      {},
      e,
    );
    await expectCancelledRecovery(res, calls);
  });

  it("control: forged state WITHOUT an error keeps the expiry copy", async () => {
    const { env: e } = isolated();
    stubDiscord();
    const start = await startJoin(e);
    const res = await app.request(
      "/join/callback?code=abc&state=forged-callback-state",
      { headers: { cookie: start.cookie } },
      e,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join link expired");
    expect(html).toContain("Approvals last ten minutes");
    expect(html).not.toContain("Join cancelled");
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain("https://discord.gg/invite");
  });
});

describe("rate-limited bot add answers 503 with throttle copy", () => {
  const botAnswer =
    (status: number, retryAfter?: string, body: unknown = { message: PROVIDER_MARKER }) =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      });

  async function joinCallback(e: Env, put: Answer) {
    const calls = stubDiscord({ put });
    const start = await startJoin(e);
    const res = await app.request(
      `/join/callback?code=abc&state=${start.state}`,
      { headers: { cookie: start.cookie } },
      e,
    );
    return { res, calls };
  }

  async function expectThrottleRecovery(res: Response, retryAfter: string | null) {
    // Status, header and copy agree: 503 (honored by clients and caches),
    // the bounded provider backoff, and copy that names throttling.
    expect(res.status).toBe(503);
    const header = res.headers.get("retry-after");
    expect(header).toBe(retryAfter);
    if (header !== null) expect(header).toMatch(/^\d+$/);
    const html = await res.text();
    expect(html).toMatch(THROTTLE_WORDS);
    expect(html).not.toContain("Discord is unreachable");
    expect(html).not.toContain(PROVIDER_MARKER);
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain('data-testid="recovery-invite"');
    expect(html).toContain("https://discord.gg/invite");
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    return html;
  }

  it("PUT 429 with backoff: 503 + Retry-After + throttle copy + rate_limited attempt", async () => {
    const { fake, env: e } = isolated();
    const { res, calls } = await joinCallback(e, botAnswer(429, "37"));
    await expectThrottleRecovery(res, "37");
    expect(fake.attempts).toEqual([
      { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
    ]);
    // Neither journey retries the add: exactly one PUT.
    expect(putsOf(calls)).toHaveLength(1);
  });

  it("PUT 429 without a usable backoff: 503 + throttle copy, no header, still distinct", async () => {
    const { fake, env: e } = isolated();
    const { res } = await joinCallback(e, botAnswer(429));
    await expectThrottleRecovery(res, null);
    expect(fake.attempts).toEqual([
      { outcome: "rate_limited", source: null, requestId: null, discordId: "42" },
    ]);
  });

  it("status governs: PUT 429 with a forbidden-class body is still throttled", async () => {
    const { fake, env: e } = isolated();
    const { res } = await joinCallback(
      e,
      botAnswer(429, "37", { code: 50001, message: "Missing Access" }),
    );
    await expectThrottleRecovery(res, "37");
    expect(fake.attempts.map((a) => a.outcome)).toEqual(["rate_limited"]);
  });

  it("control: PUT 403 carrying retry-after keeps 200 forbidden copy, headerless, degraded", async () => {
    const { fake, env: e } = isolated();
    const { res } = await joinCallback(e, botAnswer(403, "37"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).not.toMatch(THROTTLE_WORDS);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(fake.attempts).toEqual([
      { outcome: "degraded", source: null, requestId: null, discordId: "42" },
    ]);
  });
});

describe("exchange 429 names throttling instead of unreachable", () => {
  const tokenAnswer =
    (status: number, retryAfter?: string, body: unknown = {}) =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      });

  async function exchangeCallback(e: Env, token: Answer, user?: Answer) {
    const calls = stubDiscord(user === undefined ? { token } : { token, user });
    const start = await startJoin(e);
    const res = await app.request(
      `/join/callback?code=abc&state=${start.state}`,
      { headers: { cookie: start.cookie } },
      e,
    );
    return { res, calls };
  }

  async function expectExchangeThrottle(
    res: Response,
    calls: DiscordCall[],
    expected: { retryAfter: string; legs: string[] },
  ) {
    // The throttle truth, end to end: 503 + the forwarded backoff + copy that
    // names throttling — never "unreachable", never the expired copy, never a
    // provider byte. The attempt row keeps today's error outcome.
    expect(res.status).toBe(503);
    const header = res.headers.get("retry-after");
    expect(header).toBe(expected.retryAfter);
    expect(header).toMatch(/^\d+$/);
    const html = await res.text();
    expect(html).toMatch(THROTTLE_WORDS);
    expect(html).not.toContain("unreachable");
    expect(html).not.toContain("expired");
    expect(html).not.toContain(PROVIDER_MARKER);
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain('data-testid="recovery-invite"');
    expect(html).toContain("https://discord.gg/invite");
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(calls.map((c) => c.path)).toEqual(expected.legs);
    return html;
  }

  it("token 429 with backoff: 503 + Retry-After + throttle copy, error attempt", async () => {
    const { fake, env: e } = isolated();
    const { res, calls } = await exchangeCallback(
      e,
      tokenAnswer(429, "45", { message: PROVIDER_MARKER, retry_after: 77 }),
    );
    await expectExchangeThrottle(res, calls, {
      retryAfter: "45",
      legs: ["/api/v10/oauth2/token"],
    });
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });

  it("status governs: token 429 with an invalid_grant body is still throttled", async () => {
    const { fake, env: e } = isolated();
    const { res, calls } = await exchangeCallback(
      e,
      tokenAnswer(429, "45", { error: "invalid_grant" }),
    );
    await expectExchangeThrottle(res, calls, {
      retryAfter: "45",
      legs: ["/api/v10/oauth2/token"],
    });
    expect(fake.attempts.map((a) => a.outcome)).toEqual(["error"]);
  });

  it("user-fetch 429 carries the same throttle truth with its own backoff", async () => {
    const { fake, env: e } = isolated();
    const { res, calls } = await exchangeCallback(
      e,
      async () => Response.json({ access_token: "fixture-access-token" }),
      tokenAnswer(429, "45", { message: PROVIDER_MARKER, retry_after: 77 }),
    );
    await expectExchangeThrottle(res, calls, {
      retryAfter: "45",
      legs: ["/api/v10/oauth2/token", "/api/v10/users/@me"],
    });
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });

  it("control: token 503 with an invalid_grant body keeps the outage copy", async () => {
    const { fake, env: e } = isolated();
    const { res, calls } = await exchangeCallback(
      e,
      tokenAnswer(503, "120", { error: "invalid_grant" }),
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(html).not.toMatch(THROTTLE_WORDS);
    expect(html).not.toContain("Join approval expired");
    // A 5xx backoff is never forwarded, even when the provider sent one.
    expect(res.headers.get("retry-after")).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(["/api/v10/oauth2/token"]);
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });
});
