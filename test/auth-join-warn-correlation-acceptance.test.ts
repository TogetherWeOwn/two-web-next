// Acceptance: login and join failure warns carry correlation IDs.
// Covers the five remaining unjoinable lines after the attempt-write (#1193),
// widget (#1196) and moderator-recompute (#1189) warn-correlation slices.
//   - sign-in warn gains request_id
//   - auto-join warn gains guild_id (request_id already present)
//   - the three join-callback warns gain the validated request_id
// Redaction is unchanged: class/kind/status/source/outcome only, never a
// message, body, token, Discord ID or secret.
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
import type { Sql } from "../src/sessions";
import type { Env } from "../src/env";
import type { EnvWithJoin } from "../src/join/route";

const TOK = "***synthetic-access-7f3a***";
const SECRET = "***synthetic-secret-4t8z***";
const GUILD_A = "326474832151838730";
const GUILD_B = "999999999999999999";
const USER_ID = "987654321098765432";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD_A,
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
const AUTOJOIN_LOG = "guild auto-join failed";
const JOIN_ROUTE = "/join/callback";
const LOGIN_ROUTE = "/auth/discord/callback";

const streamClean = (logs: DiagnosticRecord[], request: string, messages: string[] = []) =>
  expectDiagnosticStreamClean(logs, [TOK, SECRET], { request, messages });

const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, SECRET]) as unknown[],
    }));

const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text.includes(TOK), "synthetic token on a readable surface").toBe(false);
  expect(text.includes(SECRET), "synthetic secret on a readable surface").toBe(false);
  expect(text.includes(USER_ID), "Discord ID on a warn surface").toBe(false);
};

function fakeSql() {
  const attempts: Record<string, unknown>[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
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

function isolatedJoin(envOverride: Partial<Env> = {}) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...baseEnv,
    ...envOverride,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as EnvWithJoin;
  return { fake, env: e as Env };
}

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

async function joinRoundTrip(e: Env, handler: (url: string) => Response | Promise<Response>) {
  const logs = captureDiagnosticStream();
  const calls = stubFetch(handler);
  const start = await app.request("/join/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await app.request(
    `/join/callback?code=abc&state=${state}`,
    { headers: { cookie: cookiesFrom(start) } },
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
    { headers: { cookie: cookiesFrom(start) } },
    e,
  );
  return { logs, calls, res };
}

const invalidGrant = (status: number) =>
  new Response(
    JSON.stringify({ error: "invalid_grant", error_description: `refresh ${TOK} revoked` }),
    { status },
  );

function stubSignInDiscord(putStatus = 201, guildId = GUILD_A) {
  void guildId;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOK });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: USER_ID, username: "rick", global_name: "Rick", avatar: null });
      if (url.includes(`/members/${USER_ID}`) && method === "PUT")
        return new Response(null, { status: putStatus });
      if (url.includes(`/members/${USER_ID}`))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth/join failure warns carry correlation IDs", () => {
  it("sign-in warn gains request_id and stays secret-free", async () => {
    const { env: e } = isolatedJoin();
    const { logs, res } = await loginRoundTrip(e, () => invalidGrant(400));
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    const line = recordsFor(logs, LOGIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.args[1]).toEqual({
      exception: "DiscordError",
      kind: "expired_grant",
      status: 400,
      request_id: res.headers.get("x-request-id"),
    });
    streamClean(logs, LOGIN_ROUTE, [LOGIN_LOG]);
    leakFree(line, res.headers.get("location"));
  });

  it("auto-join warn gains guild_id next to request_id and kind", async () => {
    const store = createMemorySessionStore();
    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(500);
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    const line = recordsFor(logs, AUTOJOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.args[1]).toEqual({
      request_id: res.headers.get("x-request-id"),
      guild_id: GUILD_A,
      kind: "provider_outage",
    });
    streamClean(logs, LOGIN_ROUTE, [AUTOJOIN_LOG]);
    leakFree(line, res.headers.get("location"), res.headers.getSetCookie());
  });

  it("auto-join warn carries the guild actually used, not a fixed value", async () => {
    const store = createMemorySessionStore();
    const e = { ...baseEnv, DISCORD_GUILD_ID: GUILD_B, SESSION_STORE: store } as Env;
    const logs = captureDiagnosticStream();
    stubSignInDiscord(500);
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    const line = recordsFor(logs, AUTOJOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.args[1]).toEqual({
      request_id: res.headers.get("x-request-id"),
      guild_id: GUILD_B,
      kind: "provider_outage",
    });
    expect(JSON.stringify(line)).not.toContain(GUILD_A);
    streamClean(logs, LOGIN_ROUTE, [AUTOJOIN_LOG]);
    leakFree(line);
  });

  it("join oversized-params warn gains the validated request_id", async () => {
    const { env: e } = isolatedJoin();
    const logs = captureDiagnosticStream();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const oversized = "x".repeat(3000);
    const res = await app.request(`/join/callback?code=${oversized}&state=abc`, {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(recordsFor(logs, JOIN_LOG).map((r) => r.args)).toEqual([
      [
        JOIN_LOG,
        {
          exception: "InvalidState",
          source: null,
          outcome: "expired",
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    expect(calls).toHaveLength(0);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(recordsFor(logs, JOIN_LOG));
  });

  it("join lost-state warn gains the validated request_id", async () => {
    const { env: e } = isolatedJoin();
    const logs = captureDiagnosticStream();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const res = await app.request("/join/callback?code=abc&state=forged", {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(recordsFor(logs, JOIN_LOG).map((r) => r.args)).toEqual([
      [
        JOIN_LOG,
        {
          exception: "InvalidState",
          source: null,
          outcome: "expired",
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    expect(calls).toHaveLength(0);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(recordsFor(logs, JOIN_LOG));
  });

  it("join exchange-failure warn gains the validated request_id", async () => {
    const { fake, env: e } = isolatedJoin();
    const { logs, res, html } = await joinRoundTrip(e, () => invalidGrant(400));
    expect(res.status).toBe(200);
    expect(html).toContain("Join approval expired");
    expect(recordsFor(logs, JOIN_LOG).map((r) => r.args)).toEqual([
      [
        JOIN_LOG,
        {
          exception: "DiscordError",
          kind: "expired_grant",
          status: 400,
          source: null,
          outcome: "expired",
          request_id: res.headers.get("x-request-id"),
        },
      ],
    ]);
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([{ outcome: "error", source: null, requestId, discordId: null }]);
    streamClean(logs, JOIN_ROUTE, [JOIN_LOG]);
    leakFree(html, fake.attempts, recordsFor(logs, JOIN_LOG));
  });
});
