/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { registerJoinRoutes } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Acceptance oracle: denied/error join attempts must be joinable to request
// logs. Every early-failure callback path that persists a join_attempts row
// (denied or errored OAuth approval, an admitted journey that returns
// without a code, and a failed token exchange / user fetch) must record the
// validated request ID carried in the request context — the same ID the
// response echoes as x-request-id — instead of null. Raw client headers are
// never the source: a caller-supplied x-request-id is ignored, and when no
// middleware has validated an ID into the context the row records null (no
// fabricated IDs, no request failure).
//
// Pre-fix failure mode: the early-failure recordAttempt calls hardcode
// requestId: null, so the funnel rows operators need most — the failures —
// cannot be joined to request logs. Hermetic fixtures only: in-memory Sql
// and session doubles, stubbed Discord fetch, no live OAuth or database.

const MOD_ROLE = "1546777856984481792";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

// Distinct validated Ray IDs per phase: the start request's ID must never
// leak into the callback's row, and vice versa.
const START_RAY = "aaaa0000bbbb1111-LHR";
const CLIENT_FORGED = "client-controlled-request-id";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the journey's statements (same shape as
// test/join.test.ts): the throttle bucket never fills, attempts record
// exactly the values handed to the INSERT, verbatim — undefined stays
// undefined so a missing null normalization cannot hide.
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

type Fake = ReturnType<typeof fakeSql>;

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

const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof Request ? input.url : input.href;

/** Discord stub for paths that must never reach Discord. */
function stubNoDiscord() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(urlOf(input));
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

/** Discord stub answering only the token exchange (and optionally @me). */
function stubExchange(answer: () => Response, userAnswer?: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) return answer();
      if (url.endsWith("/users/@me") && userAnswer) return userAnswer();
      throw new Error(`no Discord request allowed after a failed exchange: ${url}`);
    }),
  );
  return calls;
}

async function startJoin(e: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, { headers: { "cf-ray": START_RAY } }, e);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res) };
}

/** Callback under a known validated Ray ID, plus a forged client header. */
function callbackAs(e: Env, path: string, cookie: string, ray: string) {
  return app.request(
    path,
    { headers: { cookie, "cf-ray": ray, "x-request-id": CLIENT_FORGED } },
    e,
  );
}

/** The persisted row carries the callback context's ID, nothing else. */
function expectAttemptWithRequestId(fake: Fake, res: Response, expected: Fake["attempts"][number]) {
  expect(fake.attempts).toEqual([expected]);
  expect(res.headers.get("x-request-id")).toBe(expected.requestId);
  expect(expected.requestId).not.toBe(START_RAY);
  expect(expected.requestId).not.toBe(CLIENT_FORGED);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("denied/error join attempts record the context request ID", () => {
  it("denied consent (error=access_denied) records the callback request ID", async () => {
    const ray = "0123456789abcdef-LHR";
    const { fake, env: e } = isolated();
    const calls = stubNoDiscord();
    const { state, cookie } = await startJoin(e, "?source=web-homepage&next=/events");
    const res = await callbackAs(
      e,
      `/join/callback?error=access_denied&error_description=never-echo&state=${state}`,
      cookie,
      ray,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expectAttemptWithRequestId(fake, res, {
      outcome: "denied",
      source: "web-homepage",
      requestId: ray,
      discordId: null,
    });
  });

  it("a non-denied OAuth error records the callback request ID", async () => {
    const ray = "fedcba9876543210-FRA";
    const { fake, env: e } = isolated();
    const calls = stubNoDiscord();
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await callbackAs(
      e,
      `/join/callback?error=server_error&state=${state}`,
      cookie,
      ray,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expectAttemptWithRequestId(fake, res, {
      outcome: "denied",
      source: "web-homepage",
      requestId: ray,
      discordId: null,
    });
  });

  it("an admitted journey returning without a code records the callback request ID", async () => {
    const ray = "1111222233334444-AMS";
    const { fake, env: e } = isolated();
    const calls = stubNoDiscord();
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await callbackAs(e, `/join/callback?state=${state}`, cookie, ray);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expectAttemptWithRequestId(fake, res, {
      outcome: "error",
      source: "web-homepage",
      requestId: ray,
      discordId: null,
    });
  });

  it("an expired grant (400 invalid_grant) records the callback request ID", async () => {
    const ray = "5555666677778888-CDG";
    const { fake, env: e } = isolated();
    const calls = stubExchange(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    const { state, cookie } = await startJoin(e);
    const res = await callbackAs(e, `/join/callback?code=abc&state=${state}`, cookie, ray);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toContain("Join approval expired");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expectAttemptWithRequestId(fake, res, {
      outcome: "error",
      source: null,
      requestId: ray,
      discordId: null,
    });
  });

  it("a provider outage during exchange records the callback request ID", async () => {
    const ray = "9999aaaabbbbcccc-ZRH";
    const { fake, env: e } = isolated();
    const calls = stubExchange(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 503 }),
    );
    const { state, cookie } = await startJoin(e);
    const res = await callbackAs(e, `/join/callback?code=abc&state=${state}`, cookie, ray);
    expect(res.status).toBe(503);
    expect(await res.clone().text()).toContain("Discord is unreachable");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expectAttemptWithRequestId(fake, res, {
      outcome: "error",
      source: null,
      requestId: ray,
      discordId: null,
    });
  });

  it("a failed user fetch after exchange records the callback request ID", async () => {
    const ray = "ddddeeee00001111-MAD";
    const { fake, env: e } = isolated();
    const calls = stubExchange(
      () => Response.json({ access_token: "fixture-access" }),
      () => new Response("down", { status: 500 }),
    );
    const { state, cookie } = await startJoin(e);
    const res = await callbackAs(e, `/join/callback?code=abc&state=${state}`, cookie, ray);
    expect(res.status).toBe(503);
    expect(calls).toEqual(["/api/v10/oauth2/token", "/api/v10/users/@me"]);
    expectAttemptWithRequestId(fake, res, {
      outcome: "error",
      source: null,
      requestId: ray,
      discordId: null,
    });
  });

  it("without a Ray ID the row carries the generated context ID the response echoes", async () => {
    const { fake, env: e } = isolated();
    stubNoDiscord();
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await app.request(
      `/join/callback?error=access_denied&state=${state}`,
      { headers: { cookie, "x-request-id": CLIENT_FORGED } },
      e,
    );
    expect(res.status).toBe(200);
    const echoed = res.headers.get("x-request-id");
    expect(echoed).toMatch(ULID);
    expect(echoed).not.toBe(CLIENT_FORGED);
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: "web-homepage", requestId: echoed, discordId: null },
    ]);
  });
});

describe("missing request-ID context still records null", () => {
  it("a join mount without the request-ID middleware records null and never fails", async () => {
    // The bare mount registers only the join routes: nothing validates a
    // Ray ID / ULID into the context, so there is no context ID to record.
    // Raw caller headers (cf-ray, x-request-id) must not be fabricated into
    // one; the row records exactly null and the recovery page still renders.
    const fake = fakeSql();
    const store = createMemorySessionStore();
    let sessionsIssued = 0;
    const router = new Hono<{ Bindings: Env }>();
    registerJoinRoutes(
      router,
      {
        storeFor: async () => store,
        issueSession: async () => {
          sessionsIssued++;
        },
      },
      {
        joinPage: (c) => c.text("join page"),
        recovery: (c, props, status = 200) => c.text(props.title, status),
      },
    );
    const e = {
      ...env,
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => fake.sql },
    } as unknown as Env;
    stubNoDiscord();

    const start = await router.request(
      "https://next.example.test/join/discord?source=web-homepage",
      {},
      e,
    );
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    const res = await router.request(
      `https://next.example.test/join/callback?error=access_denied&state=${state}`,
      {
        headers: {
          cookie: cookiesFrom(start),
          "cf-ray": "0123456789abcdef-LHR",
          "x-request-id": CLIENT_FORGED,
        },
      },
      e,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(sessionsIssued).toBe(0);
    expect(fake.attempts).toHaveLength(1);
    expect(fake.attempts[0]).toEqual({
      outcome: "denied",
      source: "web-homepage",
      requestId: null,
      discordId: null,
    });
    // Exactly null — an unnormalized undefined must not slip through.
    expect(fake.attempts[0]!.requestId).toBeNull();
  });
});
