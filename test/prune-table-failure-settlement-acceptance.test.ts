// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): on the scheduled model:prune path, every started drain —
// including the unique-lock sweep on the separate autocommit dispatch pool —
// settles before any pool is closed, and a partially failed pass that
// commits its healthy tables emits exactly one class-only
// scheduled.failing page after the flight commits.
//
// Contract pinned here (worker level, fake postgres driver, real cron /
// single-flight / prune stores / scheduled handler):
// - A table failure inside the flight does not end the handler while the
//   lock sweep is still in flight on the dispatch pool: no client `end`
//   runs before the sweep settles, and `end` order follows settlement.
// - A partial failure whose healthy tables commit resolves the handler
//   (like the post-commit cap precedent) and emits exactly one redacted
//   scheduled.failing line for model:prune carrying only the failure's
//   exception class — never its message, SQL, table names or row data.
// - When a cap hit and a table failure land in the same committed pass,
//   still exactly one page: the failure class wins over
//   PruneBatchCapError (a real error is never muted by the cap page).
// - A healthy pass stays silent and still closes every pool (positive
//   control). Whole-flight failures (setup/commit/unknown cron) keep the
//   existing reject-and-page behavior pinned by the scheduled suites.
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, PRUNE_DELETE_BATCH_SIZE } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import { parseJsonLines } from "./helpers/parse-json-lines";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");
const SECRET_MESSAGE =
  "delete from join_attempts where request_id = 'synthetic-secret-value' " +
  "for member synthetic-member-id";
const BANNED = [
  "synthetic-secret-value",
  "synthetic-member-id",
  "delete from",
  "join_attempts",
  "request_id",
];

const state = vi.hoisted(() => {
  class SyntheticDbError extends Error {
    constructor() {
      super(
        "delete from join_attempts where request_id = 'synthetic-secret-value' " +
          "for member synthetic-member-id",
      );
      this.name = "SyntheticDbError";
    }
  }
  return {
    SyntheticDbError,
    clients: [] as { ended: boolean }[],
    order: [] as string[],
    failTable: null as string | null,
    capTable: null as string | null,
    gateLockSweep: false,
    releaseLockSweep: null as (() => void) | null,
  };
});

vi.mock("postgres", () => {
  const makeClient = () => {
    const index = state.clients.length;
    const record = { ended: false };
    state.clients.push(record);
    const fullBatch = Array.from({ length: PRUNE_DELETE_BATCH_SIZE }, () => ({}));
    const tag = async (
      parts: TemplateStringsArray,
      ..._values: unknown[]
    ): Promise<Record<string, unknown>[]> => {
      const text = parts.join(" ").toLowerCase();
      if (text.includes("pg_try_advisory_xact_lock")) return [{ got: true }];
      if (text.includes("savepoint") || text.includes("rollback to") || text.includes("release ")) {
        return [];
      }
      if (state.failTable && text.includes(state.failTable)) {
        throw new state.SyntheticDbError();
      }
      if (text.includes("job_unique_locks") && state.gateLockSweep) {
        state.order.push("lock:start");
        await new Promise<void>((resolve) => {
          state.releaseLockSweep = resolve;
        });
        state.order.push("lock:settled");
        return [];
      }
      if (state.capTable && text.includes(state.capTable)) return fullBatch;
      return [];
    };
    // The transaction client handed out by `begin` is the only surface with
    // `savepoint`, matching the real driver: the pool client has none.
    const txClient = Object.assign(tag, {
      savepoint: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return run(txClient);
      },
    });
    const client = Object.assign(tag, {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return run(txClient);
      },
      savepoint: undefined,
      end: async () => {
        record.ended = true;
        state.order.push(`end:${index}`);
      },
    });
    return client;
  };
  return { default: vi.fn((() => makeClient()) as unknown as typeof postgres) };
});

const controller = (cron: string) =>
  ({ cron, scheduledTime: TIMESTAMP, noRetry() {} }) as unknown as ScheduledController;

const envFor = (): JobsEnv =>
  ({
    DATABASE_URL: "postgres://synthetic.invalid/never-connected",
    SYNC_EVENT_QUEUE: { send: async () => {} },
    CF_VERSION_METADATA: { tag: SHA },
  }) as unknown as JobsEnv;

let errorCalls: unknown[][] = [];
let spies: { mockRestore(): void }[] = [];

function scheduledLines(): { raw: string; line: Record<string, unknown> }[] {
  const { parsed, skipped } = parseJsonLines(errorCalls);
  expect(skipped, `unparsed log lines: ${JSON.stringify(skipped)}`).toEqual([]);
  const found: { raw: string; line: Record<string, unknown> }[] = [];
  for (const { raw, value: line } of parsed) {
    if (
      line &&
      typeof line === "object" &&
      !Array.isArray(line) &&
      (line as Record<string, unknown>).event === "scheduled.failing"
    ) {
      found.push({ raw, line: line as Record<string, unknown> });
    }
  }
  return found;
}

beforeEach(() => {
  errorCalls = [];
  state.clients = [];
  state.order = [];
  state.failTable = null;
  state.capTable = null;
  state.gateLockSweep = false;
  state.releaseLockSweep = null;
  __resetAlertRateLimitForTests();
  __resetReleaseForTests();
  spies = [
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    }),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  // Never leave a gated sweep dangling into the next test.
  state.releaseLockSweep?.();
  for (const spy of spies) spy.mockRestore();
  __resetReleaseForTests();
});

describe("scheduled prune drain settlement before pool cleanup (acceptance)", () => {
  it("waits for the in-flight lock sweep before closing pools, then pages the failure class once", async () => {
    state.failTable = "join_attempts";
    state.gateLockSweep = true;

    let settled = false;
    const pending = handleScheduled(controller(PRUNE_CRON), envFor()).then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    void pending.catch(() => {});

    try {
      await vi.waitFor(() => {
        expect(state.order).toContain("lock:start");
      });
      // join_attempts has already failed inside the flight. A fail-fast pass
      // would have rejected and closed the dispatch pool under the sweep.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled, "handler settled while the lock sweep was in flight").toBe(false);
      expect(
        state.order.filter((entry) => entry.startsWith("end:")),
        "a pool closed before the lock sweep settled",
      ).toHaveLength(0);
      expect(state.clients.every((client) => !client.ended)).toBe(true);
    } finally {
      state.releaseLockSweep?.();
    }

    await expect(pending).resolves.toBeUndefined();

    const settledAt = state.order.indexOf("lock:settled");
    const firstEnd = state.order.findIndex((entry) => entry.startsWith("end:"));
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(firstEnd).toBeGreaterThan(settledAt);
    expect(state.clients.length).toBeGreaterThanOrEqual(2);
    expect(state.clients.every((client) => client.ended)).toBe(true);

    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toEqual({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "SyntheticDbError",
      error_class: "SyntheticDbError",
      build_sha: SHA,
      release: SHA,
    });
    for (const banned of BANNED) expect(lines[0]!.raw).not.toContain(banned);
    expect(lines[0]!.raw).not.toContain(SECRET_MESSAGE);
  });

  it("a healthy prune pass stays silent and closes every pool (positive control)", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(errorCalls).toHaveLength(0);
    expect(state.clients.length).toBeGreaterThanOrEqual(2);
    expect(state.clients.every((client) => client.ended)).toBe(true);
  });

  it("cap and failure in one committed pass page exactly once, with the failure class", async () => {
    state.failTable = "join_attempts";
    state.capTable = "event_search_logs";

    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatchObject({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "SyntheticDbError",
      error_class: "SyntheticDbError",
    });
    expect(lines[0]!.raw).not.toContain("PruneBatchCapError");
    for (const banned of BANNED) expect(lines[0]!.raw).not.toContain(banned);
    expect(state.clients.length).toBeGreaterThanOrEqual(2);
    expect(state.clients.every((client) => client.ended)).toBe(true);
  });
});
