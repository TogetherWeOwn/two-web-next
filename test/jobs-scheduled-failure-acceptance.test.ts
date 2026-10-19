import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import {
  DeliveryMute,
  SPIKE_MIN_CRASHES,
  SPIKE_MIN_ERRORS,
  SPIKE_MIN_RATE,
  createTailWorker,
  parseAlert,
} from "../tail/worker";
import { parseJsonLines } from "./helpers/parse-json-lines";

// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): one failed known scheduled job pages directly, without
// waiting for the aggregate crash-loop gate.
//
// Source signal: exactly one single-line JSON object on console.error per
// failed reconcile/prune invocation:
//   { level: "critical", event: "scheduled.failing",
//     job: "events:reconcile" | "model:prune",
//     exception: <exception class>, error_class: <same class>,
//     build_sha: <40-hex | null>, release: <same as build_sha> }
// No other fields. Never the exception message, SQL, the cron expression,
// event keys or identities. The handler still rejects with the original
// error and still closes every pool, even when writing the signal throws.
// Healthy runs, advisory-lock skips and unknown crons stay silent.
//
// Tail signal: parseAlert accepts that line only for an allowlisted job and
// an identifier-shaped exception class, and the Tail Worker delivers one
// redacted page for a single failed invocation (fingerprint
// "scheduled.failing@<job>", build_sha from the existing release pair).
//
// Hermetic seams only: the postgres driver and the two job bodies are fakes;
// cron routing, the advisory-lock single flight, the scheduled handler and
// the Tail parser/delivery are the real code. No database is contacted.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");
const WEBHOOK = "https://discord.com/api/webhooks/123456789/test-only-token";
// Synthetic values that must never reach a source line, a page or a receipt.
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

beforeEach(() => {
  errorCalls = [];
  state.lockGranted = true;
  state.clients = [];
  state.reconcile.mockReset();
  state.prune.mockReset();
  state.reconcile.mockResolvedValue({ closed: 0, materialized: 0, resynced: 0 });
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

describe("scheduled failure source signal (acceptance)", () => {
  it("a failed reconcile emits one redacted scheduled.failing line, rejects and closes pools", async () => {
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

  it("a failed prune emits one redacted scheduled.failing line, rejects and closes pools", async () => {
    const failure = new TypeError(SECRET_MESSAGE);
    state.prune.mockRejectedValueOnce(failure);

    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).rejects.toBe(failure);

    expect(errorCalls).toHaveLength(1);
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toEqual({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "TypeError",
      error_class: "TypeError",
      build_sha: SHA,
      release: SHA,
    });
    expectClean(lines[0]!.raw);
    expectPoolsClosed();
  });

  it("every failed invocation emits: two spaced failures write two source lines", async () => {
    state.reconcile
      .mockRejectedValueOnce(new SyntheticDbError(SECRET_MESSAGE))
      .mockRejectedValueOnce(new SyntheticDbError(SECRET_MESSAGE));

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBeInstanceOf(
      SyntheticDbError,
    );
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBeInstanceOf(
      SyntheticDbError,
    );

    expect(scheduledLines()).toHaveLength(2);
    expectPoolsClosed(4);
  });

  it("healthy reconcile and prune runs stay silent and close pools", async () => {
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).toHaveBeenCalledOnce();
    expect(state.prune).toHaveBeenCalledOnce();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed(4);
  });

  it("advisory-lock skips stay silent: the job body never runs and nothing is emitted", async () => {
    state.lockGranted = false;
    state.reconcile.mockRejectedValue(new SyntheticDbError(SECRET_MESSAGE));
    state.prune.mockRejectedValue(new SyntheticDbError(SECRET_MESSAGE));

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.prune).not.toHaveBeenCalled();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed(4);
  });

  it("an unknown cron still fails loudly, emits no scheduled signal and closes pools", async () => {
    await expect(handleScheduled(controller("7 7 * * *"), envFor())).rejects.toThrow(
      "unknown cron",
    );

    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed();
  });

  it("a throwing alert sink cannot replace the original rejection or skip pool cleanup", async () => {
    const failure = new SyntheticDbError(SECRET_MESSAGE);
    state.reconcile.mockRejectedValueOnce(failure);
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBe(failure);
    expectPoolsClosed();
  });
});

describe("scheduled failure Tail paging (acceptance)", () => {
  const sourceLine = {
    level: "critical",
    event: "scheduled.failing",
    job: "model:prune",
    exception: "TypeError",
    error_class: "TypeError",
    build_sha: SHA,
    release: SHA,
    // Forged extra fields a real line never carries: none may be forwarded.
    cron: PRUNE_CRON,
    message: SECRET_MESSAGE,
    eventKey: "synthetic-event-key",
  };

  it("parseAlert rebuilds the scheduled summary and forwards no forged fields", async () => {
    const alert = await parseAlert(JSON.stringify(sourceLine), TIMESTAMP);
    expect(alert).toEqual({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@model:prune",
      job: "model:prune",
      exception: "TypeError",
      timestamp: "2026-10-01T00:00:00.000Z",
    });
    expectClean(JSON.stringify(alert));
  });

  it.each([
    { ...sourceLine, job: "*/10 * * * *" },
    { ...sourceLine, job: "unknown-job-never-send" },
    { ...sourceLine, job: undefined },
    { ...sourceLine, exception: SECRET_MESSAGE },
    { ...sourceLine, exception: "TypeError: synthetic-secret-value" },
    { ...sourceLine, exception: "" },
    { ...sourceLine, exception: 42 },
    { ...sourceLine, level: "info" },
  ])("parseAlert ignores malformed or non-allowlisted scheduled line %#", async (line) => {
    expect(await parseAlert(JSON.stringify(line), TIMESTAMP)).toBeNull();
  });

  it("one captured source line pages exactly once through the real Tail delivery", async () => {
    state.reconcile.mockRejectedValueOnce(new SyntheticDbError(SECRET_MESSAGE));
    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBeInstanceOf(
      SyntheticDbError,
    );
    const lines = scheduledLines();
    expect(lines).toHaveLength(1);

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

    // One sparse scheduled invocation, one page: the crash-loop gate (five
    // crashes in five minutes) is never approached.
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
      exception: "SyntheticDbError",
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

describe("scheduled failure runbook and unchanged gates (acceptance)", () => {
  it("the alerts runbook documents the new signal and both job discriminators", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    expect(runbook).toContain("scheduled.failing");
    expect(runbook).toContain("events:reconcile");
    expect(runbook).toContain("model:prune");
  });

  it("the aggregate spike thresholds are unchanged (no lowering the crash gate instead)", () => {
    expect(SPIKE_MIN_ERRORS).toBe(5);
    expect(SPIKE_MIN_CRASHES).toBe(5);
    expect(SPIKE_MIN_RATE).toBe(0.5);
  });
});
