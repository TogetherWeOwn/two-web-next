import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import { DeliveryMute, createTailWorker, parseAlert } from "../tail/worker";
import { parseJsonLines } from "./helpers/parse-json-lines";

// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): a RESOLVED scheduled reconcile that isolated one or more
// failed dispatch keys pages once, instead of the failure count being
// discarded by the scheduled wrapper while Tail ignores the warn/info lines.
//
// Source signal: after the scheduled reconcile resolves with failed > 0, the
// scheduled wrapper emits exactly one single-line JSON object on
// console.error in the existing scheduled.failing format:
//   { level: "critical", event: "scheduled.failing",
//     job: "events:reconcile",
//     exception: <dedicated identifier-shaped class>, error_class: <same>,
//     build_sha: <40-hex | null>, release: <same as build_sha> }
// No other fields. The exception is a dedicated class for this resolved
// partial-failure signal (not a bare "Error"), so an operator can tell a
// committed pass with isolated failures apart from a thrown outage, which
// keeps carrying the real exception class. The alerts runbook names that
// class and gives its first read-only check: the same pass's
// "Event reconcile pass completed." counts in the jobs Worker logs.
//
// The signal is emitted by the scheduled wrapper after the resolved result
// (the prune-cap post-commit precedent), not inside reconcileEvents: a
// direct reconcile call stays page-free, and a later flight failure cannot
// be muted by an earlier partial-failure page. The wrapper still RESOLVES
// for a partial pass (isolated failures are never rethrown), healthy,
// absorbed-only, skipped and advisory-lock-skipped passes stay silent, the
// existing all-failed throw path keeps exactly its one existing page, and a
// throwing alert sink cannot fail a resolved pass or skip pool cleanup.
// No event keys, SQL, raw exception messages, member data, cron expressions
// or secrets enter the source line or the delivered page.
//
// Hermetic seams only: the postgres driver and the two job bodies are fakes;
// cron routing, the advisory-lock single flight, the scheduled handler and
// the Tail parser/delivery are the real code. No database is contacted. The
// poison-key isolation and healthy-dispatch preservation behind these counts
// are pinned against the real reconcileEvents in
// jobs-reconcile-partial-isolation-acceptance.test.ts.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");
const WEBHOOK = "https://discord.com/api/webhooks/123456789/test-only-token";
const SECRET_MESSAGE =
  "delete from join_attempts where request_id = 'synthetic-secret-value' " +
  "for event synthetic-event-key and member synthetic-member-id";
const BANNED = [
  "synthetic-secret-value",
  "synthetic-event-key",
  "synthetic-member-id",
  "delete from",
  "test-only-token",
];

class SyntheticDbError extends Error {}

const state = vi.hoisted(() => ({
  lockGranted: true,
  clients: [] as { ended: boolean }[],
  reconcile: vi.fn(),
  prune: vi.fn(),
}));

vi.mock("postgres", () => {
  const makeClient = () => {
    const record = { ended: false };
    state.clients.push(record);
    const client = Object.assign(async (..._args: unknown[]) => [{ got: state.lockGranted }], {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return run(client);
      },
      end: async () => {
        record.ended = true;
      },
    });
    return client;
  };
  return { default: vi.fn((() => makeClient()) as unknown as typeof postgres) };
});

vi.mock(import("../src/jobs/cron"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reconcileEvents: (...args: Parameters<typeof actual.reconcileEvents>) =>
      state.reconcile(...args),
    pruneModelTables: (...args: Parameters<typeof actual.pruneModelTables>) => state.prune(...args),
  };
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

function expectPoolsClosed(minClients = 2): void {
  expect(state.clients.length).toBeGreaterThanOrEqual(minClients);
  expect(state.clients.every((client) => client.ended)).toBe(true);
}

function expectClean(text: string): void {
  for (const banned of BANNED) expect(text).not.toContain(banned);
  expect(text).not.toContain(RECONCILE_CRON);
  expect(text).not.toContain(PRUNE_CRON);
  expect(text).not.toContain(SECRET_MESSAGE);
}

/** The one partial-failure page line: exact existing shape, dedicated class. */
function expectPartialLine(line: Record<string, unknown>): string {
  expect(Object.keys(line).sort()).toEqual([
    "build_sha",
    "error_class",
    "event",
    "exception",
    "job",
    "level",
    "release",
  ]);
  expect(line.level).toBe("critical");
  expect(line.event).toBe("scheduled.failing");
  expect(line.job).toBe("events:reconcile");
  expect(line.build_sha).toBe(SHA);
  expect(line.release).toBe(SHA);
  expect(typeof line.exception).toBe("string");
  expect(line.exception as string).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  expect(line.exception).not.toBe("Error");
  expect(line.error_class).toBe(line.exception);
  return line.exception as string;
}

beforeEach(() => {
  errorCalls = [];
  state.lockGranted = true;
  state.clients = [];
  state.reconcile.mockReset();
  state.prune.mockReset();
  state.reconcile.mockResolvedValue({
    closed: 0,
    materialized: 0,
    resynced: 0,
    absorbed: 0,
    failed: 0,
  });
  state.prune.mockResolvedValue({});
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

describe("resolved partial reconcile failure pages once (acceptance)", () => {
  it("a single failed key in a resolved pass emits one scheduled.failing line and still resolves", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 0,
      failed: 1,
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).toHaveBeenCalledOnce();
    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expectPartialLine(lines[0]!.line);
    expectClean(lines[0]!.raw);
    expectPoolsClosed();
  });

  it("a mixed pass (healthy and absorbed dispatches plus failures) emits exactly one line, not one per failed key", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 1,
      materialized: 0,
      resynced: 2,
      absorbed: 1,
      failed: 2,
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expectPartialLine(lines[0]!.line);
    expectClean(lines[0]!.raw);
    expectPoolsClosed();
  });

  it("every partial invocation emits: two spaced partial passes write two source lines", async () => {
    state.reconcile
      .mockResolvedValueOnce({ closed: 0, materialized: 0, resynced: 1, absorbed: 0, failed: 1 })
      .mockResolvedValueOnce({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 1 });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(scheduledLines()).toHaveLength(2);
    expectPoolsClosed(4);
  });

  it("a throwing alert sink cannot fail a resolved partial pass or skip pool cleanup", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 0,
      materialized: 0,
      resynced: 1,
      absorbed: 0,
      failed: 1,
    });
    let sinkAttempts = 0;
    vi.mocked(console.error).mockImplementation(() => {
      sinkAttempts++;
      throw new Error("synthetic sink failure");
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    // The page was attempted exactly once, and its failure changed nothing.
    expect(sinkAttempts).toBe(1);
    expectPoolsClosed();
  });
});

describe("resolved partial reconcile failure stays silent when it should (acceptance)", () => {
  it("a healthy resolved pass (failed 0 with dispatches) emits nothing", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 1,
      materialized: 1,
      resynced: 3,
      absorbed: 0,
      failed: 0,
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("an absorbed-only resolved pass (failed 0) emits nothing", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 2,
      failed: 0,
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("an all-zero skipped/empty resolved pass emits nothing", async () => {
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).toHaveBeenCalledOnce();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("an advisory-lock skip emits nothing: the job body never runs", async () => {
    state.lockGranted = false;
    state.reconcile.mockResolvedValue({
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 0,
      failed: 5,
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).not.toHaveBeenCalled();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("a healthy prune run emits nothing from the partial-failure path", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.prune).toHaveBeenCalledOnce();
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("the all-failed throw path keeps exactly its one existing page with the real class", async () => {
    const failure = new SyntheticDbError(SECRET_MESSAGE);
    state.reconcile.mockRejectedValueOnce(failure);

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBe(failure);

    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toEqual({
      level: "critical",
      event: "scheduled.failing",
      job: "events:reconcile",
      exception: "SyntheticDbError",
      error_class: "SyntheticDbError",
      build_sha: SHA,
      release: SHA,
    });
    expectClean(lines[0]!.raw);
    expectPoolsClosed();
  });
});

describe("resolved partial reconcile failure Tail paging (acceptance)", () => {
  it("one captured partial-failure line pages exactly once through the real Tail delivery", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 0,
      materialized: 0,
      resynced: 2,
      absorbed: 0,
      failed: 1,
    });
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    const exceptionClass = expectPartialLine(lines[0]!.line);

    const alert = await parseAlert(lines[0]!.raw, TIMESTAMP);
    expect(alert).toEqual({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@events:reconcile",
      job: "events:reconcile",
      exception: exceptionClass,
      timestamp: "2026-10-01T00:00:00.000Z",
    });

    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => TIMESTAMP),
    });
    await worker.tail(
      [
        {
          scriptName: "two-web-jobs",
          logs: [{ message: [lines[0]!.raw], timestamp: TIMESTAMP, level: "error" }],
        },
      ],
      { OPS_ALERT_WEBHOOK_URL: WEBHOOK },
    );

    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${WEBHOOK}?wait=true`);
    const payload = JSON.parse(init.body as string) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const summary = JSON.parse(payload.content) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "build_sha",
      "event",
      "exception",
      "fingerprint",
      "job",
      "logs",
      "script",
      "timestamp",
    ]);
    expect(summary).toMatchObject({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@events:reconcile",
      job: "events:reconcile",
      exception: exceptionClass,
      script: "two-web-jobs",
      build_sha: SHA,
      logs: "Workers & Pages > two-web-jobs > Observability > Logs",
    });
    expectClean(payload.content);
    expect(sink).toHaveBeenCalledOnce();
    expectClean(String(sink.mock.calls[0]![0]));
    expect(JSON.parse(String(sink.mock.calls[0]![0]))).toMatchObject({
      event: "scheduled.failing",
      delivery: "ops.alert.delivered",
    });
  });
});

describe("resolved partial reconcile failure runbook (acceptance)", () => {
  it("the alerts runbook names the emitted class and its first read-only check", async () => {
    state.reconcile.mockResolvedValueOnce({
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 0,
      failed: 1,
    });
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    const exceptionClass = expectPartialLine(lines[0]!.line);

    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    // The class the page actually carries is the class the runbook explains,
    // and the first check is read-only log inspection of the same pass's
    // completed-pass counts (never a live queue/Discord probe).
    expect(runbook).toContain(exceptionClass);
    expect(runbook).toContain("Event reconcile pass completed");
  });
});
