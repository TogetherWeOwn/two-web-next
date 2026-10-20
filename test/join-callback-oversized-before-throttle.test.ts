// Join callback refuses oversized OAuth params before throttle.
// route-inventory: GET /join/callback
//
// Oversized code/state on GET /join/callback is refused before the shared
// join throttle spend (zero budget consumed) with the existing expired-link
// recovery and its bounded OversizedOAuthParams log line. The branch clears
// the journey cookies like every other non-throttled callback outcome, and
// `error` callbacks keep today's denied path (throttle spent). Hermetic:
// memory session store, in-memory join Sql double, stubbed fetch — no live
// Discord, database, or secrets.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  withheld,
} from "./helpers/diagnostic-stream";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { Env } from "../src/env";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

const OVERSIZED = 8192;
const JOIN_LOG = "discord token exchange failed on the join journey";
const JOIN_ROUTE = "/join/callback";

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="));

// In-memory Sql double for the journey's statements (same shape as
// join.test.ts). Records every throttle hit and attempt row.
function fakeJoinStore() {
  const availabilityChecks = vi.fn(async () => []);
  const hits: { bucket: string; at: number }[] = [];
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head === "SELECT 1") return availabilityChecks();
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = hits.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      hits.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
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
    throw new Error(`fakeJoin: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return { sql, hits, attempts, availabilityChecks };
}

function exhaustedJoinStore() {
  return withThrottleTx((async (strings: TemplateStringsArray) => {
    const head = strings.join("?");
    if (head === "SELECT 1") return [];
    if (head.includes("count(*)")) return [{ n: 999, wait: 30 }];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`exhaustedJoin: unexpected statement ${head.slice(0, 80)}`);
  }) as unknown as Sql);
}

function fixture() {
  const join = fakeJoinStore();
  const store = createMemorySessionStore();
  const create = vi.spyOn(store, "create");
  const replace = vi.spyOn(store, "replace");
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => join.sql },
  } as unknown as Env;
  return { env, create, replace, join };
}

function mockDiscord({
  joinStatus = 201,
  token = "user-token",
}: {
  joinStatus?: number;
  token?: string;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth2/token")) {
      if (token === "EXCHANGE_FAILS") return new Response("bad", { status: 500 });
      return Response.json({ access_token: token });
    }
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
    if (url.includes("/members/42") && init?.method === "PUT")
      return new Response(null, { status: joinStatus });
    if (url.includes("/members/42"))
      return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

async function start(env: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, {}, env);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res), res };
}

const recordsFor = (logs: ReturnType<typeof captureDiagnosticStream>, message: string) =>
  logs
    .filter((r) => r.args[0] === message)
    .map((r) => ({ channel: r.channel, args: withheld(r.args, []) as unknown[] }));

function expectJourneyCleared(res: Response) {
  const setCookies = res.headers.getSetCookie().join("\n");
  for (const name of ["__Host-two_join_state", "__Host-two_join_source", "__Host-two_join_next"]) {
    expect(setCookies, `${name} cleared`).toContain(`${name}=;`);
  }
  expect(setCookies).toContain("Max-Age=0");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("join callback refuses oversized OAuth params before throttle", () => {
  it("oversized code with a valid state spends zero join budget", async () => {
    const f = fixture();
    const begun = await start(f.env, "?source=web-homepage&next=%2Fevents");
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "a".repeat(OVERSIZED);
    const res = await app.request(
      `/join/callback?code=${oversized}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join link expired");
    expect(html).toContain('data-testid="recovery-retry"');
    // Retry intent survives the clearing, like every other recovery path.
    expect(html).toContain("next=%2Fevents");
    expect(html).toContain("source=web-homepage");
    expect(sessionCookie(res)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.join.attempts).toHaveLength(0);
    // Zero callback spend: only the start's hit exists. The read-only probe
    // still checks availability; it cannot consume the shared join budget.
    expect(f.join.availabilityChecks).toHaveBeenCalledTimes(1);
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(1);
    expectJourneyCleared(res);
    // Bounded log line unchanged: own class, sanitized source, never values.
    const line = recordsFor(logs, JOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      source: "web-homepage",
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    expect(JSON.stringify(line)).not.toContain("InvalidState");
    expect(JSON.stringify(logs.map((r) => r.args))).not.toContain(oversized.slice(0, 32));
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], {
      request: JOIN_ROUTE,
      messages: [JOIN_LOG],
    });
  });

  it("oversized state spends zero join budget", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "s".repeat(OVERSIZED);
    const res = await app.request(
      `/join/callback?code=${"c".repeat(32)}&state=${oversized}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(sessionCookie(res)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.join.attempts).toHaveLength(0);
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(1);
    expectJourneyCleared(res);
    const line = recordsFor(logs, JOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      source: null,
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], {
      request: JOIN_ROUTE,
      messages: [JOIN_LOG],
    });
  });

  it("an unclassified availability-query failure keeps the oversized recovery", async () => {
    const f = fixture();
    f.join.availabilityChecks.mockRejectedValueOnce(new Error("fixture query failure"));
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/join/callback?code=${"a".repeat(OVERSIZED)}&state=x`,
      {},
      f.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(f.join.availabilityChecks).toHaveBeenCalledTimes(1);
    expect(f.join.hits).toHaveLength(0);
    expect(f.join.attempts).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expectJourneyCleared(res);
    expectDiagnosticStreamClean(logs, ["fixture query failure"], {
      request: JOIN_ROUTE,
      messages: [JOIN_LOG],
    });
  });

  it("a missing join store keeps the DB-free oversized recovery", async () => {
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/join/callback?code=${"a".repeat(OVERSIZED)}&state=x`,
      {},
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionCookie(res)).toBeUndefined();
    expectJourneyCleared(res);
    expectDiagnosticStreamClean(logs, [], { request: JOIN_ROUTE, messages: [JOIN_LOG] });
  });

  it("error with oversized params keeps today's denied path and spends throttle", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "a".repeat(OVERSIZED);
    const res = await app.request(
      `/join/callback?error=access_denied&error_description=never-echo&code=${oversized}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).not.toContain("never-echo");
    expect(fetch).not.toHaveBeenCalled();
    // Error path still spends: start + callback.
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(2);
    expect(f.join.attempts).toEqual([
      {
        outcome: "denied",
        source: null,
        requestId: res.headers.get("x-request-id"),
        discordId: null,
      },
    ]);
    // Denied path never warns, oversized or not.
    expect(recordsFor(logs, JOIN_LOG)).toHaveLength(0);
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], { request: JOIN_ROUTE });
  });

  it("replayed state stays InvalidState and still spends throttle (unchanged)", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/join/callback?code=${"c".repeat(32)}&state=mismatch`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    // Replay passes the size gate, so it reaches (and spends) the throttle.
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(2);
    expect(f.join.attempts).toHaveLength(0);
    const line = recordsFor(logs, JOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.args[1]).toEqual({
      exception: "InvalidState",
      source: null,
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });
    expectDiagnosticStreamClean(logs, [], { request: JOIN_ROUTE, messages: [JOIN_LOG] });
  });

  it("throttle-exhausted plus oversized still refuses with the expired-link recovery (precedence)", async () => {
    const store = createMemorySessionStore();
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => exhaustedJoinStore() },
    } as unknown as Env;
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const oversized = "a".repeat(OVERSIZED);
    const res = await app.request(
      `/join/callback?code=${oversized}&state=${"s".repeat(32)}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionCookie(res)).toBeUndefined();
    const line = recordsFor(logs, JOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args[1]).toEqual({
      exception: "OversizedOAuthParams",
      source: null,
      outcome: "expired",
      request_id: res.headers.get("x-request-id"),
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    expectDiagnosticStreamClean(logs, [oversized.slice(0, 16)], {
      request: JOIN_ROUTE,
      messages: [JOIN_LOG],
    });
  });

  it("throttle-exhausted plus normal-length still answers 429 (throttle intact)", async () => {
    const store = createMemorySessionStore();
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => exhaustedJoinStore() },
    } as unknown as Env;
    const res = await app.request("/join/callback?code=abc&state=x", {}, env);
    expect(res.status).toBe(429);
  });

  it("normal-length code still reaches the exchange (admitted journey unchanged)", async () => {
    const f = fixture();
    const begun = await start(f.env);
    const { fetch } = mockDiscord();
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/join/callback?code=${"c".repeat(32)}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(sessionCookie(res)).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/oauth2/token"))).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(2);
    expect(f.join.attempts).toEqual([
      {
        outcome: "added",
        source: null,
        requestId: null,
        discordId: "42",
      },
    ]);
    expect(recordsFor(logs, JOIN_LOG)).toHaveLength(0);
  });

  it("exchange outage still 503s the recovery page (outage unchanged)", async () => {
    const f = fixture();
    const begun = await start(f.env);
    mockDiscord({ token: "EXCHANGE_FAILS" });
    const logs = captureDiagnosticStream();
    const res = await app.request(
      `/join/callback?code=${"c".repeat(32)}&state=${begun.state}`,
      { headers: { cookie: begun.cookie } },
      f.env,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Discord is unreachable");
    expect(f.join.hits.filter((h) => h.bucket.startsWith("join:"))).toHaveLength(2);
    expect(f.join.attempts[0]).toMatchObject({ outcome: "error" });
    const line = recordsFor(logs, JOIN_LOG);
    expect(line).toHaveLength(1);
    expect(line[0]!.args[1]).toMatchObject({ outcome: "error" });
  });
});
