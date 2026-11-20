// Exercise runtime binding resolution without a live database or injected throttle store.
import type { Context } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { PER_REQUEST_STATEMENT_TIMEOUT_LOCAL } from "../src/db/connection";
import type { Env } from "../src/env";
import { chargeWebThrottle } from "../src/http/throttle";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { throttleStore, type EnvWithThrottle } from "../src/throttle";

const { makeSql } = vi.hoisted(() => ({ makeSql: vi.fn() }));
vi.mock("postgres", () => ({ default: makeSql }));

const hits = new Map<string, number>();
const prune = vi.fn();
const sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("pg_advisory_xact_lock")) return [];
    if (query.includes("DELETE FROM web_throttle_hits")) prune();
    const bucket = String(values[0]);
    if (query.includes("SELECT count(*)")) return [{ n: hits.get(bucket) ?? 0, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits"))
      hits.set(bucket, (hits.get(bucket) ?? 0) + 1);
    return [];
  },
  {
    unsafe: vi.fn(async (_statement: string) => []),
    // Transaction seam for atomic admission: single-threaded double, run inline.
    begin: (run: (tx: unknown) => Promise<unknown>) => run(sql),
  },
);
const ctx = (env: EnvWithThrottle) => ({ env }) as Context<{ Bindings: Env }>;
const bindingEnv = {
  APP_URL: "https://next.example.test",
  DB: { connectionString: "postgres://hyperdrive.test/db" },
} as Env;

beforeEach(() => {
  vi.resetAllMocks();
  hits.clear();
  makeSql.mockReturnValue(sql);
});

describe("throttle runtime connection wiring", () => {
  it("uses the binding with Hyperdrive-safe driver options", async () => {
    expect(await throttleStore(ctx(bindingEnv))).toBe(sql);
    expect(makeSql).toHaveBeenCalledExactlyOnceWith(bindingEnv.DB!.connectionString, {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
      fetch_types: false,
    });
  });

  it("installs the statement bound inside the admission transaction", async () => {
    // Every throttle builder (throttleStore, joinStore, profile admission)
    // funnels through checkJoinThrottle, so the bound lives here, not on
    // the client options: lock waits still refuse first (2 s), executing
    // statements cancel at the shared 5 s bound.
    expect(await checkJoinThrottle(sql as unknown as Sql, "probe:anon", 10)).toEqual({
      limited: false,
    });
    expect(sql.unsafe).toHaveBeenNthCalledWith(1, "SET LOCAL lock_timeout = '2000ms'");
    expect(sql.unsafe).toHaveBeenNthCalledWith(2, PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
  });

  it("matches shared admission at the budget boundary without running prune itself", async () => {
    const store = sql as unknown as Sql;
    const direct = "probe:direct";
    const join = "probe:join";
    expect(await chargeWebThrottle(store, direct, 1)).toEqual({ limited: false });
    expect(prune).not.toHaveBeenCalled();
    expect(await checkJoinThrottle(store, join, 1)).toEqual({ limited: false });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(await chargeWebThrottle(store, direct, 1)).toEqual({ limited: true, retryAfter: 30 });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(await checkJoinThrottle(store, join, 1)).toEqual({ limited: true, retryAfter: 30 });
    expect(prune).toHaveBeenCalledTimes(2);
    expect([...hits]).toEqual([
      [direct, 1],
      [join, 1],
    ]);
    expect(sql.unsafe.mock.calls.map(([statement]) => statement)).toEqual([
      "SET LOCAL lock_timeout = '2000ms'",
      PER_REQUEST_STATEMENT_TIMEOUT_LOCAL,
      "SET LOCAL lock_timeout = '2000ms'",
      PER_REQUEST_STATEMENT_TIMEOUT_LOCAL,
      "SET LOCAL statement_timeout = '2000ms'",
      "SET LOCAL lock_timeout = '2000ms'",
      PER_REQUEST_STATEMENT_TIMEOUT_LOCAL,
      "SET LOCAL lock_timeout = '2000ms'",
      PER_REQUEST_STATEMENT_TIMEOUT_LOCAL,
      "SET LOCAL statement_timeout = '2000ms'",
    ]);
  });

  it("keeps the injected store ahead of either runtime URL", async () => {
    expect(
      await throttleStore(
        ctx({
          ...bindingEnv,
          DATABASE_URL: "postgres://explicit.test/db",
          THROTTLE_STORE: async () => sql as never,
        }),
      ),
    ).toBe(sql);
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("prefers the explicit local URL", async () => {
    await throttleStore(ctx({ ...bindingEnv, DATABASE_URL: "postgres://explicit.test/db" }));
    expect(makeSql).toHaveBeenCalledTimes(1);
    expect(makeSql.mock.calls[0]?.[0]).toBe("postgres://explicit.test/db");
  });

  it("does not retry a refused explicit connection with Hyperdrive", async () => {
    const refused = new Error("connection refused");
    makeSql.mockImplementation(() => {
      throw refused;
    });
    await expect(
      throttleStore(ctx({ ...bindingEnv, DATABASE_URL: "postgres://refused.test/db" })),
    ).rejects.toBe(refused);
    expect(makeSql).toHaveBeenCalledTimes(1);
    expect(makeSql.mock.calls[0]?.[0]).toBe("postgres://refused.test/db");
  });

  it("returns null without either source", async () => {
    expect(await throttleStore(ctx({} as Env))).toBeNull();
    expect(makeSql).not.toHaveBeenCalled();
  });
});

describe("pause/reopen exhausted budgets with DB binding only", () => {
  it("counts JSON writes through the binding and refuses request 31 on both actions", async () => {
    const headers = {
      origin: bindingEnv.APP_URL,
      accept: "application/json",
      "cf-connecting-ip": "192.0.2.17",
    };
    for (let i = 0; i < 30; i++) {
      const action = i % 2 ? "rsvp-reopen" : "rsvp-pause";
      expect(
        (await app.request(`/events/abc/${action}`, { method: "POST", headers }, bindingEnv))
          .status,
      ).toBe(401);
    }
    expect(hits.get("event-write:192.0.2.17")).toBe(30);
    for (const action of ["rsvp-pause", "rsvp-reopen"]) {
      const res = await app.request(
        `/events/abc/${action}`,
        { method: "POST", headers },
        bindingEnv,
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    }
  });

  it("refuses both admin actions after the authenticated moderator budget is exhausted", async () => {
    const store = createMemorySessionStore();
    const secret = "test-session-secret-at-least-32-bytes-long";
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "mod",
      username: "mod",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, secret, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const env = { ...bindingEnv, SESSION_STORE: store, SESSION_SECRET: secret } as Env;
    hits.set("admin-write:192.0.2.18", 30);
    for (const action of ["rsvp-pause", "rsvp-reopen"]) {
      const res = await app.request(
        `/admin/events/abc/${action}`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            accept: "application/json",
            "cf-connecting-ip": "192.0.2.18",
          },
        },
        env,
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    }
    expect(makeSql).toHaveBeenCalledTimes(2);
  });
});
