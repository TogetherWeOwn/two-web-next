// Failing-first acceptance: structured fields for queue/agent console lines.
//
// Five console lines carry positional or bare shapes today; the build gives
// each a named-key object while keeping every message string byte-identical:
// - "queue ledger compensation failed" gains { job_id, exception }
// - "queue lock release timed out" gains { scope }
// - "queue lock release failed" gains { scope, exception } (single object)
// - "agent-events failed" (admission + route sites) gains { exception } via a
//   bounded class helper (non-Error throws log their type, never undefined)
// - "sync terminal claim reopen timed out" gains { scope } (sanitized)
//
// Each test below asserts the structured shape and fails on the current
// positional/bare code. Leak assertions pin that no SQL, binding, token or
// Discord ID from a thrown message reaches any logged argument. Hermetic
// stub ledger/lock/store/bot and an in-process postgres mock only; no
// database, queue, network or live Discord.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { agentEventsRoute } from "../src/agent-events/route";
import { consume } from "../src/jobs/consumer";
import { SYNC_EVENT } from "../src/jobs/constants";
import { trackingQueue } from "../src/jobs/ledger";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  QueueMessage,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

// Synthetic leak markers (never real credentials): every throwing stub embeds
// all five in its message, and no logged argument may contain any of them.
const LEAK_SQL = "SELECT * FROM queue_jobs WHERE job_id = 'leak-bound-uuid-0000'";
const LEAK_BINDING = "leak-bound-value-acceptance-3f7a";
const LEAK_TOKEN = "***synthetic-acceptance-token-7k2m***";
const LEAK_DISCORD_ID = "777666555444333222";
const LEAK_SECRET = "***synthetic-acceptance-secret-9p4r***";
const LEAKS = [LEAK_SQL, LEAK_BINDING, LEAK_TOKEN, LEAK_DISCORD_ID, LEAK_SECRET];
const leakMessage = (prefix: string) => `${prefix}: ${LEAKS.join(" | ")}`;

const LEDGER_WARN = "queue ledger compensation failed";
const LOCK_TIMEOUT_WARN = "queue lock release timed out";
const LOCK_FAILED_WARN = "queue lock release failed";
const AGENT_FAILED = "agent-events failed";
const REOPEN_TIMEOUT_WARN = "sync terminal claim reopen timed out";

// Lock scope is the unique lock key (sync-event:<eventKey>), sanitized to one
// bounded line. Reopen scope is the event key in scope at the warn site; the
// build may log the raw event key or the unique key form, so reopen tests
// accept either sanitized shape.
const sanitizeScope = (value: string): string => value.replace(/[\r\n]+/g, "_").slice(0, 200);
const uniqueKeyOf = (eventKey: string): string => `sync-event:${eventKey}`;

let warns: unknown[][];
let errors: unknown[][];
beforeEach(() => {
  warns = [];
  errors = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  vi.spyOn(console, "info").mockImplementation(() => {});
  __resetAlertRateLimitForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const warnsFor = (message: string): unknown[][] => warns.filter((c) => c[0] === message);
const errorsFor = (message: string): unknown[][] => errors.filter((c) => c[0] === message);
const allLoggedJson = (): string => JSON.stringify([...warns, ...errors]);
const expectLeakFree = (): void => {
  const text = allLoggedJson();
  for (const leak of LEAKS) expect(text).not.toContain(leak);
};

class CompensationStoreError extends Error {
  override name = "CompensationStoreError";
}
class LockStoreError extends Error {
  override name = "LockStoreError";
}
class HandlerStoreError extends Error {
  override name = "HandlerStoreError";
}

function memLedger(over: Partial<QueueLedger> = {}): {
  ledger: QueueLedger;
  enqueuedJobIds: string[];
} {
  const enqueuedJobIds: string[] = [];
  const rows = new Map<string, string>();
  const ledger: QueueLedger = {
    enqueued: async (j) => {
      enqueuedJobIds.push(j.jobId);
      rows.set(j.jobId, "pending");
    },
    reserved: async (id) => void rows.set(id, "reserved"),
    released: async (id) => void rows.set(id, "released"),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id) => void rows.set(id, "failed"),
    ...over,
  };
  return { ledger, enqueuedJobIds };
}

function syncMessage(body: Record<string, unknown>, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(() => {}),
    retry: vi.fn((_o?: { delaySeconds?: number }) => {}),
  };
}

function exhaustedSyncDeps(lock: UniqueLock, ledger: QueueLedger) {
  const attempt: SyncAttempt = {
    idempotencyKey: "k-acceptance",
    eventKey: "e-acceptance",
    revision: 1,
    action: "event.upsert",
    payload: {
      eventKey: "e-acceptance",
      name: "n",
      startsAt: "s",
      endsAt: null,
      location: "l",
      description: null,
    },
    mirroredAt: new Date(0),
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: new Date(0),
  };
  const events = {
    prepareSync: async () => attempt,
    claimSync: async () => attempt,
    completeSync: async () => {},
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  } as unknown as EventStore;
  // An escaping throw (not a transport wait) drives the consumer's exhausted
  // throw path end to end, which releases the lock before the terminal ack.
  const bot = {
    upsertEvent: async () => {
      throw new TypeError(leakMessage("bot boom"));
    },
  } as unknown as BotClient;
  return { bot, events, lock, ledger };
}

describe("ledger compensation carries named keys", () => {
  const body = {
    kind: "sync-event",
    eventKey: "e-acceptance-ledger",
    idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  } as unknown as QueueMessage;

  it("an Error compensation failure logs { job_id, exception } class-only", async () => {
    const { ledger, enqueuedJobIds } = memLedger({
      dequeued: async () => {
        throw new CompensationStoreError(leakMessage("compensation down"));
      },
    });
    const queue = trackingQueue(
      {
        send: async () => {
          throw new Error("transport refused");
        },
      },
      ledger,
    );

    await expect(queue.send(body)).rejects.toThrow("transport refused");
    expect(enqueuedJobIds).toHaveLength(1);
    const jobId = enqueuedJobIds[0]!;

    const lines = warnsFor(LEDGER_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([LEDGER_WARN, { job_id: jobId, exception: "CompensationStoreError" }]);
    expectLeakFree();
  });

  it("a string compensation failure logs typeof, never undefined or the text", async () => {
    const { ledger, enqueuedJobIds } = memLedger({
      dequeued: async () => {
        throw leakMessage("string compensation failure");
      },
    });
    const queue = trackingQueue(
      {
        send: async () => {
          throw new Error("transport refused");
        },
      },
      ledger,
    );

    await expect(queue.send(body)).rejects.toThrow("transport refused");
    const lines = warnsFor(LEDGER_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([LEDGER_WARN, { job_id: enqueuedJobIds[0], exception: "string" }]);
    expect(JSON.stringify(lines[0])).not.toContain("undefined");
    expectLeakFree();
  });

  it("an object compensation failure logs typeof object, never its fields", async () => {
    const { ledger, enqueuedJobIds } = memLedger({
      dequeued: async () => {
        throw { code: 500, sql: LEAK_SQL, token: LEAK_TOKEN };
      },
    });
    const queue = trackingQueue(
      {
        send: async () => {
          throw new Error("transport refused");
        },
      },
      ledger,
    );

    await expect(queue.send(body)).rejects.toThrow("transport refused");
    const lines = warnsFor(LEDGER_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([LEDGER_WARN, { job_id: enqueuedJobIds[0], exception: "object" }]);
    expectLeakFree();
  });
});

describe("lock release carries named keys", () => {
  const EVENT_KEY = "e-acceptance-lock";
  const LEASE_TOKEN = "11111111-1111-4111-8111-111111111111";
  const JOB_ID = "22222222-2222-4222-8222-222222222222";
  const carrier = {
    kind: "sync-event",
    eventKey: EVENT_KEY,
    idempotencyKey: "k-acceptance-lock",
    leaseToken: LEASE_TOKEN,
    jobId: JOB_ID,
  };

  it("a rejecting release logs one { scope, exception } object, class-only", async () => {
    const lock: UniqueLock = {
      acquire: async () => LEASE_TOKEN,
      release: async () => {
        throw new LockStoreError(leakMessage("lock DELETE failed"));
      },
    };
    const failedReasons: string[] = [];
    const { ledger } = memLedger({
      failed: async (_id, _kind, _key, reason) => void failedReasons.push(reason),
    });
    const m = syncMessage(carrier, SYNC_EVENT.tries);

    await consume({ messages: [m] }, exhaustedSyncDeps(lock, ledger));

    const lines = warnsFor(LOCK_FAILED_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      LOCK_FAILED_WARN,
      { scope: sanitizeScope(uniqueKeyOf(EVENT_KEY)), exception: "LockStoreError" },
    ]);
    expectLeakFree();
    // Verdict unchanged: exhausted throw still acks terminally.
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect(failedReasons).toEqual(["TypeError"]);
  });

  it("a non-Error release rejection logs typeof, never undefined", async () => {
    const lock: UniqueLock = {
      acquire: async () => LEASE_TOKEN,
      release: async () => {
        throw leakMessage("string lock failure");
      },
    };
    const { ledger } = memLedger();
    const m = syncMessage(carrier, SYNC_EVENT.tries);

    await consume({ messages: [m] }, exhaustedSyncDeps(lock, ledger));

    const lines = warnsFor(LOCK_FAILED_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      LOCK_FAILED_WARN,
      { scope: sanitizeScope(uniqueKeyOf(EVENT_KEY)), exception: "string" },
    ]);
    expect(JSON.stringify(lines[0])).not.toContain("undefined");
    expectLeakFree();
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("a hung release warns once with { scope } and still acks", async () => {
    vi.useFakeTimers();
    const lock: UniqueLock = {
      acquire: async () => LEASE_TOKEN,
      release: () => new Promise<void>(() => {}),
    };
    const { ledger } = memLedger();
    const m = syncMessage(carrier, SYNC_EVENT.tries);

    const p = consume({ messages: [m] }, exhaustedSyncDeps(lock, ledger));
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const lines = warnsFor(LOCK_TIMEOUT_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([LOCK_TIMEOUT_WARN, { scope: sanitizeScope(uniqueKeyOf(EVENT_KEY)) }]);
    expect(warnsFor(LOCK_FAILED_WARN)).toHaveLength(0);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hostile event key stays a single sanitized scope line", async () => {
    vi.useFakeTimers();
    const hostile = "e1\ninjected-field\r\nsplit";
    const lock: UniqueLock = {
      acquire: async () => LEASE_TOKEN,
      release: () => new Promise<void>(() => {}),
    };
    const { ledger } = memLedger();
    const m = syncMessage({ ...carrier, eventKey: hostile }, SYNC_EVENT.tries);

    const p = consume({ messages: [m] }, exhaustedSyncDeps(lock, ledger));
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const expected = sanitizeScope(uniqueKeyOf(hostile));
    expect(expected).toBe("sync-event:e1_injected-field_split");
    const lines = warnsFor(LOCK_TIMEOUT_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([LOCK_TIMEOUT_WARN, { scope: expected }]);
    expect(allLoggedJson()).not.toContain("\ninjected-field");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// No sockets: model only the grant lookup the admission path touches.
const grantFixture = vi.hoisted(() => ({ failMode: "ok" as "ok" | "error" | "string" }));
vi.mock("postgres", () => ({
  default: () => {
    const sql = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("agent_event_grants")) {
        if (grantFixture.failMode === "error")
          throw new HandlerStoreError(leakMessage("private grant failure"));
        if (grantFixture.failMode === "string") throw leakMessage("string grant failure");
      }
      if (query.includes("SELECT count(*)")) return [{ n: 0, wait: 31 }];
      return [];
    };
    sql.begin = async (fn: (tx: unknown) => unknown) => fn(sql);
    sql.unsafe = async () => [];
    sql.end = async () => {};
    return sql;
  },
}));

const testEnv = {
  APP_URL: "https://fixture.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const ingressEnv = {
  ...testEnv,
  AGENT_EVENTS_ENABLED: "true",
  AGENT_DB: { connectionString: "postgres://fixture.invalid/never-connected" },
} as Env;
const execution = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });

describe("agent-events failures carry a named exception", () => {
  beforeEach(() => {
    grantFixture.failMode = "ok";
  });

  it("an admission Error logs { exception } class-only with the static 500", async () => {
    grantFixture.failMode = "error";
    const ctx = execution();
    const request = new Request(new URL("/api/agent-events", testEnv.APP_URL), {
      method: "POST",
      body: "{}",
      headers: {
        accept: "application/json",
        authorization: "Bearer test-only-machine-credential",
      },
    });

    const response = await app.request(request, undefined, ingressEnv, ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      reason: "internal_error",
      message: "The agent event ingress failed.",
    });

    const lines = errorsFor(AGENT_FAILED);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([AGENT_FAILED, { exception: "HandlerStoreError" }]);
    expectLeakFree();
  });

  it("an admission string throw logs typeof, never undefined", async () => {
    grantFixture.failMode = "string";
    const ctx = execution();
    const request = new Request(new URL("/api/agent-events", testEnv.APP_URL), {
      method: "POST",
      body: "{}",
      headers: {
        accept: "application/json",
        authorization: "Bearer test-only-machine-credential",
      },
    });

    const response = await app.request(request, undefined, ingressEnv, ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      reason: "internal_error",
      message: "The agent event ingress failed.",
    });

    const lines = errorsFor(AGENT_FAILED);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([AGENT_FAILED, { exception: "string" }]);
    expect(JSON.stringify(lines[0])).not.toContain("undefined");
    expectLeakFree();
  });

  it("a route-handler Error logs { exception } class-only with the static 500", async () => {
    const thrown = new HandlerStoreError(leakMessage("private handler failure"));
    const handler = async (_body: unknown): Promise<never> => {
      throw thrown;
    };
    const seen: Array<{ body: unknown; status: number }> = [];
    const c = {
      req: { json: async () => ({}) },
      get: (key: string) => (key === "agentEventHandler" ? handler : "test-request-id-acceptance"),
      json: (body: unknown, status: number) => {
        seen.push({ body, status });
        return new Response(JSON.stringify(body), { status });
      },
      header: () => {},
      executionCtx: execution(),
    };

    const response = await agentEventsRoute(c as never);
    expect(response.status).toBe(500);
    expect(seen).toEqual([
      {
        body: { reason: "internal_error", message: "The agent event ingress failed." },
        status: 500,
      },
    ]);

    const lines = errorsFor(AGENT_FAILED);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([AGENT_FAILED, { exception: "HandlerStoreError" }]);
    expectLeakFree();
  });

  it("a route-handler string throw logs typeof, never undefined", async () => {
    const handler = async (_body: unknown): Promise<never> => {
      throw leakMessage("string handler failure");
    };
    const c = {
      req: { json: async () => ({}) },
      get: (key: string) => (key === "agentEventHandler" ? handler : "test-request-id-acceptance"),
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
      header: () => {},
      executionCtx: execution(),
    };

    const response = await agentEventsRoute(c as never);
    expect(response.status).toBe(500);

    const lines = errorsFor(AGENT_FAILED);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([AGENT_FAILED, { exception: "string" }]);
    expect(JSON.stringify(lines[0])).not.toContain("undefined");
    expectLeakFree();
  });
});

describe("reopen timeout gains the sanitized scope", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const now = () => new Date(NOW.getTime());
  const EVENT_KEY = "e-acceptance-reopen";
  const IDEMPOTENCY_KEY = "88888888-8888-4888-8888-888888888888";
  const JOB_ID = "33333333-3333-4333-8333-333333333333";
  const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";

  function reopenSetup(eventKey: string, pending: "hang" | "ok") {
    const prepared: SyncAttempt = {
      idempotencyKey: IDEMPOTENCY_KEY,
      eventKey,
      revision: 1,
      mirroredAt: new Date("2026-10-01T11:00:00.000Z"),
      state: "pending",
      requestAttempts: 1,
      nextAttemptAt: new Date("2026-10-01T11:00:00.000Z"),
      action: "event.upsert",
      payload: {
        eventKey,
        name: "Game night",
        startsAt: "2026-10-01T13:00:00.000Z",
        endsAt: "2026-10-01T14:00:00.000Z",
        location: "Discord",
        description: null,
      },
    };
    const refusal = {
      ok: false,
      code: "action_not_allowed",
      status: 403,
      requestId: "r1",
      message: "flag off",
      retryable: false,
      retryAfterSeconds: null,
    } as const;
    const bot = {
      upsertEvent: vi.fn(async () => refusal),
      cancelEvent: vi.fn(async () => refusal),
      postAnnouncement: vi.fn(),
      assignRole: vi.fn(),
    } as unknown as BotClient;
    const events = {
      prepareSync: vi.fn(async () => prepared),
      claimSync: vi.fn(async (a: SyncAttempt) => a),
      completeSync: vi.fn(async () => {}),
      deferSync: vi.fn(async () => {}),
      failSync: vi.fn(async () => {
        throw new Error("settlement store unavailable");
      }),
      noteTerminalIntent: vi.fn(async () => {
        throw new Error("intent store unavailable");
      }),
      needsSync: async () => false,
      pendingSync: vi.fn((_key: string): Promise<SyncAttempt | null> => {
        if (pending === "hang") return new Promise<SyncAttempt>(() => {});
        return Promise.resolve(prepared);
      }),
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    } as unknown as EventStore;
    const ledger = {
      enqueued: vi.fn(async () => {}),
      reserved: vi.fn(async () => {}),
      released: vi.fn(async () => {}),
      dequeued: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    } as unknown as QueueLedger;
    const lock = {
      acquire: vi.fn(async () => LEASE_TOKEN),
      release: vi.fn(async () => {}),
    } as unknown as UniqueLock;
    return { prepared, bot, events, ledger, lock, deps: { bot, events, ledger, lock, now } };
  }

  function reopenCarrier(eventKey: string) {
    return {
      kind: "sync-event",
      eventKey,
      idempotencyKey: IDEMPOTENCY_KEY,
      leaseToken: LEASE_TOKEN,
      jobId: JOB_ID,
    };
  }

  it("a hung reopen warns once with { scope } and still retries released-only", async () => {
    vi.useFakeTimers();
    const s = reopenSetup(EVENT_KEY, "hang");
    const m = syncMessage(reopenCarrier(EVENT_KEY), 1);

    const p = consume({ messages: [m] }, s.deps);
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const lines = warnsFor(REOPEN_TIMEOUT_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2);
    const fields = lines[0]![1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["scope"]);
    expect([sanitizeScope(EVENT_KEY), sanitizeScope(uniqueKeyOf(EVENT_KEY))]).toContain(
      fields["scope"],
    );
    // Settlement still ran and the released-only retry still landed.
    expect(s.events.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hostile reopen key stays a single sanitized scope line", async () => {
    vi.useFakeTimers();
    const hostile = "e-reopen\ninjected\r\nsplit";
    const s = reopenSetup(hostile, "hang");
    const m = syncMessage(reopenCarrier(hostile), 1);

    const p = consume({ messages: [m] }, s.deps);
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const lines = warnsFor(REOPEN_TIMEOUT_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2);
    const fields = lines[0]![1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["scope"]);
    const scope = fields["scope"];
    expect(typeof scope).toBe("string");
    expect(scope as string).not.toContain("\n");
    expect(scope as string).not.toContain("\r");
    expect((scope as string).length).toBeLessThanOrEqual(200);
    expect([sanitizeScope(hostile), sanitizeScope(uniqueKeyOf(hostile))]).toContain(scope);
    expect(allLoggedJson()).not.toContain("\ninjected");
    expect(vi.getTimerCount()).toBe(0);
  });
});
