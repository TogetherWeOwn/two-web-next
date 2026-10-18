// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): one table-specific SQL failure in the daily model:prune
// pass must not roll back healthy-table retention progress, every started
// drain settles before the pass reports, and failed tables are reported
// honestly with no successful-looking counts.
//
// Contract pinned here:
// - pruneModelTables drains every table to settlement even when a drain
//   rejects (never fail-fast): healthy drains that are still running finish
//   before the pass resolves or rejects.
// - opts gains `reportFailures?: (failures) => void`, mirroring the deferred
//   `reportCap` seam. A failure entry is `{ table, error }` with `table` a
//   PruneCounts key. When the reporter is supplied it is called exactly
//   once, only when at least one table failed, after every drain settled,
//   in canonical table order (agentEventAudits, accessLog, joinAttempts,
//   idempotencyKeys, searchLog, boardViews, sessions, jobUniqueLocks) —
//   never in completion order. The pass then resolves: healthy counts are
//   exact, a failed table contributes 0 (partial batches from a failed
//   drain are rolled back and must never be reported), `reportCap` still
//   fires for healthy capped tables, the pass does not page itself and
//   does not log the success line "Model prune pass completed.".
// - Without the reporter (existing direct callers), the pass still settles
//   every drain, then rejects with the canonical-first table's error
//   (identity preserved), preserving whole-flight failure reporting by the
//   caller.
// - Cutoffs, batch caps and sweep arguments are unchanged on a failing
//   pass: age tables get now minus their retention days, the session and
//   lock sweeps get `now`.
// - pgPruneStores bound to a transaction client isolates each statement
//   behind a real PostgreSQL savepoint boundary, so a statement error
//   rolls back only that statement and rethrows without aborting the
//   enclosing flight transaction. Bound to a pool (autocommit) it keeps
//   working statement-by-statement — the lock sweep's autocommit boundary
//   is unchanged.
// - Real Postgres (guarded disposable schema): with one table renamed away
//   mid-pass, healthy deletes persist after the advisory single-flight
//   commits, the failed table's rows remain, fresh rows survive everywhere,
//   and a concurrent pass is still excluded by the single-flight.
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRUNE_DELETE_BATCH_SIZE, PRUNE_DELETE_MAX_BATCHES } from "../src/jobs/constants";
import { pruneModelTables, type PruneCounts } from "../src/jobs/cron";
import { pgPruneStores, pgSingleFlight } from "../src/jobs/postgres";
import type { PruneStores, TxClient } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const NOW = new Date("2026-09-30T00:00:00Z");
const DAY = 86_400_000;
const CUTOFF = new Date(NOW.getTime() - 90 * DAY);
const PER_PASS_CAP = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;

class SyntheticSqlError extends Error {
  constructor(message = "synthetic sql failure for member synthetic-member-id") {
    super(message);
    this.name = "SyntheticSqlError";
  }
}

type Failure = { table: keyof PruneCounts; error: unknown };
type PruneOpts = {
  reportCap?: (capped: boolean) => void;
  reportFailures?: (failures: readonly Failure[]) => void;
};

// The reporter field is part of this contract and does not exist on the
// current opts type yet; cast at this single seam so the file typechecks
// both before and after the implementation lands.
function callPrune(stores: PruneStores, now: Date, opts?: PruneOpts): Promise<PruneCounts> {
  return pruneModelTables(stores, now, opts as Parameters<typeof pruneModelTables>[2]);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

type Step = number | Error;

/** Age table replaying scripted batch results; exhausted scripts return 0. */
function scriptedAge(steps: Step[], calls: Date[] = []) {
  const queue = [...steps];
  return {
    calls,
    async pruneOlderThan(cutoff: Date): Promise<number> {
      calls.push(cutoff);
      const step = queue.shift() ?? 0;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function scriptedSweep(steps: Step[], calls: Date[] = []) {
  const queue = [...steps];
  return {
    calls,
    async sweepExpired(at: Date): Promise<number> {
      calls.push(at);
      const step = queue.shift() ?? 0;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function baseStores(overrides: Partial<Record<keyof PruneCounts, Step[]>> = {}): PruneStores {
  const age = (name: keyof PruneCounts) => scriptedAge(overrides[name] ?? [0]);
  const sweep = (name: keyof PruneCounts) => scriptedSweep(overrides[name] ?? [0]);
  return {
    agentEventAudits: age("agentEventAudits"),
    accessLog: age("accessLog"),
    joinAttempts: age("joinAttempts"),
    idempotencyKeys: age("idempotencyKeys"),
    searchLog: age("searchLog"),
    boardViews: age("boardViews"),
    sessions: sweep("sessions") as unknown as PruneStores["sessions"],
    jobUniqueLocks: sweep("jobUniqueLocks"),
  };
}

let spies: { mockRestore(): void }[] = [];
let infoCalls: unknown[][] = [];
let errorCalls: unknown[][] = [];

beforeEach(() => {
  infoCalls = [];
  errorCalls = [];
  spies = [
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      infoCalls.push(args);
    }),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("prune table failure isolation at the drain seam (acceptance)", () => {
  it("healthy pass with a failure reporter stays exact and silent (positive control)", async () => {
    const reported: (readonly Failure[])[] = [];
    const caps: boolean[] = [];
    const stores = baseStores({
      agentEventAudits: [2],
      accessLog: [2],
      joinAttempts: [2],
      idempotencyKeys: [2],
      searchLog: [2],
      boardViews: [2],
      sessions: [2],
      jobUniqueLocks: [2],
    });

    const counts = await callPrune(stores, NOW, {
      reportCap: (capped) => caps.push(capped),
      reportFailures: (failures) => reported.push(failures),
    });

    expect(counts).toEqual({
      agentEventAudits: 2,
      accessLog: 2,
      joinAttempts: 2,
      idempotencyKeys: 2,
      searchLog: 2,
      boardViews: 2,
      sessions: 2,
      jobUniqueLocks: 2,
    });
    expect(reported).toHaveLength(0);
    expect(caps).toEqual([false]);
    expect(errorCalls).toHaveLength(0);
  });

  it("one failing table: healthy drains settle, counts stay honest, reporter fires once", async () => {
    const failure = new SyntheticSqlError();
    const gate = deferred();
    const reported: (readonly Failure[])[] = [];
    const caps: boolean[] = [];
    const cutoffs: Record<string, Date[]> = {
      agentEventAudits: [],
      joinAttempts: [],
      sessions: [],
      jobUniqueLocks: [],
    };
    let searchCalls = 0;
    const stores: PruneStores = {
      agentEventAudits: scriptedAge([1], cutoffs.agentEventAudits),
      accessLog: scriptedAge([1]),
      joinAttempts: scriptedAge([failure], cutoffs.joinAttempts),
      idempotencyKeys: scriptedAge([1]),
      // Slow healthy drain: still in flight when joinAttempts rejects. The
      // pass must not resolve (or report) until it settles.
      searchLog: {
        async pruneOlderThan(_cutoff: Date): Promise<number> {
          searchCalls++;
          if (searchCalls === 1) {
            await gate.promise;
            return 2;
          }
          return 0;
        },
      },
      boardViews: scriptedAge([1]),
      sessions: createMemorySessionStore(() => NOW.getTime()),
      jobUniqueLocks: scriptedSweep([1], cutoffs.jobUniqueLocks),
    };
    // Seed one expired session so the healthy session count is exact.
    const sessions = stores.sessions as ReturnType<typeof createMemorySessionStore>;
    await sessions.create({
      tokenHash: "expired",
      userId: "42",
      username: "r",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(NOW.getTime() - 1000),
    });

    let settled = false;
    const pending = callPrune(stores, NOW, {
      reportCap: (capped) => caps.push(capped),
      reportFailures: (failures) => reported.push(failures),
    }).then(
      (counts) => {
        settled = true;
        return counts;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    void pending.catch(() => {});

    await flush();
    expect(settled, "pass settled before the slow healthy drain finished").toBe(false);
    expect(reported, "reporter fired before every drain settled").toHaveLength(0);

    gate.resolve();
    const counts = await pending;

    expect(counts).toEqual({
      agentEventAudits: 1,
      accessLog: 1,
      joinAttempts: 0,
      idempotencyKeys: 1,
      searchLog: 2,
      boardViews: 1,
      sessions: 1,
      jobUniqueLocks: 1,
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toHaveLength(1);
    expect(reported[0]![0]!.table).toBe("joinAttempts");
    expect(reported[0]![0]!.error).toBe(failure);
    expect(caps).toEqual([false]);
    // Deferred reporting: the pass itself never pages and never logs the
    // success line for a partially failed pass.
    expect(errorCalls).toHaveLength(0);
    expect(infoCalls.map((args) => String(args[0]))).not.toContain("Model prune pass completed.");
    // Cutoffs and sweep arguments are unchanged on a failing pass.
    expect(cutoffs.agentEventAudits![0]).toEqual(CUTOFF);
    expect(cutoffs.joinAttempts![0]).toEqual(CUTOFF);
    expect(cutoffs.jobUniqueLocks![0]).toEqual(NOW);
  });

  it("a drain that fails after a partial batch contributes zero, never its rolled-back count", async () => {
    const failure = new SyntheticSqlError("mid-drain synthetic failure");
    const reported: (readonly Failure[])[] = [];
    const stores = baseStores({ searchLog: [5, failure] });

    const counts = await callPrune(stores, NOW, {
      reportCap: () => {},
      reportFailures: (failures) => reported.push(failures),
    });

    expect(counts.searchLog).toBe(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.map((entry) => entry.table)).toEqual(["searchLog"]);
    expect(reported[0]![0]!.error).toBe(failure);
  });

  it("multiple failures are reported in canonical table order, not completion order", async () => {
    const gate = deferred();
    const earlyTableFailure = new SyntheticSqlError("early table, late failure");
    const lateTableFailure = new SyntheticSqlError("late table, early failure");
    const reported: (readonly Failure[])[] = [];
    const stores = baseStores({
      boardViews: [lateTableFailure],
      accessLog: [3],
    });
    stores.agentEventAudits = {
      async pruneOlderThan(_cutoff: Date): Promise<number> {
        await gate.promise;
        throw earlyTableFailure;
      },
    };

    const pending = callPrune(stores, NOW, {
      reportCap: () => {},
      reportFailures: (failures) => reported.push(failures),
    });
    void pending.catch(() => {});
    await flush();
    gate.resolve();
    const counts = await pending;

    expect(counts.agentEventAudits).toBe(0);
    expect(counts.boardViews).toBe(0);
    expect(counts.accessLog).toBe(3);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.map((entry) => entry.table)).toEqual(["agentEventAudits", "boardViews"]);
    expect(reported[0]![0]!.error).toBe(earlyTableFailure);
    expect(reported[0]![1]!.error).toBe(lateTableFailure);
  });

  it("without a reporter the pass settles every drain, then rejects with the canonical-first error", async () => {
    const gate = deferred();
    const canonicalFirst = new SyntheticSqlError("canonical-first failure");
    const fastLate = new SyntheticSqlError("fast late-table failure");
    const order: string[] = [];
    const stores = baseStores({ boardViews: [fastLate] });
    stores.accessLog = {
      async pruneOlderThan(_cutoff: Date): Promise<number> {
        await gate.promise;
        order.push("accessLog:failed");
        throw canonicalFirst;
      },
    };
    stores.searchLog = {
      async pruneOlderThan(_cutoff: Date): Promise<number> {
        await gate.promise;
        order.push("searchLog:settled");
        return 0;
      },
    };

    let settled = false;
    const pending = callPrune(stores, NOW).then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    void pending.catch(() => {});

    // boardViews already rejected; a fail-fast pass would have settled here.
    await flush();
    expect(settled, "pass rejected before slow drains settled").toBe(false);

    gate.resolve();
    await expect(pending).rejects.toBe(canonicalFirst);
    expect(order).toContain("searchLog:settled");
  });

  it("cap reporting still fires for healthy capped tables when another table fails", async () => {
    const failure = new SyntheticSqlError();
    const reported: (readonly Failure[])[] = [];
    const caps: boolean[] = [];
    const stores = baseStores({ boardViews: [failure] });
    stores.joinAttempts = {
      async pruneOlderThan(_cutoff: Date): Promise<number> {
        return PRUNE_DELETE_BATCH_SIZE;
      },
    };

    const counts = await callPrune(stores, NOW, {
      reportCap: (capped) => caps.push(capped),
      reportFailures: (failures) => reported.push(failures),
    });

    expect(counts.joinAttempts).toBe(PER_PASS_CAP);
    expect(counts.boardViews).toBe(0);
    expect(caps).toEqual([true]);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.map((entry) => entry.table)).toEqual(["boardViews"]);
    expect(errorCalls).toHaveLength(0);
  });
});

describe("pgPruneStores transaction boundary (scripted driver, acceptance)", () => {
  function fakeTx() {
    const log: string[] = [];
    const failure = new SyntheticSqlError("statement synthetic failure");
    const tag = async (parts: TemplateStringsArray, ..._values: unknown[]) => {
      const text = parts.join(" ").toLowerCase();
      log.push(`sql:${text.slice(0, 40)}`);
      if (text.includes("join_attempts")) throw failure;
      return [{}, {}, {}];
    };
    const client = Object.assign(tag, {
      // postgres.js TransactionSql.savepoint: rolls back to the savepoint
      // and rethrows when the callback fails; the outer transaction lives.
      savepoint: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        log.push("savepoint:enter");
        try {
          const out = await run(client);
          log.push("savepoint:release");
          return out;
        } catch (err) {
          log.push("savepoint:rollback");
          throw err;
        }
      },
    });
    return { client: client as unknown as TxClient, log, failure };
  }

  function boundaryBefore(log: string[], table: string): boolean {
    const statement = log.findIndex((entry) => entry.startsWith("sql:") && entry.includes(table));
    if (statement < 0) return false;
    return log
      .slice(0, statement)
      .some((entry) => entry === "savepoint:enter" || entry.includes("savepoint"));
  }

  it("a failing statement on a transaction client is savepoint-isolated and rethrows identically", async () => {
    const { client, log, failure } = fakeTx();
    const stores = pgPruneStores(client);

    await expect(stores.joinAttempts.pruneOlderThan(CUTOFF)).rejects.toBe(failure);
    expect(boundaryBefore(log, "join_attempts"), `no savepoint before statement: ${log}`).toBe(
      true,
    );
  });

  it("a healthy statement on a transaction client returns its count inside the boundary", async () => {
    const { client, log } = fakeTx();
    const stores = pgPruneStores(client);

    await expect(stores.searchLog.pruneOlderThan(CUTOFF)).resolves.toBe(3);
    expect(boundaryBefore(log, "event_search_logs")).toBe(true);
  });

  it("a pool-bound store keeps its autocommit statement behavior (positive control)", async () => {
    const tag = async (_parts: TemplateStringsArray, ..._values: unknown[]) => [{}, {}, {}];
    const pool = Object.assign(tag, {
      begin: async (...args: unknown[]) => {
        const run = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return run(pool);
      },
    });
    const stores = pgPruneStores(pool as unknown as TxClient);

    await expect(stores.jobUniqueLocks!.sweepExpired(NOW)).resolves.toBe(3);
    await expect(stores.searchLog.pruneOlderThan(CUTOFF)).resolves.toBe(3);
  });
});

// The shared fixture validates testDatabaseUrl() before constructing a
// driver, pins credentials/port, and migrates only its owned schema.
describe.skipIf(!process.env.DATABASE_URL)(
  "prune table failure isolation (test Postgres, acceptance)",
  () => {
    let fixture: JobsFixture | undefined;
    let sql: postgres.Sql;

    beforeAll(async () => {
      fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
      sql = fixture.client;
      const { migrate } = await import("../src/sessions");
      await migrate(sql as unknown as Parameters<typeof migrate>[0]);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    it("one renamed table fails while healthy deletes commit inside the single-flight", async () => {
      const now = new Date();
      const old = new Date(now.getTime() - 91 * DAY);
      const fresh = new Date(now.getTime() - DAY);

      await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        values ('added','site','iso-join-old','10',${old}),('added','site','iso-join-fresh','11',${fresh})`;
      await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
        values ('iso-board','overall','all',3,${old}),('iso-board','overall','all',0,${fresh})`;
      await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
        values ('iso search old',3,${old}),('iso search fresh',0,${fresh})`;
      await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('iso-gone','1','a',true,false,${new Date(now.getTime() - 1000)}),
               ('iso-live','2','b',true,false,${new Date(now.getTime() + 3600_000)})`;
      await sql`insert into job_unique_locks (key, expires_at, owner_token)
        values ('iso-expired-lock',${new Date(now.getTime() - 1000)},${crypto.randomUUID()}::uuid),
               ('iso-live-lock',${new Date(now.getTime() + 3600_000)},${crypto.randomUUID()}::uuid)`;

      const reported: (readonly Failure[])[] = [];
      const caps: boolean[] = [];
      let counts: PruneCounts | undefined;
      // Force a real table-specific SQL error (undefined_table) for the
      // search-log drain only; every other statement stays valid.
      await sql`alter table event_search_logs rename to event_search_logs_iso_hidden`;
      let ran = false;
      try {
        ran = await pgSingleFlight(sql)(`model:prune:${fixture!.schemaName}`, async (tx) => {
          counts = await callPrune(
            {
              ...pgPruneStores(tx),
              // The lock sweep keeps its autocommit dispatch-pool boundary.
              jobUniqueLocks: pgPruneStores(sql).jobUniqueLocks,
            },
            now,
            {
              reportCap: (capped) => caps.push(capped),
              reportFailures: (failures) => reported.push(failures),
            },
          );
        });
      } finally {
        await sql`alter table event_search_logs_iso_hidden rename to event_search_logs`;
      }

      expect(ran).toBe(true);
      expect(counts).toMatchObject({
        joinAttempts: 1,
        boardViews: 1,
        searchLog: 0,
        sessions: 1,
        jobUniqueLocks: 1,
      });
      expect(reported).toHaveLength(1);
      expect(reported[0]!.map((entry) => entry.table)).toEqual(["searchLog"]);
      expect((reported[0]![0]!.error as { code?: string }).code).toBe("42P01");
      expect(caps).toEqual([false]);

      // Healthy deletes persisted past the flight commit; fresh rows and the
      // failed table's rows remain.
      const joins = await sql<
        { request_id: string }[]
      >`select request_id from join_attempts order by id`;
      expect(joins.map((r) => r.request_id)).toEqual(["iso-join-fresh"]);
      const board = await sql<
        { result_count: number }[]
      >`select result_count from board_view_logs order by id`;
      expect(board.map((r) => r.result_count)).toEqual([0]);
      const searches = await sql<
        { normalized_query: string }[]
      >`select normalized_query from event_search_logs order by id`;
      expect(searches.map((r) => r.normalized_query)).toEqual([
        "iso search old",
        "iso search fresh",
      ]);
      const sessions = await sql<
        { token_hash: string }[]
      >`select token_hash from web_sessions order by token_hash`;
      expect(sessions.map((r) => r.token_hash)).toEqual(["iso-live"]);
      const locks = await sql<{ key: string }[]>`select key from job_unique_locks order by key`;
      expect(locks.map((r) => r.key)).toEqual(["iso-live-lock"]);
    });

    it("the advisory single-flight still excludes a concurrent pass", async () => {
      const entered = deferred();
      const gate = deferred();
      const name = `model:prune:${fixture!.schemaName}:concurrent`;
      const first = pgSingleFlight(sql)(name, async () => {
        entered.resolve();
        await gate.promise;
      });
      void first.catch(() => {});
      await entered.promise;

      let secondRan = false;
      const second = await pgSingleFlight(sql)(name, async () => {
        secondRan = true;
      });
      expect(second).toBe(false);
      expect(secondRan).toBe(false);

      gate.resolve();
      await expect(first).resolves.toBe(true);
    });
  },
);
