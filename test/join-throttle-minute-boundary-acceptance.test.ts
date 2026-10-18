/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// Acceptance oracle: the shared 10/min join throttle is one sliding 60 s
// budget per client, not a fresh budget at every wall-clock minute.
//
// Production change that must make this fail if reverted: putting a minute
// segment back into the join bucket key (join:<client>:<minute>) so a burst
// straddling a minute rollover spends two budgets — 10 hits just before the
// boundary plus 10 just after, all inside a few seconds. The oracle pins only
// the observable contract:
//   1. a burst crossing a minute boundary is refused on hit 11 (and every
//      later hit inside the same 60 s window) with 429 + Retry-After;
//   2. /join/discord and /join/callback draw on that one minute-free bucket
//      (join:<client>, the same shape as the auth/QA/logout buckets);
//   3. refusals spend nothing;
//   4. steady-rate behaviour inside one minute is unchanged;
//   5. the budget returns once the hits age past 60 s;
//   6. a missing throttle store still degrades to allow, boundary or not.
// Hermetic only: in-memory session + throttle doubles, a movable clock, no
// network, no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  JOIN_THROTTLE_BUCKET,
  JOIN_THROTTLE_PER_MINUTE,
  checkJoinThrottle,
} from "../src/join/service";
import type { JoinRouteDeps } from "../src/join/route";
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

// An exact wall-clock minute boundary (divisible by 60_000).
const BOUNDARY = 1_791_000_060_000;
const CLIENT = "203.0.113.7";
const OTHER_CLIENT = "198.51.100.99";
const BUDGET = JOIN_THROTTLE_PER_MINUTE;

// One movable clock drives both the injected route clock and Date.now, so the
// bucket a request keys on and the 60 s counting window move together exactly
// as they do in production. Tests set `clock.nowMs` between requests.
function movableClock(startMs: number) {
  const clock = { nowMs: startMs };
  vi.spyOn(Date, "now").mockImplementation(() => clock.nowMs);
  return clock;
}

// In-memory Sql double for the throttle statements, mirroring test/join.test.ts:
// the count query reads one bucket's hits inside the trailing 60 s window and
// reports the wait until the oldest of them expires.
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > Date.now() - 60_000);
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
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return { sql, throttle };
}

function isolated(clock: { nowMs: number }, deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql();
  const e = {
    ...env,
    SESSION_STORE: createMemorySessionStore(),
    JOIN_DEPS: { store: async () => fake.sql, now: () => clock.nowMs, ...deps },
  } as unknown as Env;
  return { fake, env: e };
}

const as = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });
const start = (e: Env, ip = CLIENT) => app.request("/join/discord", as(ip), e);
const startJson = (e: Env, ip = CLIENT) =>
  app.request(
    "/join/discord",
    { headers: { "cf-connecting-ip": ip, accept: "application/json" } },
    e,
  );
const callback = (e: Env, ip = CLIENT) =>
  app.request("/join/callback?error=access_denied", as(ip), e);

function expectRateLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
  const retryAfter = Number(res.headers.get("Retry-After"));
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("join throttle across a minute boundary (acceptance)", () => {
  it("refuses hit 11 when the first 10 landed just before a minute rollover", async () => {
    const clock = movableClock(BOUNDARY - 500);
    const { fake, env: e } = isolated(clock);
    for (let i = 0; i < BUDGET; i++) {
      expect((await start(e)).status).toBe(302);
    }
    // One second later in real time, but the next wall-clock minute: the same
    // sliding 60 s budget must still be spent.
    clock.nowMs = BOUNDARY + 500;
    const eleventh = await startJson(e);
    expectRateLimited(eleventh);
    expect(await eleventh.json()).toMatchObject({ reason: "rate_limited" });
    // The remaining 9 hits of the post-boundary burst are refused too, and no
    // refusal spends budget.
    for (let i = 0; i < BUDGET - 1; i++) {
      expect((await start(e)).status).toBe(429);
    }
    expect(fake.throttle).toHaveLength(BUDGET);
  });

  it("spends start and callback hits from one minute-free bucket across the boundary", async () => {
    const clock = movableClock(BOUNDARY - 500);
    const { fake, env: e } = isolated(clock);
    for (let i = 0; i < BUDGET; i++) {
      expect((await callback(e)).status).not.toBe(429);
    }
    clock.nowMs = BOUNDARY + 500;
    // The start route sees the callback spend even after the rollover...
    expectRateLimited(await start(e));
    // ...in a single bucket naming only the client, never the minute.
    expect(new Set(fake.throttle.map((r) => r.bucket))).toEqual(
      new Set([`${JOIN_THROTTLE_BUCKET}:${CLIENT}`]),
    );
    // A client the Worker has never seen keeps a full budget of its own.
    expect((await start(e, OTHER_CLIENT)).status).toBe(302);
  });

  it("control: steady rate inside one minute allows the budget, then refuses with Retry-After", async () => {
    const clock = movableClock(BOUNDARY - 30_000);
    const { fake, env: e } = isolated(clock);
    for (let i = 0; i < BUDGET; i++) {
      expect((await start(e)).status).toBe(302);
    }
    const limited = await startJson(e);
    expectRateLimited(limited);
    expect(await limited.json()).toMatchObject({ reason: "rate_limited" });
    expect(fake.throttle).toHaveLength(BUDGET);
  });

  it("control: the budget returns once the hits age past 60 seconds", async () => {
    const clock = movableClock(BOUNDARY - 30_000);
    const { fake, env: e } = isolated(clock);
    for (let i = 0; i < BUDGET; i++) {
      expect((await start(e)).status).toBe(302);
    }
    expect((await start(e)).status).toBe(429);
    clock.nowMs += 61_000;
    expect((await start(e)).status).toBe(302);
    expect(fake.throttle).toHaveLength(BUDGET + 1);
  });

  it("control: a missing throttle store degrades to allow across the boundary", async () => {
    const clock = movableClock(BOUNDARY - 500);
    const { env: e } = isolated(clock, { store: async () => null });
    for (let i = 0; i < BUDGET; i++) {
      expect((await start(e)).status).toBe(302);
    }
    clock.nowMs = BOUNDARY + 500;
    for (let i = 0; i < BUDGET; i++) {
      expect((await start(e)).status).toBe(302);
    }
    // The unit seam degrades the same way, however often it is asked.
    for (let i = 0; i < BUDGET + 5; i++) {
      expect(await checkJoinThrottle(null, `${JOIN_THROTTLE_BUCKET}:${CLIENT}`, BUDGET)).toEqual({
        limited: false,
      });
    }
  });
});
