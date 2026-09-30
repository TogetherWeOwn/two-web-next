import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { QUEUE_CRITICAL_AT, QUEUE_READ_TIMEOUT_MS, QUEUE_WARN_AT, upBody } from "../src/up";

// N3 (TOG-9895): GET /up ports two-web HealthCheckController + QueueHealth.
// Always 200; `degraded` iff pending >= 20; an uncountable/unreachable ledger
// reports queue.status `unknown` in the same shape; no session/auth on the path.

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// Sql double for the QUEUE_DEPTH_STORE seam: a tagged-template callable that
// returns (or throws) a canned `queue_jobs` aggregate row, plus the driver
// surface pgQueueLedger/pgQueueDepth might touch.
function sqlReturning(row: Record<string, unknown> | Error) {
  const fn = (async () => {
    if (row instanceof Error) throw row;
    return [row];
  }) as ((...a: unknown[]) => Promise<unknown[]>) & Record<string, unknown>;
  fn.begin = async (cb: (tx: unknown) => Promise<unknown>) => cb(fn);
  fn.unsafe = async () => [];
  fn.end = async () => {};
  return fn;
}

const depthRow = (over: Record<string, unknown> = {}) => ({
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  ...over,
});

const withStore = (sql: unknown) => ({ ...env, QUEUE_DEPTH_STORE: sql }) as Env;

describe("upBody", () => {
  it("is degraded at exactly the warn threshold and healthy below it", async () => {
    const at = await upBody(async () => ({
      pending: QUEUE_WARN_AT, delayed: 0, reserved: 0, total: 20, failed: 0, oldestPendingAgeSeconds: 9,
    }));
    expect(at.status).toBe("degraded");
    expect(at.queue.status).toBe("degraded");
    const below = await upBody(async () => ({
      pending: QUEUE_WARN_AT - 1, delayed: 0, reserved: 0, total: 19, failed: 0, oldestPendingAgeSeconds: 9,
    }));
    expect(below.status).toBe("healthy");
    expect(below.queue.status).toBe("healthy");
  });

  it("a throwing measure reports unknown, never throws", async () => {
    const body = await upBody(async () => Promise.reject(new Error("relation queue_jobs does not exist")));
    expect(body.status).toBe("healthy");
    expect(body.queue.status).toBe("unknown");
    expect(body.queue.pending).toBeNull();
    expect(body.queue.detail).toBeNull(); // error path leaks nothing, same as legacy
  });

  it("an unconfigured backend reports unknown with a detail", async () => {
    const body = await upBody(null);
    expect(body.status).toBe("healthy");
    expect(body.queue.status).toBe("unknown");
    expect(body.queue.detail).toBe("queue ledger is not configured.");
  });
});

describe("GET /up", () => {
  it("answers 200 healthy with the full queue payload shape", async () => {
    const res = await app.request("/up", {}, withStore(sqlReturning(depthRow())));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "healthy",
      queue: {
        status: "healthy",
        pending: 3,
        delayed: 1,
        reserved: 0,
        total: 4,
        failed: 2,
        oldest_pending_age_seconds: 42,
        warn_at: 20,
        critical_at: 100,
        detail: null,
      },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("answers 200 degraded when pending crosses warn", async () => {
    const res = await app.request("/up", {}, withStore(sqlReturning(depthRow({ pending: 25, total: 26 }))));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("degraded");
    expect(body.queue.status).toBe("degraded");
    expect(body.queue.warn_at).toBe(QUEUE_WARN_AT);
    expect(body.queue.critical_at).toBe(QUEUE_CRITICAL_AT);
  });

  it("stays 200 unknown when the ledger read throws (app-DB outage)", async () => {
    const res = await app.request("/up", {}, withStore(sqlReturning(new Error("connection refused"))));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("healthy");
    expect(body.queue).toEqual({
      status: "unknown",
      pending: null,
      delayed: null,
      reserved: null,
      total: null,
      failed: null,
      oldest_pending_age_seconds: null,
      warn_at: 20,
      critical_at: 100,
      detail: null,
    });
  });

  it("stays 200 unknown when no database is configured at all", async () => {
    const res = await app.request("/up", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.queue.status).toBe("unknown");
    expect(body.queue.detail).toBe("queue ledger is not configured.");
  });
});

describe("/up bounded reads", () => {
  it("a hung ledger read reports unknown instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const p = upBody(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS + 1);
      expect((await p).queue.status).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a malformed DATABASE_URL answers 200 unknown, not 500", async () => {
    const res = await app.request("/up", {}, { ...env, DATABASE_URL: "not a url" } as Env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queue: { status: string } }).queue.status).toBe("unknown");
  });
});
