// Worker-level pin (implementation-owned): the scheduled model:prune pass runs
// the job_unique_locks sweep on the separate dispatch pool — one short
// per-statement transaction per batch — never inside the flight transaction.
// Inside the flight, the sweep's DELETE would hold row locks until the whole
// nine-table pass commits, blocking a concurrent acquire (INSERT ..
// ON CONFLICT) on the deleting transaction. Uses the established
// worker-harness pattern: fake postgres driver, real cron / single-flight /
// prune stores / scheduled handler.
//
// This complements the adapter-level held-open case in
// test/prune-skip-locked.test.ts, which hand-wires a dispatch-like pool and a
// concurrent acquire but never executes the real handleScheduled prune path:
// deleting the worker override keeps that case green.
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");

const state = vi.hoisted(() => ({
  clients: [] as { ended: boolean }[],
  queries: [] as { scope: string; text: string }[],
  beginCounts: [] as number[],
  savepointCount: 0,
}));

vi.mock("postgres", () => {
  const makeClient = () => {
    const index = state.clients.length;
    const record = { ended: false };
    state.clients.push(record);
    state.beginCounts.push(0);
    type Settings = { lock: string; statement: string };
    // Every query records the scope that issued it: `c<n>` for pool-level
    // calls, `c<n>/begin#<k>` for transactions, `/sp#<k>` suffixes for
    // savepoints. The flight is client 0's first begin; the dispatch pool is
    // client 1.
    const makeTag =
      (settings: Settings, scope: string) =>
      async (
        parts: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<Record<string, unknown>[]> => {
        const text = parts.join(" ").toLowerCase();
        state.queries.push({ scope, text });
        if (text.includes("pg_try_advisory_xact_lock")) return [{ got: true }];
        if (text.includes("current_setting(")) return [{ ...settings }];
        if (text.includes("set_config(")) {
          settings.lock = values[0] as string;
          settings.statement = values[1] as string;
          return [{ set_config: settings.statement }];
        }
        if (
          text.includes("savepoint") ||
          text.includes("rollback to") ||
          text.includes("release ")
        ) {
          return [];
        }
        return [];
      };
    const makeTransaction = (settings: Settings, scope: string) =>
      Object.assign(makeTag(settings, scope), {
        savepoint: async (...args: unknown[]): Promise<unknown> => {
          const run = args.find((arg) => typeof arg === "function") as (
            tx: unknown,
          ) => Promise<unknown>;
          const n = state.savepointCount++;
          const local = { ...settings };
          const out = await run(makeTransaction(local, `${scope}/sp#${n}`));
          Object.assign(settings, local);
          return out;
        },
      });
    const settings: Settings = { lock: "0", statement: "0" };
    const client = Object.assign(makeTag(settings, `c${index}`), {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        const n = state.beginCounts[index]!++;
        return run(makeTransaction({ ...settings }, `c${index}/begin#${n}`));
      },
      end: async () => {
        record.ended = true;
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

beforeEach(() => {
  errorCalls = [];
  state.clients = [];
  state.queries = [];
  state.beginCounts = [];
  state.savepointCount = 0;
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
  for (const spy of spies) spy.mockRestore();
  __resetReleaseForTests();
});

describe("scheduled prune lock-sweep wiring (worker level)", () => {
  it("runs the lock sweep on the dispatch pool, outside the flight transaction", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.clients.length).toBe(2);
    expect(errorCalls).toHaveLength(0);
    const sweeps = state.queries.filter((q) => q.text.includes("delete from job_unique_locks"));
    expect(sweeps.length, "expected at least one lock-sweep statement").toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect(
        sweep.scope.startsWith("c1/begin"),
        `sweep ran outside the dispatch pool per-statement transaction: ${sweep.scope}`,
      ).toBe(true);
    }
    expect(
      sweeps.every((sweep) => !sweep.scope.startsWith("c0")),
      "sweep touched the flight client",
    ).toBe(true);
  });

  it("drains age tables inside the flight transaction (scope-tracking control)", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    const drains = state.queries.filter((q) => q.text.includes("delete from join_attempts"));
    expect(drains.length, "expected at least one age-table drain").toBeGreaterThan(0);
    for (const drain of drains) {
      expect(
        drain.scope.startsWith("c0/begin"),
        `age drain ran outside the flight transaction: ${drain.scope}`,
      ).toBe(true);
    }
  });
});
