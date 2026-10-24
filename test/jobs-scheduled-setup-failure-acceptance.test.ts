import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import { parseJsonLines } from "./helpers/parse-json-lines";

// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): pool SETUP failures of a known scheduled job page exactly
// like job-body failures do, and partially acquired pools are closed.
//
// The jobs worker acquires both SQL pools before the boundary that emits the
// redacted `scheduled.failing` signal and closes the pools. A setup failure
// (missing database configuration, or a driver construction that throws)
// therefore escapes with no direct signal, and when the second construction
// fails the first, successfully created client is stranded unclosed.
//
// Required behaviour:
//   - a known reconcile/prune setup failure emits exactly one existing-format
//     redacted scheduled.failing line (same fields as a body failure, no new
//     fields, never the exception message, SQL, cron expression, event keys
//     or identities) and the invocation still rejects with the ORIGINAL
//     error, even when writing the signal throws;
//   - if the second client construction fails, the first created client is
//     closed exactly once; a client that was never created is never closed;
//     a failing close never replaces the original rejection;
//   - unknown crons stay silent on this direct signal; healthy invocations
//     and advisory-lock skips keep their existing behaviour.
//
// Hermetic seams only: the postgres driver is a scripted fake whose
// construction can be made to throw per attempt, and the two job bodies are
// fakes. Cron routing, the advisory-lock single flight and the scheduled
// handler are the real code. No database is contacted.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = Date.parse("2026-10-01T00:00:00Z");
// Synthetic values that must never reach a source line.
const SECRET_MESSAGE =
  "connect postgres://synthetic.invalid/never-connected failed for " +
  "event synthetic-event-key and member synthetic-member-id";
const BANNED = [
  "synthetic-event-key",
  "synthetic-member-id",
  "never-connected",
  "no database configured",
];

class SyntheticPoolError extends Error {}
class SyntheticCloseError extends Error {}

const state = vi.hoisted(() => ({
  lockGranted: true,
  attempts: 0,
  clients: [] as { ended: boolean; endCalls: number }[],
  // Per construction-attempt index: throw this instead of returning a client.
  constructionErrors: [] as (Error | undefined)[],
  endError: undefined as Error | undefined,
  reconcile: vi.fn(),
  prune: vi.fn(),
}));

vi.mock("postgres", () => {
  const construct = () => {
    const attempt = state.attempts++;
    const failure = state.constructionErrors[attempt];
    if (failure) throw failure;
    const record = { ended: false, endCalls: 0 };
    state.clients.push(record);
    const client = Object.assign(async (..._args: unknown[]) => [{ got: state.lockGranted }], {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return run(client);
      },
      end: async () => {
        record.endCalls += 1;
        record.ended = true;
        if (state.endError) throw state.endError;
      },
    });
    return client;
  };
  return { default: vi.fn((() => construct()) as unknown as typeof postgres) };
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

// No DATABASE_URL and no database binding: pool setup itself must throw.
const envMissingDb = (): JobsEnv =>
  ({
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

function expectOneSignal(job: string, exception: string): void {
  expect(errorCalls).toHaveLength(1);
  const lines = scheduledLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]!.line).toEqual({
    level: "critical",
    event: "scheduled.failing",
    job,
    exception,
    error_class: exception,
    build_sha: SHA,
    release: SHA,
  });
  for (const banned of BANNED) expect(lines[0]!.raw).not.toContain(banned);
  expect(lines[0]!.raw).not.toContain(RECONCILE_CRON);
  expect(lines[0]!.raw).not.toContain(PRUNE_CRON);
  expect(lines[0]!.raw).not.toContain(SECRET_MESSAGE);
}

function expectPoolsClosed(minClients = 2): void {
  expect(state.clients.length).toBeGreaterThanOrEqual(minClients);
  expect(state.clients.every((client) => client.ended)).toBe(true);
}

beforeEach(() => {
  errorCalls = [];
  state.lockGranted = true;
  state.attempts = 0;
  state.clients = [];
  state.constructionErrors = [];
  state.endError = undefined;
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

describe("scheduled pool-setup failures (acceptance)", () => {
  it("reconcile with no database configured rejects and emits one redacted signal", async () => {
    await expect(handleScheduled(controller(RECONCILE_CRON), envMissingDb())).rejects.toThrow(
      "no database configured",
    );

    expectOneSignal("events:reconcile", "Error");
    expect(state.clients).toHaveLength(0);
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("prune with no database configured rejects and emits one redacted signal", async () => {
    await expect(handleScheduled(controller(PRUNE_CRON), envMissingDb())).rejects.toThrow(
      "no database configured",
    );

    expectOneSignal("model:prune", "Error");
    expect(state.clients).toHaveLength(0);
    expect(state.prune).not.toHaveBeenCalled();
  });

  it("a failing second construction closes the first client, emits one signal and rejects with the original error", async () => {
    const failure = new SyntheticPoolError(SECRET_MESSAGE);
    state.constructionErrors = [undefined, failure];

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBe(failure);

    expectOneSignal("events:reconcile", "SyntheticPoolError");
    expect(state.attempts).toBe(2);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.clients[0]!.endCalls).toBe(1);
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("a failing first construction closes nothing, emits one signal and rejects with the original error", async () => {
    const failure = new SyntheticPoolError(SECRET_MESSAGE);
    state.constructionErrors = [failure];

    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).rejects.toBe(failure);

    expectOneSignal("model:prune", "SyntheticPoolError");
    expect(state.attempts).toBe(1);
    expect(state.clients).toHaveLength(0);
    expect(state.prune).not.toHaveBeenCalled();
  });

  it("a failing close of the partially acquired client never replaces the original rejection", async () => {
    const failure = new SyntheticPoolError(SECRET_MESSAGE);
    state.constructionErrors = [undefined, failure];
    state.endError = new SyntheticCloseError("synthetic close failure");

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBe(failure);

    expectOneSignal("events:reconcile", "SyntheticPoolError");
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.endCalls).toBe(1);
  });

  it("a throwing alert sink cannot replace the setup rejection or skip closing the first client", async () => {
    const failure = new SyntheticPoolError(SECRET_MESSAGE);
    state.constructionErrors = [undefined, failure];
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).rejects.toBe(failure);

    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]!.ended).toBe(true);
    expect(state.clients[0]!.endCalls).toBe(1);
  });

  it("a throwing alert sink cannot replace a missing-database setup rejection", async () => {
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });

    await expect(handleScheduled(controller(PRUNE_CRON), envMissingDb())).rejects.toThrow(
      "no database configured",
    );
    expect(state.clients).toHaveLength(0);
  });
});

describe("scheduled pool-setup controls (acceptance)", () => {
  it("an unknown cron still fails loudly, emits no scheduled signal and closes pools", async () => {
    await expect(handleScheduled(controller("7 7 * * *"), envFor())).rejects.toThrow(
      "unknown cron",
    );

    expect(scheduledLines()).toHaveLength(0);
    expectPoolsClosed();
  });

  it("an unknown cron with no database configured rejects and stays silent on this signal", async () => {
    let caught: unknown;
    try {
      await handleScheduled(controller("7 7 * * *"), envMissingDb());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(scheduledLines()).toHaveLength(0);
    expect(state.clients.every((client) => client.ended)).toBe(true);
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
    state.reconcile.mockRejectedValue(new SyntheticPoolError(SECRET_MESSAGE));
    state.prune.mockRejectedValue(new SyntheticPoolError(SECRET_MESSAGE));

    await expect(handleScheduled(controller(RECONCILE_CRON), envFor())).resolves.toBeUndefined();
    await expect(handleScheduled(controller(PRUNE_CRON), envFor())).resolves.toBeUndefined();

    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.prune).not.toHaveBeenCalled();
    expect(errorCalls).toHaveLength(0);
    expectPoolsClosed(4);
  });
});
