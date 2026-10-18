// route-inventory: GET /join/callback
// Acceptance: Discord's own 429 backoff reaches the join recovery response.
//
// When Discord rate-limits the OAuth token exchange (or the user fetch that
// follows it), the join callback renders the 503 "Discord is unreachable"
// recovery page. Discord sends its backoff as a `retry-after` response
// header; that bounded numeric value must flow through to a `Retry-After`
// header on the 503 recovery response, so browsers and intermediaries honour
// the provider's wait instead of hammering a rate-limited endpoint.
//
// Pinned contract (header only — status and copy never change):
//   - numeric provider values are emitted as integer delta-seconds, rounded
//     UP (never tell the client to retry sooner than the provider asked;
//     same admission posture as src/jobs/retry-delay.ts), minimum 1;
//   - values are ceiling-bounded at 86400 s (24 h, the largest retry delay
//     admitted anywhere in this codebase) — a representable but absurd
//     provider value is capped, never echoed raw;
//   - the provider value is parsed with the same numeric-only style as
//     src/events/discord-transients-live.ts (trimmed digits with an optional
//     fraction, finite and representable): HTTP-dates, signs, exponents,
//     units, empty and unrepresentable values are not usable backoff;
//   - absent or unusable provider backoff falls back to today's behaviour:
//     the same 503 recovery page with NO `Retry-After` header (never "0",
//     never a raw provider string, never a value mined from the error body);
//   - non-429 failure paths and the success path are unchanged and never
//     gain a `Retry-After` header, even if the provider sent one.
//
// Mounted-app suite with local fixtures only: the global fetch is stubbed,
// no live Discord, no database, no credentials beyond inert fixtures.
import { afterEach, describe, expect, it, vi } from "vitest";
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

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the join journey. Mirrors
// test/oauth-exchange-outcomes.test.ts: the throttle bucket never fills,
// attempts record the four safe columns.
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
  const create = vi.spyOn(store, "create");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { store, fake, create, env: e };
}

type Answer = () => Response | Promise<Response>;

// Stub the token exchange; any later Discord call is a test failure.
function stubTokenExchange(answer: Answer) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) return answer();
      throw new Error(`no Discord request allowed after a rejected exchange: ${url}`);
    }),
  );
  return calls;
}

// Token succeeds; the user fetch answers instead (e.g. its own 429).
function stubTokenThenUser(userAnswer: Answer) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "fixture-access" });
      if (url.endsWith("/users/@me")) return userAnswer();
      throw new Error(`unexpected Discord request: ${url}`);
    }),
  );
  return calls;
}

// Full success stub: token -> user -> PUT member -> GET roles.
function stubSuccess() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "fixture-access" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

// A provider 429 whose body must never be echoed or mined: it carries a
// marker string and a body-level retry_after that is NOT the header value.
const PROVIDER_MARKER = "provider-marker-do-not-echo";
const rateLimited = (retryAfter?: string) =>
  new Response(JSON.stringify({ message: PROVIDER_MARKER, retry_after: 77, global: true }), {
    status: 429,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });

async function joinCallback(e: Env) {
  const start = await app.request("/join/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return app.request(
    `/join/callback?code=abc&state=${state}`,
    { headers: { cookie: cookiesFrom(start) } },
    e,
  );
}

// The recovery page every provider-failure case below must keep, verbatim.
async function expectUnreachableRecovery(res: Response) {
  expect(res.status).toBe(503);
  const html = await res.text();
  expect(html).toContain("Discord is unreachable");
  expect(html).toContain("reach Discord to complete the join");
  expect(html).toContain("Try again in a moment, or use the invite link below.");
  expect(html).toContain('href="/join/discord"');
  expect(html).toContain("https://discord.gg/invite");
  expect(html).not.toContain("Join approval expired");
  expect(html).not.toContain("Join link expired");
  expect(html).not.toContain(PROVIDER_MARKER);
  expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
  return html;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord 429 backoff reaches the join recovery response", () => {
  it.each([
    ["120", "120"],
    ["1", "1"],
    ["86400", "86400"],
    // Fractional provider values round UP: never retry sooner than asked.
    ["2.5", "3"],
    ["0.4", "1"],
  ])(
    "token 429 with retry-after %s emits Retry-After: %s on the 503 recovery page",
    async (provider, expected) => {
      const { fake, create, env: e } = isolated();
      const calls = stubTokenExchange(() => rateLimited(provider));
      const res = await joinCallback(e);
      await expectUnreachableRecovery(res);
      expect(res.headers.get("retry-after")).toBe(expected);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(calls).toEqual(["/api/v10/oauth2/token"]);
      expect(create).not.toHaveBeenCalled();
      const requestId = res.headers.get("x-request-id");
      expect(fake.attempts).toEqual([
        { outcome: "error", source: null, requestId, discordId: null },
      ]);
    },
  );

  it("caps an absurd but representable provider value at the 86400s ceiling", async () => {
    const { env: e } = isolated();
    stubTokenExchange(() => rateLimited("999999999"));
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    const header = res.headers.get("retry-after");
    expect(header).not.toBeNull();
    expect(header).toMatch(/^\d+$/);
    expect(Number(header)).toBeGreaterThanOrEqual(1);
    expect(Number(header)).toBeLessThanOrEqual(86400);
    expect(header).not.toBe("999999999");
  });

  it("plumbs backoff from a 429 on the user fetch, not only the token exchange", async () => {
    const { fake, create, env: e } = isolated();
    const calls = stubTokenThenUser(() => rateLimited("45"));
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    expect(res.headers.get("retry-after")).toBe("45");
    expect(calls).toEqual(["/api/v10/oauth2/token", "/api/v10/users/@me"]);
    expect(create).not.toHaveBeenCalled();
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });
});

describe("absent or unusable provider backoff falls back to today's response", () => {
  it("429 without a retry-after header: 503 recovery page, no Retry-After", async () => {
    const { fake, env: e } = isolated();
    stubTokenExchange(() => rateLimited());
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    // The body's own retry_after (77) is never mined as a substitute.
    expect(res.headers.get("retry-after")).toBeNull();
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });

  it.each([
    ["HTTP-date", "Wed, 21 Oct 2015 07:28:00 GMT"],
    ["non-numeric", "abc"],
    ["negative", "-5"],
    ["exponent", "1e3"],
    ["units", "12 seconds"],
    ["empty", ""],
    ["unrepresentable magnitude", "999999999999999999999999"],
    ["markup-flavoured", '60"><script>alert(1)</script>'],
  ])("429 with malformed retry-after (%s): no header, value never echoed", async (_name, raw) => {
    const { env: e } = isolated();
    stubTokenExchange(() => rateLimited(raw));
    const res = await joinCallback(e);
    const html = await expectUnreachableRecovery(res);
    expect(res.headers.get("retry-after")).toBeNull();
    if (raw) expect(html).not.toContain(raw);
  });

  it('429 with retry-after "0" never emits Retry-After: 0', async () => {
    const { env: e } = isolated();
    stubTokenExchange(() => rateLimited("0"));
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    const header = res.headers.get("retry-after");
    expect(header === null || (/^\d+$/.test(header) && Number(header) >= 1)).toBe(true);
  });
});

describe("non-429 paths are unchanged and never gain Retry-After", () => {
  it("provider 503 carrying retry-after: still 503 recovery, header not forwarded", async () => {
    const { env: e } = isolated();
    stubTokenExchange(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 503,
          headers: { "retry-after": "120" },
        }),
    );
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("transport failure: 503 recovery, no Retry-After", async () => {
    const { env: e } = isolated();
    stubTokenExchange(() => Promise.reject(new TypeError("fetch failed")));
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("400 invalid_client carrying retry-after: 503 recovery, header not forwarded", async () => {
    const { env: e } = isolated();
    stubTokenExchange(
      () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 400,
          headers: { "retry-after": "120" },
        }),
    );
    const res = await joinCallback(e);
    await expectUnreachableRecovery(res);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("400 invalid_grant carrying retry-after: expired page unchanged, no Retry-After", async () => {
    const { fake, env: e } = isolated();
    stubTokenExchange(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "retry-after": "120" },
        }),
    );
    const res = await joinCallback(e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join approval expired");
    expect(html).toContain("That Discord approval expired");
    expect(html).not.toContain("Discord is unreachable");
    expect(res.headers.get("retry-after")).toBeNull();
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
  });

  it("successful join: redirect unchanged, no Retry-After", async () => {
    const { create, env: e } = isolated();
    stubSuccess();
    const res = await joinCallback(e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
