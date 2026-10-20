// Post-commit prune cap paging (implementation-owned regression proof).
// A capped model:prune drain must page only after the advisory-lock flight
// commits: a pre-commit cap page shares the Tail mute key
// scheduled.failing@model:prune with a later commit failure's page, muting
// the real failure. A rolled-back pass therefore pages only its real error,
// while a committed capped pass still pages exactly once.
//
// Hermetic seams only: the postgres driver is a fake (full-batch deletes,
// controllable commit), cron routing, the advisory-lock single flight, the
// scheduled handler and the Tail parser/delivery are the real code. The
// direct-call paging contract stays pinned by
// test/prune-cap-paging-acceptance.test.ts, which this file must not weaken.
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import {
  PRUNE_DELETE_BATCH_SIZE,
  PRUNE_DELETE_MAX_BATCHES,
  PRUNE_CRON,
} from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import type { PruneStores } from "../src/jobs/types";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import { createMemorySessionStore } from "../src/sessions";
import { createTailWorker, DeliveryMute } from "../tail/worker";
import { parseJsonLines } from "./helpers/parse-json-lines";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");
const WEBHOOK = "https://discord.com/api/webhooks/123456789/test-only-token";
const NOW = new Date("2026-09-30T00:00:00Z");
const PER_PASS_CAP = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;

const state = vi.hoisted(() => {
  class CommitFailedError extends Error {
    constructor() {
      super("synthetic commit failure");
      this.name = "CommitFailedError";
    }
  }
  return {
    CommitFailedError,
    throwOnCommit: false,
    clients: [] as { ended: boolean }[],
  };
});

vi.mock("postgres", () => {
  const makeClient = () => {
    const record = { ended: false };
    state.clients.push(record);
    const fullBatch = Array.from({ length: PRUNE_DELETE_BATCH_SIZE }, () => ({}));
    type Settings = { lock: string; statement: string };
    const makeTag =
      (settings: Settings) =>
      async (
        parts: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<Record<string, unknown>[]> => {
        const text = parts.join(" ").toLowerCase();
        if (text.includes("pg_try_advisory_xact_lock")) return [{ got: true }];
        if (text.includes("current_setting(")) return [{ ...settings }];
        if (text.includes("set_config(")) {
          settings.lock = values[0] as string;
          settings.statement = values[1] as string;
          return [{ set_config: settings.statement }];
        }
        // Only deletes fill a batch; settings reads are not prune results.
        return text.trimStart().startsWith("delete from ") ? fullBatch : [];
      };
    // Table savepoints are not commits. Give each scope its own function and
    // roll back its local settings on failure without poisoning the flight.
    const makeTransaction = (settings: Settings) =>
      Object.assign(makeTag(settings), {
        savepoint: async (...args: unknown[]): Promise<unknown> => {
          const run = args.find((arg) => typeof arg === "function") as (
            tx: unknown,
          ) => Promise<unknown>;
          const local = { ...settings };
          const out = await run(makeTransaction(local));
          Object.assign(settings, local);
          return out;
        },
      });
    const settings: Settings = { lock: "0", statement: "0" };
    const client = Object.assign(makeTag(settings), {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        const out = await run(makeTransaction({ ...settings }));
        // Commit happens after the body resolves: a capped drain followed by
        // a failing commit is exactly the masking scenario under test.
        if (state.throwOnCommit) throw new state.CommitFailedError();
        return out;
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

async function deliveredExceptions(rawLines: string[]): Promise<Record<string, unknown>[]> {
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: () => {},
    mute: new DeliveryMute(() => TIMESTAMP),
  });
  await worker.tail(
    [
      {
        scriptName: "two-web-jobs",
        logs: rawLines.map((message) => ({
          message: [message],
          timestamp: TIMESTAMP,
          level: "error",
        })),
      },
    ],
    { OPS_ALERT_WEBHOOK_URL: WEBHOOK },
  );
  return send.mock.calls.map((call) => {
    const [, init] = call as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { content: string };
    return JSON.parse(payload.content) as Record<string, unknown>;
  });
}

beforeEach(() => {
  errorCalls = [];
  state.throwOnCommit = false;
  state.clients = [];
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

const zeroTable = () => ({
  async pruneOlderThan(_cutoff: Date): Promise<number> {
    return 0;
  },
});

function stubStores(): PruneStores {
  const endless = {
    async pruneOlderThan(_cutoff: Date): Promise<number> {
      return PRUNE_DELETE_BATCH_SIZE;
    },
  };
  const empty = zeroTable();
  return {
    agentEventAudits: empty,
    accessLog: empty,
    joinAttempts: endless,
    idempotencyKeys: empty,
    searchLog: empty,
    boardViews: empty,
    sessions: createMemorySessionStore(() => NOW.getTime()),
    jobUniqueLocks: {
      async sweepExpired(_now: Date): Promise<number> {
        return 0;
      },
    },
  };
}

describe("prune cap report seam (no DB)", () => {
  it("a capped drain reports true without paging when deferred", async () => {
    const reported: boolean[] = [];
    const counts = await pruneModelTables(stubStores(), NOW, {
      reportCap: (capped) => {
        reported.push(capped);
      },
    });

    expect(counts.joinAttempts).toBe(PER_PASS_CAP);
    expect(reported).toEqual([true]);
    expect(scheduledLines()).toHaveLength(0);
  });

  it("an uncapped drain reports false and stays silent", async () => {
    const reported: boolean[] = [];
    const stores = stubStores();
    stores.joinAttempts = zeroTable();
    const counts = await pruneModelTables(stores, NOW, {
      reportCap: (capped) => {
        reported.push(capped);
      },
    });

    expect(counts.joinAttempts).toBe(0);
    expect(reported).toEqual([false]);
    expect(scheduledLines()).toHaveLength(0);
  });
});

describe("scheduled prune cap paging across commit outcomes (fake driver)", () => {
  it("a capped pass that commits pages PruneBatchCapError once", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    const lines = scheduledLines();
    expect(errorCalls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatchObject({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "PruneBatchCapError",
      error_class: "PruneBatchCapError",
    });

    const summaries = await deliveredExceptions(lines.map((entry) => entry.raw));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@model:prune",
      exception: "PruneBatchCapError",
    });
    expect(state.clients.length).toBeGreaterThanOrEqual(2);
    expect(state.clients.every((client) => client.ended)).toBe(true);
  });

  it("a capped pass whose commit fails pages only the real error", async () => {
    state.throwOnCommit = true;

    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).rejects.toBeInstanceOf(
      state.CommitFailedError,
    );

    // Exactly one source line, and it is the commit failure: no cap page may
    // precede it and mute it in the Tail window.
    const lines = scheduledLines();
    expect(errorCalls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatchObject({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "CommitFailedError",
      error_class: "CommitFailedError",
    });
    for (const args of errorCalls) expect(String(args[0])).not.toContain("PruneBatchCapError");

    const summaries = await deliveredExceptions(lines.map((entry) => entry.raw));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@model:prune",
      exception: "CommitFailedError",
    });
    expect(state.clients.length).toBeGreaterThanOrEqual(2);
    expect(state.clients.every((client) => client.ended)).toBe(true);
  });
});
