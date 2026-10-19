import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, JobsEnv } from "../src/env";
import { enqueueSyncEvent, handleQueue } from "../src/jobs/worker";

// Pool-close regression: every sibling close in worker.ts swallows
// `sql.end({ timeout: 1 })` failures, but enqueueSyncEvent and handleQueue's
// main pool awaited the close bare. A failing close must never replace the
// dispatch result or reject the batch.
vi.mock("postgres", () => ({ default: vi.fn() }));
vi.mock("../src/jobs/consumer", () => ({ consume: vi.fn(async () => {}) }));
vi.mock("../src/jobs/sync-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/jobs/sync-event")>();
  return { ...actual, dispatchSyncEvent: vi.fn(async () => true) };
});

function fakeSql() {
  const sql = Object.assign(
    vi.fn(async () => []),
    {
      end: vi.fn(async () => {
        throw new Error("pool close failed");
      }),
    },
  );
  return sql;
}

const env = () =>
  ({
    DATABASE_URL: "postgres://pool-close.invalid/db",
    SYNC_EVENT_QUEUE: { send: vi.fn(async () => {}) },
    INTERNAL_ACTION_QUEUE: { send: vi.fn(async () => {}) },
  }) as unknown as Env & JobsEnv;

let unhandled: unknown[];
let onUnhandled: (reason: unknown) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postgres).mockImplementation(() => fakeSql() as unknown as postgres.Sql);
  unhandled = [];
  onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

describe("worker pool-close failures stay silent", () => {
  it("enqueueSyncEvent still returns the dispatch result when close fails", async () => {
    const result = await enqueueSyncEvent(env(), {
      kind: "sync-event",
      eventKey: "e1",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("handleQueue still resolves the batch when closes fail", async () => {
    await handleQueue({ messages: [] } as unknown as MessageBatch<unknown>, env());
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
