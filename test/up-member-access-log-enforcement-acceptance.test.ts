// route-inventory: GET /up
// Acceptance: /up reports the legacy member-access-log enforcement label for
// readiness consumers and dashboards. The signal is informational, like
// the revision marker: it never flips readiness on its own, and it moves no
// enforcement boundary — the keyed read boundary refuses unaudited reads
// whatever the flag says — so it must not change enforcement, refusal or
// logging behaviour.
//
// Pinned public shape (the only surface this suite binds):
//   member_access_log_enforcement: "enforcing" | "log_only"
// always present on the /up body, whatever the HTTP status. The value
// mirrors the existing MEMBER_ACCESS_LOG_ENFORCE parsing exactly: trimmed,
// case-insensitive "false", "0" and "no" mean log-only; unset, empty and
// every other value mean enforcing (see test/member-data-access.test.ts).
// Hermetic fixtures only: the queue/DB reads use the healthSql double and no
// database, network or deployment is touched.
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { WEB_MIGRATIONS } from "../src/up";
import app from "./app";
import { healthSql } from "./helpers/up";

const ledgerAll = WEB_MIGRATIONS.map((entry) => entry.when).sort((a, b) => a - b);

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const depthRow = (over: Record<string, unknown> = {}) => ({
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  oldest_ready_wait_age_seconds: 12.5,
  ...over,
});

const healthyQueue = {
  status: "healthy",
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  oldest_ready_wait_age_seconds: 12.5,
  ready_wait_severity: "healthy",
  warn_at: 20,
  critical_at: 100,
  detail: null,
};

const ready = (over: Partial<Env> = {}): Env =>
  ({ ...env, QUEUE_DEPTH_STORE: healthSql({ queue: [depthRow()] }), ...over }) as Env;

type UpJson = Record<string, unknown> & { member_access_log_enforcement?: unknown };

const getUp = async (bindings: Env) => {
  const res = await app.request("/up", {}, bindings);
  return { res, body: (await res.json()) as UpJson };
};

describe("/up member-access-log enforcement reporting (acceptance)", () => {
  it("default configuration (setting absent) reports enforcing on a healthy 200", async () => {
    const { res, body } = await getUp(ready());
    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      migration_ledger: ledgerAll,
      queue: healthyQueue,
      member_access_log_enforcement: "enforcing",
    });
  });

  it("explicit enforcing configuration reports enforcing on a healthy 200", async () => {
    const { res, body } = await getUp(ready({ MEMBER_ACCESS_LOG_ENFORCE: "true" }));
    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      migration_ledger: ledgerAll,
      queue: healthyQueue,
      member_access_log_enforcement: "enforcing",
    });
  });

  it("degraded log-only configuration reports log_only and still answers a healthy 200", async () => {
    const { res, body } = await getUp(ready({ MEMBER_ACCESS_LOG_ENFORCE: "false" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(res.headers.getSetCookie()).toEqual([]);
    // Distinguishable, but readiness does not fail: no config key, status and
    // queue measurements are exactly the healthy ones.
    expect(body).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      migration_ledger: ledgerAll,
      queue: healthyQueue,
      member_access_log_enforcement: "log_only",
    });
    expect(body).not.toHaveProperty("config");
  });

  it.each([
    [undefined, "enforcing"],
    ["", "enforcing"],
    [" true ", "enforcing"],
    ["1", "enforcing"],
    ["yes", "enforcing"],
    ["garbage", "enforcing"],
    [" false ", "log_only"],
    ["FALSE", "log_only"],
    ["0", "log_only"],
    [" No ", "log_only"],
  ] as const)("mirrors the existing enforcement parsing for %j => %s", async (flag, expected) => {
    const { res, body } = await getUp(ready({ MEMBER_ACCESS_LOG_ENFORCE: flag }));
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.member_access_log_enforcement).toBe(expected);
  });

  it("enforcing and log-only bodies differ only in the enforcement field", async () => {
    const { body: enforcing } = await getUp(ready({ MEMBER_ACCESS_LOG_ENFORCE: "true" }));
    const { body: logOnly } = await getUp(ready({ MEMBER_ACCESS_LOG_ENFORCE: "false" }));
    const { member_access_log_enforcement: _e, ...restEnforcing } = enforcing;
    const { member_access_log_enforcement: _l, ...restLogOnly } = logOnly;
    expect(restLogOnly).toEqual(restEnforcing);
    expect(Object.keys(logOnly).sort()).toEqual(
      [
        "db",
        "pending_migrations",
        "migration_ledger",
        "queue",
        "status",
        "member_access_log_enforcement",
      ].sort(),
    );
  });

  it("queue-only degradation stays a 200 and is independent of the enforcement field", async () => {
    for (const [flag, expected] of [
      ["true", "enforcing"],
      ["false", "log_only"],
    ] as const) {
      const bindings = {
        ...env,
        MEMBER_ACCESS_LOG_ENFORCE: flag,
        QUEUE_DEPTH_STORE: healthSql({ queue: [depthRow({ pending: 25, total: 26 })] }),
      } as Env;
      const { res, body } = await getUp(bindings);
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        status: "degraded",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "degraded", pending: 25 },
        member_access_log_enforcement: expected,
      });
    }
  });

  it("a readiness failure still carries the signal: DB down with log-only answers 503 log_only", async () => {
    const bindings = {
      ...env,
      MEMBER_ACCESS_LOG_ENFORCE: "false",
      QUEUE_DEPTH_STORE: healthSql({ ping: new Error("down"), queue: [depthRow()] }),
    } as Env;
    const { res, body } = await getUp(bindings);
    expect(res.status).toBe(503);
    expect(body).toEqual({
      status: "degraded",
      db: "error",
      pending_migrations: null,
      migration_ledger: null,
      queue: healthyQueue,
      member_access_log_enforcement: "log_only",
    });
  });

  it("a readiness failure still carries the signal: DB down by default answers 503 enforcing", async () => {
    const bindings = {
      ...env,
      QUEUE_DEPTH_STORE: healthSql({ ping: new Error("down"), queue: [depthRow()] }),
    } as Env;
    const { res, body } = await getUp(bindings);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      status: "degraded",
      db: "error",
      pending_migrations: null,
      member_access_log_enforcement: "enforcing",
    });
  });

  it("missing-secret config:missing and log_only coexist on one 503 (the signal is not the config key)", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bindings = ready({ MEMBER_ACCESS_LOG_ENFORCE: "0" });
      delete (bindings as Record<string, unknown>).SESSION_SECRET;
      const { res, body } = await getUp(bindings);
      expect(res.status).toBe(503);
      expect(body).toEqual({
        status: "degraded",
        db: "ok",
        pending_migrations: 0,
        migration_ledger: ledgerAll,
        config: "missing",
        queue: healthyQueue,
        member_access_log_enforcement: "log_only",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("never echoes the raw setting value or its variable name in the body", async () => {
    const sentinel = "enforce-please-sentinel-value";
    const res = await app.request("/up", {}, ready({ MEMBER_ACCESS_LOG_ENFORCE: sentinel }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).member_access_log_enforcement).toBe("enforcing");
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("MEMBER_ACCESS_LOG_ENFORCE");
  });
});
