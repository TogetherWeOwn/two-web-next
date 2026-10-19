// Acceptance-owned: all five serial EventStore operations need server-side,
// transaction-local budgets. A client-side race cannot release a max:1 pool.
// Only the postgres boundary is fake; no database, queue service or network.
import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { FAIL_SYNC_DB_TIMEOUT_MS, pgEventStore } from "../src/jobs/events";
import type { BotClient, EventStore, SyncAttempt, TxClient } from "../src/jobs/types";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const KEY = "11111111-1111-4111-8111-111111111111";
const NEXT_KEY = "22222222-2222-4222-8222-222222222222";
const EVENT = "e-serial-budget";
const inherited = { lock_timeout: "17s", statement_timeout: "23s" };
class PostgresError extends Error {
  constructor(readonly code: "57014" | "55P03") {
    super("synthetic private database diagnostic");
    this.name = "PostgresError";
  }
}
type Budgets = typeof inherited;
type Statement = { sql: string; scope: "pool" | "tx"; budgets: Budgets };

function attemptFor(eventKey = EVENT, idempotencyKey = KEY): SyncAttempt {
  return {
    eventKey,
    idempotencyKey,
    revision: 1,
    mirroredAt: NOW,
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: NOW,
    terminalReason: null,
    discordEventId: "d-existing",
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
}

function dbRow(eventKey = EVENT, idempotencyKey = KEY) {
  const attempt = attemptFor(eventKey, idempotencyKey);
  return {
    id: 42,
    event_id: 42,
    event_key: eventKey,
    idempotency_key: idempotencyKey,
    revision: 1,
    sync_revision: 1,
    synced_revision: 0,
    mirrored_at: NOW,
    state: "pending",
    request_attempts: 1,
    next_attempt_at: NOW,
    terminal_reason: null,
    discord_event_id: "d-existing",
    action: attempt.action,
    payload: attempt.payload,
    status: "published",
    name: "Game night",
    starts_at: new Date("2026-10-01T13:00:00.000Z"),
    ends_at: new Date("2026-10-01T14:00:00.000Z"),
    location: "Discord",
    description: null,
    deleted_at: null,
  };
}

// A single-connection driver boundary. Transaction clients deliberately have
// no begin(). Settings follow PostgreSQL's SET LOCAL lifetime, including
// rollback of session-scoped SETs; queries retain their effective budgets.
function sqlHarness(options: { fresh?: boolean; code?: "57014" | "55P03" } = {}) {
  const statements: Statement[] = [];
  const settings: { name: string; value: string; local: boolean; scope: "pool" | "tx" }[] = [];
  let session = { ...inherited };
  let local: Budgets | undefined;
  let begins = 0;
  let rollbacks = 0;
  let cancelAt: number | undefined;
  let applicationStatements = 0;
  let eventKey = EVENT;
  let idempotencyKey = KEY;
  const cancelled = new PostgresError(options.code ?? "57014");

  async function execute(scope: "pool" | "tx", sql: string, parameters: unknown[]) {
    const rendered = sql.replace(/\$(\d+)/g, (_, n: string) => {
      const value = parameters[Number(n) - 1];
      return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
    });
    const configs = [
      ...rendered.matchAll(
        /set_config\(\s*'(lock_timeout|statement_timeout)'\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/gi,
      ),
    ];
    for (const [, name, value, isLocal] of configs) {
      const key = name as keyof Budgets;
      const entry = { name: key, value: value!, local: isLocal === "true", scope };
      settings.push(entry);
      if (entry.local) {
        if (local) local[key] = entry.value;
      } else {
        session[key] = entry.value;
        if (local) local[key] = entry.value;
      }
    }
    if (configs.length) return [];
    statements.push({ sql, scope, budgets: { ...(local ?? session) } });
    applicationStatements++;
    if (applicationStatements === cancelAt) throw cancelled;
    if (options.fresh && /^\s*select a\.\*/.test(sql)) return [];
    return [dbRow(eventKey, idempotencyKey)];
  }

  // postgres.js tags are lazy: interpolating a fragment must not execute it.
  // pendingSync composes a query, so an eager Promise fake would cancel the
  // unused fragment instead of the actual awaited statement.
  type Fragment = { sql: string; parameters: unknown[] };
  function query(scope: "pool" | "tx") {
    return (parts: TemplateStringsArray, ...values: unknown[]) => {
      let sql = parts[0]!;
      const parameters: unknown[] = [];
      for (const [i, value] of values.entries()) {
        if (value && typeof value === "object" && "sql" in value && "parameters" in value) {
          const fragment = value as Fragment;
          const offset = parameters.length;
          sql += fragment.sql.replace(/\$(\d+)/g, (_, n: string) => `$${offset + Number(n)}`);
          parameters.push(...fragment.parameters);
        } else {
          parameters.push(value);
          sql += `$${parameters.length}`;
        }
        sql += parts[i + 1]!;
      }
      let pending: ReturnType<typeof execute> | undefined;
      return {
        sql,
        parameters,
        then(
          resolve: (rows: Awaited<ReturnType<typeof execute>>) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          pending ??= execute(scope, sql, parameters);
          return pending.then(resolve, reject);
        },
      };
    };
  }
  const tx = query("tx") as unknown as TxClient;
  const client = Object.assign(query("pool"), {
    async begin<T>(work: (client: TxClient) => Promise<T>) {
      if (local) throw new Error("nested BEGIN");
      begins++;
      const priorSession = { ...session };
      local = { ...session };
      try {
        return await work(tx);
      } catch (error) {
        rollbacks++;
        session = priorSession;
        throw error;
      } finally {
        local = undefined;
      }
    },
  }) as unknown as postgres.Sql;
  return {
    client,
    tx,
    statements,
    settings,
    cancelled,
    cancelNext() {
      cancelAt = applicationStatements + 1;
    },
    nextMessage() {
      eventKey = "e-next-message";
      idempotencyKey = NEXT_KEY;
    },
    state: () => ({ session: { ...session }, local, begins, rollbacks }),
  };
}

const cases: { name: string; run: (store: EventStore) => Promise<unknown>; fresh?: boolean }[] = [
  { name: "prepareSync cached request", run: (store) => store.prepareSync(EVENT, KEY, NOW) },
  {
    name: "prepareSync new snapshot",
    fresh: true,
    run: (store) => store.prepareSync(EVENT, KEY, NOW),
  },
  { name: "claimSync", run: (store) => store.claimSync(attemptFor(), NOW) },
  { name: "completeSync upsert", run: (store) => store.completeSync(attemptFor(), "d-new") },
  {
    name: "completeSync local cancellation",
    run: (store) =>
      store.completeSync(
        { ...attemptFor(), action: "event.cancel", payload: { eventKey: EVENT } },
        null,
      ),
  },
  {
    name: "deferSync retry deadline",
    run: (store) => store.deferSync(attemptFor(), new Date(NOW.getTime() + 60_000)),
  },
  { name: "deferSync closed claim", run: (store) => store.deferSync(attemptFor(), null) },
  { name: "pendingSync", run: (store) => store.pendingSync(EVENT) },
];

function expectBounded(h: ReturnType<typeof sqlHarness>) {
  expect(h.statements.length, "the store must actually execute SQL").toBeGreaterThan(0);
  for (const statement of h.statements) {
    expect(statement.scope, statement.sql).toBe("tx");
    expect(statement.budgets, statement.sql).toEqual({
      lock_timeout: `${FAIL_SYNC_DB_TIMEOUT_MS}ms`,
      statement_timeout: `${FAIL_SYNC_DB_TIMEOUT_MS}ms`,
    });
  }
  expect(h.settings.filter((setting) => setting.name === "lock_timeout").length).toBeGreaterThan(0);
  expect(
    h.settings.filter((setting) => setting.name === "statement_timeout").length,
  ).toBeGreaterThan(0);
  expect(h.settings.every((setting) => setting.local && setting.scope === "tx")).toBe(true);
}

afterEach(() => vi.restoreAllMocks());

describe("existing failSync validates the SQL harness", () => {
  it("observes both local budgets and restores the session after commit", async () => {
    const h = sqlHarness();
    await pgEventStore(h.client).failSync(KEY);
    expectBounded(h);
    expect(h.state()).toEqual({ session: inherited, local: undefined, begins: 1, rollbacks: 0 });
  });

  it("restores the session on cancellation and reuses the connection", async () => {
    const h = sqlHarness();
    h.cancelNext();
    const store = pgEventStore(h.client);
    await expect(store.failSync(KEY)).rejects.toBe(h.cancelled);
    await store.failSync(NEXT_KEY);
    expectBounded(h);
    expect(h.state()).toEqual({ session: inherited, local: undefined, begins: 2, rollbacks: 1 });
  });
});

describe.each(cases)("$name transaction-local SQL budget", ({ name, run, fresh }) => {
  it("reaches the intended operation with a usable result (fixture control)", async () => {
    const h = sqlHarness({ fresh });
    const result = await run(pgEventStore(h.client));
    if (/^(prepareSync|claimSync|pendingSync)/.test(name)) {
      expect(result, h.statements.map((statement) => statement.sql).join("\n")).toMatchObject({
        eventKey: EVENT,
        idempotencyKey: KEY,
        state: "pending",
      });
    } else {
      expect(result).toBeUndefined();
    }
    expect(h.statements.length).toBeGreaterThanOrEqual(fresh ? 2 : 1);
  });

  it("bounds every statement on the pool's transaction and restores the pooled settings", async () => {
    const h = sqlHarness({ fresh });
    await run(pgEventStore(h.client));
    expectBounded(h);
    expect(h.state()).toEqual({ session: inherited, local: undefined, begins: 1, rollbacks: 0 });
  });

  it("uses an existing TxClient without a nested BEGIN", async () => {
    const h = sqlHarness({ fresh });
    await h.client.begin(async () => {
      await run(pgEventStore(h.tx));
      expectBounded(h);
    });
    expect(h.state()).toEqual({ session: inherited, local: undefined, begins: 1, rollbacks: 0 });
  });

  it.each(["57014", "55P03"] as const)(
    "propagates %s, rolls back, and admits the next call",
    async (code) => {
      const h = sqlHarness({ fresh, code });
      const store = pgEventStore(h.client);
      h.cancelNext();
      await expect(run(store)).rejects.toBe(h.cancelled);
      await expect(run(store)).resolves.not.toThrow();
      expectBounded(h);
      expect(h.state()).toEqual({ session: inherited, local: undefined, begins: 2, rollbacks: 1 });
    },
  );
});

describe("serial consumer after an EventStore statement cancellation", () => {
  it.each(["prepareSync", "claimSync", "completeSync", "deferSync"] as const)(
    "%s cancellation retries only that message; the following message completes",
    async (method) => {
      const h = sqlHarness();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const first = {
        body: { kind: "sync-event", eventKey: EVENT, idempotencyKey: KEY },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const second = {
        body: { kind: "sync-event", eventKey: "e-next-message", idempotencyKey: NEXT_KEY },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const bot = {
        upsertEvent: vi.fn(async (payload: { eventKey: string }) =>
          method === "deferSync" && payload.eventKey === EVENT
            ? {
                ok: false,
                code: "rate_limited",
                status: 429,
                requestId: "r1",
                message: "retry",
                retryable: true,
                retryAfterSeconds: 60,
              }
            : { ok: true, requestId: "r1", discordEventId: "d-new" },
        ),
      } as unknown as BotClient;
      const realStore = pgEventStore(h.client);
      const events: EventStore = {
        ...realStore,
        prepareSync: (eventKey, key, at) => {
          if (eventKey === "e-next-message") h.nextMessage();
          if (eventKey === EVENT && method === "prepareSync") h.cancelNext();
          return realStore.prepareSync(eventKey, key, at);
        },
        claimSync: (attempt, at) => {
          if (attempt.eventKey === EVENT && method === "claimSync") h.cancelNext();
          return realStore.claimSync(attempt, at);
        },
        completeSync: (attempt, id) => {
          if (attempt.eventKey === EVENT && method === "completeSync") h.cancelNext();
          return realStore.completeSync(attempt, id);
        },
        deferSync: (attempt, at) => {
          if (attempt.eventKey === EVENT && method === "deferSync") h.cancelNext();
          return realStore.deferSync(attempt, at);
        },
      };
      await consume({ messages: [first, second] } as never, {
        events,
        bot,
        lock: { acquire: async () => "lease", release: async () => {} },
        ledger: {
          enqueued: async () => {},
          reserved: async () => {},
          released: async () => {},
          dequeued: async () => {},
          failed: async () => {},
        },
        now: () => NOW,
      });
      expect(first.retry).toHaveBeenCalledOnce();
      expect(first.ack).not.toHaveBeenCalled();
      expect(second.ack).toHaveBeenCalledOnce();
      expect(second.retry).not.toHaveBeenCalled();
      expect(bot.upsertEvent).toHaveBeenCalledTimes(
        method === "prepareSync" || method === "claimSync" ? 1 : 2,
      );
      expectBounded(h);
      const warnings = JSON.stringify(warn.mock.calls, (_key, value) =>
        value instanceof Error ? { name: value.name, message: value.message } : value,
      );
      expect(warnings).toContain("PostgresError");
      expect(warnings).not.toContain(h.cancelled.message);
      expect(h.state().session).toEqual(inherited);
    },
  );
});
