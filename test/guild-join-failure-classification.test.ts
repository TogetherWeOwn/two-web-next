// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// Acceptance: guild bot-add failures are classified by kind and status.
//
// `addGuildMember` (src/discord.ts) used to return "failed" for every
// non-201/204 status and for transport throws alike, so a 429 (slow down),
// a 403 (the bot lacks access/permissions) and a 5xx (Discord outage) were
// indistinguishable downstream. This suite pins the classified contract:
//
//   - 201 -> "joined" and 204 -> "already_member" (unchanged);
//   - 429 -> "rate_limited";
//   - 403 -> "forbidden" (Discord's 50001 Missing Access / 50013 Missing
//     Permissions class; classified by status alone, whatever the body is);
//   - any 5xx -> "provider_outage" (status governs even when the body
//     carries a 50001-class code);
//   - a transport throw (fetch rejects / aborts) -> "transport_failure",
//     never rethrown to the caller;
//   - any other status -> "failed" (the unchanged generic fallback);
//   - a blank/whitespace bot token still fails closed as "failed" with
//     zero outbound calls (unchanged).
//
// Classification values are fixed strings from the set above. Neither a
// token nor any response-body byte may appear in a return value, a log
// line, a rendered page, a redirect, a cookie or a journey row.
//
// Both call sites keep today's member-facing handling for every classified
// failure (no retry policy, no UX change):
//   - the join journey (`liveBotAdd` / `finishJoin` / GET /join/callback)
//     surfaces the classified result through the BotAdd seam and degrades
//     to the same blocked-copy recovery + one "degraded" attempt row;
//   - ordinary login (GET /auth/discord/callback) still signs in as a
//     non-member to /?n=join_failed, and its existing "guild auto-join
//     failed" log line gains the fixed `kind` classification next to
//     `request_id` (never a Discord ID, token or body byte).
//
// Mounted-app + unit suite with local fixtures only: the global fetch is
// stubbed, no live Discord, no database, no credentials beyond inert
// fixtures. The synthetic secrets are asterisk-padded on purpose so they
// stay grep-able without matching any secret scanner.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  captureDiagnosticStream,
  expectDiagnosticStreamClean,
  scanDiagnosticStream,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";
import { addGuildMember, type JoinResult } from "../src/discord";
import type { Env } from "../src/env";
import type { EnvWithJoin } from "../src/join/route";
import { finishJoin, liveBotAdd, type BotAdd } from "../src/join/service";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";

const TOK = "***synthetic-access-7f3a***";
const BOT = "***synthetic-bot-9k2m***";
const SECRET = "***synthetic-secret-4t8z***";

const CLASSIFIED = [
  "joined",
  "already_member",
  "rate_limited",
  "forbidden",
  "provider_outage",
  "transport_failure",
  "failed",
] as const;

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

/** The full diagnostic stream was inspected to the end and holds no marker. */
const logsClean = (logs: DiagnosticRecord[]) => {
  const scan = scanDiagnosticStream(logs, [TOK, BOT, SECRET]);
  expect(scan.incomplete, "every diagnostic value inspected to the end").toEqual([]);
  expect(scan.hits, "marker found in diagnostic stream (labels only)").toEqual([]);
};

/** The records written under one message, marker-free so a diff cannot print a leak. */
const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, BOT, SECRET]) as unknown[],
    }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("addGuildMember classifies failures by kind and status", () => {
  // A marker-bearing provider body: its bytes must never be returned,
  // logged or allowed to reclassify the outcome the status already chose.
  const markerBody = (code: number) =>
    JSON.stringify({ message: `provider detail ${SECRET} for ${TOK}`, code });

  it.each([
    ["201 created", () => new Response(markerBody(0), { status: 201 }), "joined"],
    ["204 already a member", () => new Response(null, { status: 204 }), "already_member"],
    ["429 rate limited", () => new Response(markerBody(0), { status: 429 }), "rate_limited"],
    [
      "403 with a 50001 Missing Access body",
      () => new Response(markerBody(50001), { status: 403 }),
      "forbidden",
    ],
    [
      "403 with a 50013 Missing Permissions body",
      () => new Response(markerBody(50013), { status: 403 }),
      "forbidden",
    ],
    [
      "403 with an unparseable body is still forbidden — status alone classifies",
      () => new Response(`<html>${SECRET}</html>`, { status: 403 }),
      "forbidden",
    ],
    ["403 with no body", () => new Response(null, { status: 403 }), "forbidden"],
    ["500 server error", () => new Response(markerBody(0), { status: 500 }), "provider_outage"],
    ["502 bad gateway", () => new Response(markerBody(0), { status: 502 }), "provider_outage"],
    [
      "503 with a 50001-class body is still an outage — status governs",
      () => new Response(markerBody(50001), { status: 503 }),
      "provider_outage",
    ],
    ["599 edge of the 5xx class", () => new Response(null, { status: 599 }), "provider_outage"],
    [
      "429 with a forbidden-class body is still rate_limited — status governs",
      () => new Response(markerBody(50013), { status: 429 }),
      "rate_limited",
    ],
    [
      "400 bad request keeps the generic fallback",
      () => new Response(markerBody(50035), { status: 400 }),
      "failed",
    ],
    [
      "401 keeps the generic fallback",
      () => new Response(markerBody(0), { status: 401 }),
      "failed",
    ],
    [
      "404 keeps the generic fallback",
      () => new Response(markerBody(10004), { status: 404 }),
      "failed",
    ],
  ] as [string, () => Response, string][])("%s -> %s", async (_name, respond, expected) => {
    const logs = captureDiagnosticStream();
    const fetchFn = vi.fn(async () => respond());
    vi.stubGlobal("fetch", fetchFn);
    const result: string = await addGuildMember("326474832151838730", "42", TOK, BOT);
    expect(result).toBe(expected);
    expect(CLASSIFIED).toContain(result);
    // Classification never retries: exactly one provider call per attempt.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    leakFree(result);
    logsClean(logs);
  });

  it.each([
    [
      "a TypeError whose message quotes the access token",
      () => new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) }),
    ],
    ["a generic transport Error", () => new Error("connection reset")],
    [
      "an abort/deadline-style rejection",
      () => new DOMException("The operation was aborted", "AbortError"),
    ],
  ] as [string, () => Error][])(
    "transport throw (%s) -> transport_failure, never rethrown",
    async (_name, makeError) => {
      const logs = captureDiagnosticStream();
      const fetchFn = vi.fn(async () => {
        throw makeError();
      });
      vi.stubGlobal("fetch", fetchFn);
      const result: string = await addGuildMember("326474832151838730", "42", TOK, BOT);
      expect(result).toBe("transport_failure");
      expect(CLASSIFIED).toContain(result);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      leakFree(result);
      logsClean(logs);
    },
  );

  it.each(["", "   "])(
    "blank bot token (%j) still fails closed: 'failed' with zero outbound calls",
    async (botToken) => {
      const logs = captureDiagnosticStream();
      const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
      vi.stubGlobal("fetch", fetchFn);
      const result: string = await addGuildMember("326474832151838730", "42", TOK, botToken);
      expect(result).toBe("failed");
      expect(fetchFn).not.toHaveBeenCalled();
      logsClean(logs);
    },
  );
});

describe("join journey seam: the classified result reaches finishJoin and degrades", () => {
  it.each([
    [201, "joined"],
    [204, "already_member"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [503, "provider_outage"],
  ] as [number, string][])(
    "liveBotAdd surfaces Discord PUT %i as result %s with no request id",
    async (status, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      const outcome = await liveBotAdd(BOT)("326474832151838730", "42", TOK);
      expect(outcome.requestId).toBeNull();
      expect(outcome.result as string).toBe(expected);
      leakFree(outcome);
    },
  );

  it("liveBotAdd surfaces a transport throw as transport_failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`failed sending ${TOK}`);
      }),
    );
    const outcome = await liveBotAdd(BOT)("326474832151838730", "42", TOK);
    expect(outcome).toEqual({ result: "transport_failure", requestId: null });
    leakFree(outcome);
  });

  const botReturning = (result: string, requestId: string | null = null): BotAdd =>
    (async () => ({ result: result as JoinResult, requestId })) as BotAdd;

  it.each(["rate_limited", "forbidden", "provider_outage", "transport_failure", "failed"])(
    "finishJoin degrades (never throws, never signs in) on classified failure %s",
    async (classified) => {
      await expect(
        finishJoin(botReturning(classified, "req-7"), "g", "u", TOK, null),
      ).resolves.toEqual({
        kind: "recoverable",
        outcome: "degraded",
        requestId: "req-7",
      });
    },
  );

  it("finishJoin success semantics are unchanged", async () => {
    await expect(finishJoin(botReturning("joined"), "g", "u", TOK, null)).resolves.toMatchObject({
      kind: "signed_in",
      outcome: "added",
      redirect: "/?n=joined",
    });
    await expect(
      finishJoin(botReturning("already_member"), "g", "u", TOK, null),
    ).resolves.toMatchObject({
      kind: "signed_in",
      outcome: "already_member",
      redirect: "/?n=already_member",
    });
  });
});

// In-memory Sql double for the journey's two statements. Mirrors
// test/join-blocked-copy.test.ts; anything else is a test bug.
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

const markerPut =
  (status: number, code = 0): PutAnswer =>
  async () =>
    new Response(JSON.stringify({ message: `provider detail ${SECRET} for ${TOK}`, code }), {
      status,
    });

describe("join callback handling: every classified failure degrades exactly like 'failed' does today", () => {
  function isolated() {
    const fake = fakeSql();
    const store = createMemorySessionStore();
    const e = {
      ...env,
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => fake.sql },
    } as unknown as EnvWithJoin;
    return { fake, env: e as Env };
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

  it.each([
    ["403 forbidden (50001 body)", markerPut(403, 50001)],
    ["429 rate_limited", markerPut(429)],
    ["500 provider_outage", markerPut(500)],
    ["503 provider_outage", markerPut(503)],
    [
      "transport throw quoting the token",
      (async () => {
        throw new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
      }) as PutAnswer,
    ],
  ] as [string, PutAnswer][])(
    "PUT %s: 200 blocked-copy recovery, no session, one degraded attempt, one PUT, clean stream",
    async (_name, putAnswer) => {
      const { fake, env: e } = isolated();
      const { logs, calls, res, html } = await joinRoundTrip(e, putAnswer);
      expect(res.status).toBe(200);
      expect(html).toContain("We couldn&#39;t add you automatically");
      expect(html).toContain('data-testid="recovery-invite"');
      expect(html).toContain("https://discord.gg/invite");
      expect(html).not.toContain("Discord is unreachable");
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
      expect(fake.attempts).toEqual([
        { outcome: "degraded", source: null, requestId: null, discordId: "42" },
      ]);
      expect(putsOf(calls)).toHaveLength(1);
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], { request: "/join/callback" });
      leakFree(html, fake.attempts, [...res.headers], res.headers.getSetCookie());
    },
  );

  it.each([
    [201, "/?n=joined", "added"],
    [204, "/?n=already_member", "already_member"],
  ] as [number, string, string][])(
    "PUT %i success control: redirect %s, session issued, attempt %s",
    async (status, location, outcome) => {
      const { fake, env: e } = isolated();
      const { logs, calls, res } = await joinRoundTrip(
        e,
        async () => new Response(null, { status }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
      expect(fake.attempts).toEqual([{ outcome, source: null, requestId: null, discordId: "42" }]);
      expect(putsOf(calls)).toHaveLength(1);
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], { request: "/join/callback" });
      leakFree(fake.attempts, res.headers.get("location"));
    },
  );
});

describe("login callback handling: classified auto-join failures sign in as non-member and log the kind", () => {
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
    ["403 forbidden (50001 body)", markerPut(403, 50001), "forbidden"],
    ["429 rate_limited", markerPut(429), "rate_limited"],
    ["500 provider_outage", markerPut(500), "provider_outage"],
    ["503 provider_outage", markerPut(503), "provider_outage"],
    [
      "transport throw quoting the token",
      (async () => {
        throw new TypeError(`failed sending ${TOK}`, { cause: new Error(`nested ${SECRET}`) });
      }) as PutAnswer,
      "transport_failure",
    ],
  ] as [string, PutAnswer, string][])(
    "PUT %s: /?n=join_failed, non-member session, one PUT, 'guild auto-join failed' logs kind %s",
    async (_name, putAnswer, kind) => {
      const { store, logs, calls, res } = await loginRoundTrip(putAnswer);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?n=join_failed");
      expect(await sessionRowOf(store, res)).toMatchObject({
        userId: "42",
        member: false,
        moderator: false,
      });
      expect(putsOf(calls)).toHaveLength(1);
      const joinLine = recordsFor(logs, "guild auto-join failed");
      expect(joinLine).toHaveLength(1);
      expect(joinLine[0]!.args[1]).toMatchObject({
        request_id: res.headers.get("x-request-id"),
        kind,
      });
      expect(CLASSIFIED).toContain(
        (joinLine[0]!.args[1] as { kind?: string }).kind as (typeof CLASSIFIED)[number],
      );
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], {
        request: "/auth/discord/callback",
        messages: ["guild auto-join failed"],
      });
      leakFree(joinLine, res.headers.get("location"), res.headers.getSetCookie());
    },
  );

  it.each([
    [201, "/?n=joined"],
    [204, "/?n=already_member"],
  ] as [number, string][])(
    "PUT %i success control: redirect %s and no auto-join failure log",
    async (status, location) => {
      const { logs, calls, res } = await loginRoundTrip(async () => new Response(null, { status }));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
      expect(recordsFor(logs, "guild auto-join failed")).toHaveLength(0);
      expect(putsOf(calls)).toHaveLength(1);
      expectDiagnosticStreamClean(logs, [TOK, BOT, SECRET], {
        request: "/auth/discord/callback",
      });
      leakFree(res.headers.get("location"));
    },
  );
});
