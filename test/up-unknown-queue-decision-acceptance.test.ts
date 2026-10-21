// route-inventory: GET /up
// Unknown queue decision: a dead ledger must not read as healthy.
// Decided behavior: top-level `degraded` on unknown, keeping HTTP 200.
// Rationale: unknown joins the existing queue-only degraded family
// (pending >= 20 already returns degraded + 200), so dashboards that poll
// top-level status see blindness instead of health. HTTP stays 200 because
// readiness (db, migrations, config) is independent of queue observability;
// the uptime prober (200 + x-two-origin) stays green, so this page does not
// double with the direct scheduled failing signal. Never a 500: the queue
// read can never sink the endpoint. Queue slice, thresholds and the
// class-only warn shape stay exactly as before, and the staging smoke keeps
// failing closed on queue.status / ready_wait_severity unknown.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { QUEUE_CRITICAL_AT, QUEUE_READ_TIMEOUT_MS, QUEUE_WARN_AT, upBody } from "../src/up";
import { healthSql } from "./helpers/up";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const withStore = (sql: unknown) => ({ ...env, QUEUE_DEPTH_STORE: sql }) as Env;
const never = () => new Promise<Record<string, unknown>[]>(() => {});

const unknownQueue = {
  status: "unknown",
  pending: null,
  delayed: null,
  reserved: null,
  total: null,
  failed: null,
  oldest_pending_age_seconds: null,
  oldest_ready_wait_age_seconds: null,
  ready_wait_severity: "unknown",
  warn_at: 20,
  critical_at: 100,
  detail: null,
};

describe("unknown queue decision: degraded on unknown, keeping 200", () => {
  it("no-measure returns top-level degraded with the unconfigured detail", async () => {
    const body = await upBody(null, healthSql());
    expect(body.status).toBe("degraded");
    expect(body.queue).toEqual({
      ...unknownQueue,
      detail: "queue ledger is not configured.",
    });
    expect(body).toMatchObject({ db: "ok", pending_migrations: 0 });
  });

  it("a throwing measure returns top-level degraded with a null detail", async () => {
    const body = await upBody(async () => {
      throw new Error("private SQL/credential");
    }, healthSql());
    expect(body.status).toBe("degraded");
    expect(body.queue).toEqual(unknownQueue);
    expect(body).toMatchObject({ db: "ok", pending_migrations: 0 });
  });

  it("stays HTTP 200 with degraded top-level when only the queue ledger fails", async () => {
    const res = await app.request(
      "/up",
      {},
      withStore(healthSql({ queue: new Error("queue table missing") })),
    );
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(500);
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(await res.json()).toMatchObject({
      status: "degraded",
      db: "ok",
      pending_migrations: 0,
      queue: unknownQueue,
    });
  });

  it("a hung queue alone reports degraded unknown on a ready HTTP 200", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.resolve(
        app.request("/up", {}, withStore(healthSql({ queue: never }))),
      );
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "degraded",
        db: "ok",
        pending_migrations: 0,
        queue: unknownQueue,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unknown queue decision: healthy and degraded depths unchanged", () => {
  it("healthy depth stays healthy with measurements intact", async () => {
    const body = await upBody(
      async () => ({
        pending: 3,
        delayed: 1,
        reserved: 0,
        total: 4,
        failed: 2,
        oldestPendingAgeSeconds: 42,
        oldestReadyWaitAgeSeconds: 12.5,
      }),
      healthSql(),
    );
    expect(body.status).toBe("healthy");
    expect(body.queue).toMatchObject({
      status: "healthy",
      pending: 3,
      delayed: 1,
      reserved: 0,
      total: 4,
      failed: 2,
      oldest_pending_age_seconds: 42,
      oldest_ready_wait_age_seconds: 12.5,
      ready_wait_severity: "healthy",
      warn_at: QUEUE_WARN_AT,
      critical_at: QUEUE_CRITICAL_AT,
      detail: null,
    });
  });

  it("degraded thresholds unchanged: warn at 20, critical has no separate status", async () => {
    expect(QUEUE_WARN_AT).toBe(20);
    expect(QUEUE_CRITICAL_AT).toBe(100);
    for (const pending of [QUEUE_WARN_AT - 1, QUEUE_WARN_AT, QUEUE_CRITICAL_AT]) {
      const body = await upBody(
        async () => ({
          pending,
          delayed: 0,
          reserved: 0,
          total: pending,
          failed: 0,
          oldestPendingAgeSeconds: 9,
          oldestReadyWaitAgeSeconds: 1,
        }),
        healthSql(),
      );
      expect(body.status).toBe(pending >= QUEUE_WARN_AT ? "degraded" : "healthy");
      expect(body.queue.status).toBe(body.status);
      expect(body.queue.warn_at).toBe(20);
      expect(body.queue.critical_at).toBe(100);
    }
  });

  it("a DB failure with an unreadable queue stays 503 degraded, never 200 or 500", async () => {
    const res = await app.request(
      "/up",
      {},
      withStore(
        healthSql({
          ping: new Error("private credential"),
          queue: new Error("private credential"),
        }),
      ),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "degraded",
      db: "error",
      pending_migrations: null,
      queue: unknownQueue,
    });
  });
});

describe("unknown queue decision: warn shape and smoke input preserved", () => {
  it("warn on throw stays class-only with no message leak", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = await upBody(async () => {
        throw new Error("private SQL/credential");
      }, healthSql());
      expect(body.queue.status).toBe("unknown");
      expect(warning).toHaveBeenCalledWith(
        "Health check could not read the queue depth; reporting unknown.",
        { exception: "Error" },
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private SQL/credential");
    } finally {
      warning.mockRestore();
    }
  });

  it("unknown queue slice stays null/unknown so the smoke gate still sees blindness", async () => {
    const throwing = await upBody(async () => {
      throw new Error("fixture outage");
    }, healthSql());
    expect(throwing.queue.status).toBe("unknown");
    expect(throwing.queue.ready_wait_severity).toBe("unknown");
    expect(throwing.queue).toMatchObject({
      pending: null,
      delayed: null,
      reserved: null,
      total: null,
      failed: null,
      oldest_pending_age_seconds: null,
      oldest_ready_wait_age_seconds: null,
      warn_at: 20,
      critical_at: 100,
      detail: null,
    });
    const unconfigured = await upBody(null, healthSql());
    expect(unconfigured.queue.status).toBe("unknown");
    expect(unconfigured.queue.ready_wait_severity).toBe("unknown");
    expect(unconfigured.queue.detail).toBe("queue ledger is not configured.");
  });

  it("staging smoke still allows degraded top-level and gates unknown queue fields", async () => {
    const smoke = readFileSync("bin/smoke.mjs", "utf8");
    expect(smoke).toContain('["healthy", "degraded"].includes(data?.status)');
    expect(smoke).toContain('queueStatus === "unknown"');
    expect(smoke).toContain('severity === "unknown"');
    expect(smoke).toContain("known queue.status and ready_wait_severity (not unknown)");
  });
});

describe("unknown queue decision: monitor and runbook document the choice", () => {
  it("runbook queue table reads degraded for both unknown rows", async () => {
    const runbook = readFileSync("docs/runbook.md", "utf8");
    expect(runbook).toContain("| Read rejects or reaches a server/response limit | `degraded` |");
    expect(runbook).toContain("| No usable queue client/configuration | `degraded` |");
  });

  it("runbook calls degraded unknown lack of evidence, never healthy unknown", async () => {
    const runbook = readFileSync("docs/runbook.md", "utf8");
    expect(runbook).not.toContain("healthy + unknown");
    expect(runbook).toMatch(/degraded[^.\n]*unknown[^.\n]*lack of evidence/i);
  });

  it("runbook or alerts note the scheduled failing interaction so paging is not doubled", async () => {
    const runbook = readFileSync("docs/runbook.md", "utf8");
    const alerts = readFileSync("docs/runbook-alerts.md", "utf8");
    const runbookNote = runbook.includes("scheduled.failing") && /double|uptime|200/.test(runbook);
    const alertsRow =
      alerts.includes("unknown") &&
      alerts.includes("degraded") &&
      alerts.includes("scheduled.failing");
    expect(runbookNote || alertsRow).toBe(true);
  });
});
