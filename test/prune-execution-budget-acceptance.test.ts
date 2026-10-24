// Acceptance-owned: the builder consumes this file unchanged.
// Removing any drain's scoped lock/statement budget must fail its parked-lock
// or sleeping-trigger case. Returning early without cancelling SQL must fail
// the committed-sibling, restored-setting, rollback and cleanup observations.
// The 8s observation ceiling is deliberately looser than a short DB budget;
// it is not an assertion about a particular exported constant or SQL spelling.
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON } from "../src/jobs/constants";
import { pruneModelTables, type PruneCounts } from "../src/jobs/cron";
import { pgPruneStores, pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";
import type { PruneStores, TxClient } from "../src/jobs/types";
import { handleScheduled } from "../src/jobs/worker";
import { __resetReleaseForTests } from "../src/release-tag";
import { migrate, type Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const DB = process.env.DATABASE_URL;
const DAY = 86_400_000;
const CEILING_MS = 8_000;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_SETTINGS = { statement: "21s", lock: "19s" };
const TABLES = [
  ["agentEventAudits", "agent_event_audits"],
  ["accessLog", "member_data_access_logs"],
  ["joinAttempts", "join_attempts"],
  ["idempotencyKeys", "agent_event_idempotency_keys"],
  ["searchLog", "event_search_logs"],
  ["boardViews", "board_view_logs"],
  ["sessions", "web_sessions"],
  ["jobUniqueLocks", "job_unique_locks"],
] as const;
type TableKey = (typeof TABLES)[number][0];
type Failure = { table: keyof PruneCounts; error: unknown };
type Settings = { statement: string; lock: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function watch<T>(promise: PromiseLike<T>) {
  const state = { settled: false, result: undefined as Outcome<T> | undefined };
  const pending = Promise.resolve(promise).then(
    (value) => {
      state.result = { ok: true, value };
      state.settled = true;
    },
    (error: unknown) => {
      state.result = { ok: false, error };
      state.settled = true;
    },
  );
  return { state, pending };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = CEILING_MS) {
  const deadline = Date.now() + ms;
  do {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, 5));
  } while (Date.now() < deadline);
  return false;
}

async function settings(client: postgres.Sql | postgres.TransactionSql): Promise<Settings> {
  const [row] = await client<Settings[]>`select current_setting('statement_timeout') as statement,
    current_setting('lock_timeout') as lock`;
  return row!;
}

function deleteBatch(stores: PruneStores, key: TableKey, now: Date) {
  if (key === "sessions") return stores.sessions.sweepExpired(now);
  if (key === "jobUniqueLocks") return stores.jobUniqueLocks!.sweepExpired(now);
  return stores[key].pruneOlderThan(new Date(now.getTime() - 90 * DAY));
}

function errorCode(result: Outcome<unknown> | undefined) {
  return result && !result.ok ? (result.error as { code?: string }).code : undefined;
}

// Each case gets a new migrated schema and private max:1 sweeper/dispatch
// connections. The fixture guard refuses non-test URLs before construction.
describe.skipIf(!DB)("scheduled retention execution budgets (test Postgres, acceptance)", () => {
  let fixture: JobsFixture;
  let observer: postgres.Sql;
  let sweeper: postgres.Sql;
  let dispatch: postgres.Sql;
  let holder: postgres.Sql;
  let realPostgres: typeof postgres;
  let now: Date;
  let sweepName: string;
  let dispatchName: string;
  let workerPrefix: string;
  let clients: postgres.Sql[];
  let started: Promise<unknown>[];
  let releases: (() => void)[];
  let errors: unknown[][];
  let infos: unknown[][];
  let timeline: string[];
  let workers: { ended: boolean; restored?: Settings; activeAtEnd?: number }[];

  function client(name: string) {
    const url = testDatabaseUrl(DB!);
    const sql = realPostgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: {
        search_path: fixture.schemaName,
        application_name: name,
        statement_timeout: 21_000,
        lock_timeout: 19_000,
      },
      onnotice: () => {},
    });
    clients.push(sql);
    return sql;
  }

  async function seed() {
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    const expired = new Date(now.getTime() - 60_000);
    const live = new Date(now.getTime() + DAY);
    const [grant] = await observer<{ id: string }[]>`insert into agent_event_grants
      (agent_id, company_id, guild_id, verifier_hash) values ('a','c','g','budget-fixture') returning id`;
    await observer`insert into agent_event_audits (operation, request_id, result, created_at)
      values ('create','old','ok',${old}),('create','edge','ok',${edge}),('create','fresh','ok',${fresh})`;
    await observer`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('old','members','view','["2"]',1,${old}),('edge','members','view','["2"]',1,${edge}),('fresh','members','view','["2"]',1,${fresh})`;
    await observer`insert into join_attempts (outcome, source, request_id, created_at)
      values ('added','site','old',${old}),('added','site','edge',${edge}),('added','site','fresh',${fresh})`;
    await observer`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
      values (${grant!.id},'old','d',200,'{}',${old}),(${grant!.id},'edge','d',200,'{}',${edge}),(${grant!.id},'fresh','d',200,'{}',${fresh})`;
    await observer`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('old',0,${old}),('edge',0,${edge}),('fresh',0,${fresh})`;
    await observer`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
      values ('old','overall','all',0,${old}),('edge','overall','all',0,${edge}),('fresh','overall','all',0,${fresh})`;
    await observer`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values ('old','1','a',true,false,${expired}),('live','2','b',true,false,${live})`;
    await observer`insert into job_unique_locks (key, expires_at, owner_token)
      values ('old',${expired},${crypto.randomUUID()}::uuid),('live',${live},${crypto.randomUUID()}::uuid)`;
  }

  async function parked(table: string) {
    const ready = deferred<number>();
    const release = deferred();
    releases.push(() => release.resolve());
    const pending = holder.begin(async (tx) => {
      await tx.unsafe(`lock table ${table} in access exclusive mode`);
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      ready.resolve(row!.pid);
      await release.promise;
    });
    started.push(pending);
    // Forward setup failures; do not leave a readiness promise hanging.
    const pid = await Promise.race([
      ready.promise,
      pending.then(() => {
        throw new Error("holder ended before readiness");
      }),
    ]);
    return { pid, release: () => release.resolve(), pending };
  }

  async function sleepingDelete(table: string, onlyLastBatch = false) {
    // Trigger code is fixture-only. No role/database defaults are changed.
    await observer.unsafe(`create function stall_delete() returns trigger language plpgsql as $$
      begin
        ${onlyLastBatch ? "if old.normalized_query <> 'stall' then return old; end if;" : ""}
        perform pg_sleep(30);
        return old;
      end $$`);
    await observer.unsafe(`create trigger stall_delete before delete on ${table}
      for each row execute function stall_delete()`);
  }

  async function observed(name: string, wait: "Lock" | "PgSleep", pid?: number) {
    const rows = await observer<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where application_name = ${name} and state = 'active'
        and query ilike '%delete%'
        and (case when ${wait} = 'Lock' then wait_event_type = 'Lock'
          and ${pid ?? 0} = any(pg_blocking_pids(pid)) else wait_event = 'PgSleep' end)`;
    return rows[0]!.n > 0;
  }

  async function cancel(name: string) {
    await observer`select pg_cancel_backend(pid) from pg_stat_activity
      where application_name = ${name} and state = 'active'`;
  }

  async function count(table: string) {
    const [row] = await observer.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
    return row!.n;
  }

  function track<T>(promise: PromiseLike<T>) {
    const watching = watch(promise);
    started.push(watching.pending);
    return watching;
  }

  function scheduled() {
    return handleScheduled({ cron: PRUNE_CRON, scheduledTime: now.getTime(), noRetry() {} }, {
      DATABASE_URL: DB!,
      SYNC_EVENT_QUEUE: { send: async () => {} },
      CF_VERSION_METADATA: { tag: SHA },
    } as unknown as JobsEnv);
  }

  function installWorkerPools() {
    vi.mocked(postgres).mockImplementation(((raw: string, options: postgres.Options<{}>) => {
      const url = testDatabaseUrl(raw);
      const name = `${workerPrefix}${workers.length}`;
      const record = { ended: false } as (typeof workers)[number];
      workers.push(record);
      const pool = realPostgres(url.href, {
        ...options,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: {
          ...options?.connection,
          search_path: fixture.schemaName,
          application_name: name,
          statement_timeout: 21_000,
          lock_timeout: 19_000,
        },
        onnotice: () => {},
      });
      clients.push(pool);
      return new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === "begin")
            return async (...args: unknown[]) => {
              let flight = false;
              const wrapped = args.map((arg) =>
                typeof arg !== "function"
                  ? arg
                  : async (tx: postgres.TransactionSql) => {
                      const value = await arg(tx);
                      // Distinguish the advisory-locked flight commit from a possible
                      // per-statement dispatch transaction's earlier commit.
                      const [row] = await tx<
                        { held: boolean }[]
                      >`select exists(select 1 from pg_locks
                  where pid = pg_backend_pid() and locktype = 'advisory' and granted) as held`;
                      flight ||= row!.held;
                      return value;
                    },
              );
              const value = await Reflect.apply(target.begin, target, wrapped);
              timeline.push(flight ? "flight:commit" : "statement:commit");
              return value;
            };
          if (prop === "end")
            return async (...args: unknown[]) => {
              record.ended = true;
              timeline.push("end");
              const [active] = await observer<{ n: number }[]>`select count(*)::int as n
              from pg_stat_activity where application_name = ${name} and state = 'active'`;
              record.activeAtEnd = active!.n;
              record.restored = await settings(target);
              return Reflect.apply(target.end, target, args);
            };
          return Reflect.get(target, prop, receiver);
        },
      });
    }) as typeof postgres);
  }

  function assertPageAfterCommit() {
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    const raw = errors[0]![0] as string;
    expect(JSON.parse(raw)).toEqual({
      level: "critical",
      event: "scheduled.failing",
      job: "model:prune",
      exception: "PostgresError",
      error_class: "PostgresError",
      build_sha: SHA,
      release: SHA,
    });
    for (const banned of [
      "delete",
      "stall",
      "event_search_logs",
      "job_unique_locks",
      "old",
      "57014",
      "55P03",
    ])
      expect(raw).not.toContain(banned);
    const commitAt = timeline.indexOf("flight:commit");
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("page")).toBeGreaterThan(commitAt);
    expect(infos.some((args) => JSON.stringify(args).includes("Model prune pass completed."))).toBe(
      false,
    );
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(workers.every((worker) => worker.ended && worker.activeAtEnd === 0)).toBe(true);
    expect(workers.map((worker) => worker.restored)).toEqual(workers.map(() => BASE_SETTINGS));
  }

  beforeEach(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createJobsFixture(DB!, { max: 4 });
    observer = fixture.client;
    await migrate(observer as unknown as Sql);
    clients = [];
    started = [];
    releases = [];
    errors = [];
    infos = [];
    timeline = [];
    workers = [];
    now = new Date();
    sweepName = `budget_sweep_${fixture.schemaName}`;
    dispatchName = `budget_dispatch_${fixture.schemaName}`;
    workerPrefix = `budget_worker_${fixture.schemaName}_`;
    sweeper = client(sweepName);
    dispatch = client(dispatchName);
    holder = client(`budget_holder_${fixture.schemaName}`);
    __resetAlertRateLimitForTests();
    __resetReleaseForTests();
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
      timeline.push("page");
    });
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      infos.push(args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seed();
  });

  afterEach(async () => {
    for (const release of releases ?? []) release();
    if (observer) {
      // A missing application budget must fail without leaving a 30s trigger
      // or blocked SQL orphan behind. Cancellation here never counts as proof:
      // the settled-while-parked verdict is frozen before this cleanup runs.
      await observer`select pg_cancel_backend(pid) from pg_stat_activity
        where (application_name = ${sweepName} or application_name = ${dispatchName}
          or starts_with(application_name, ${workerPrefix})) and state = 'active'`;
    }
    await Promise.allSettled(started ?? []);
    vi.mocked(postgres).mockImplementation(realPostgres);
    for (const pool of clients ?? []) await pool.end({ timeout: 1 });
    await fixture?.dispose();
    vi.restoreAllMocks();
    __resetReleaseForTests();
  });

  for (const [key, table] of TABLES) {
    for (const mode of ["relation", "statement"] as const) {
      it(`${key}: cancels a stalled ${mode} wait, restores settings and recovers on the same connection`, async () => {
        const pool = key === "jobUniqueLocks" ? dispatch : sweeper;
        const name = key === "jobUniqueLocks" ? dispatchName : sweepName;
        const [beforePid] = await pool<{ pid: number }[]>`select pg_backend_pid() as pid`;
        expect(await settings(pool)).toEqual(BASE_SETTINGS);
        const lock = mode === "relation" ? await parked(table) : undefined;
        if (mode === "statement") await sleepingDelete(table);
        let inside: Settings | undefined;
        let batchResult: Outcome<number> | undefined;
        const invoke = async (tx: postgres.Sql | postgres.TransactionSql) => {
          try {
            batchResult = {
              ok: true,
              value: await deleteBatch(pgPruneStores(tx as unknown as TxClient), key, now),
            };
          } catch (error) {
            batchResult = { ok: false, error };
          }
          inside = await settings(tx);
          return batchResult;
        };
        const work = track(key === "jobUniqueLocks" ? invoke(pool) : pool.begin(invoke));
        let witnessed = false;
        await until(async () => {
          witnessed ||= await observed(name, mode === "relation" ? "Lock" : "PgSleep", lock?.pid);
          return witnessed || work.state.settled;
        });
        const settledWhileParked = await until(() => work.state.settled);
        const frozen = batchResult;
        // Release/cancel only after recording the deadline verdict.
        lock?.release();
        if (!work.state.settled) await cancel(name);
        await work.pending;
        await lock?.pending;
        if (mode === "statement") await observer.unsafe(`drop trigger stall_delete on ${table}`);

        expect(witnessed, "the real DB wait must be witnessed before its cancellation").toBe(true);
        expect(
          settledWhileParked,
          "no application-owned cancellation before external release",
        ).toBe(true);
        expect(frozen?.ok, "a cancelled delete must reject, not claim zero/success").toBe(false);
        expect(mode === "relation" ? ["55P03", "57014"] : ["57014"]).toContain(errorCode(frozen));
        expect(work.state.result?.ok, "cancellation poisoned the surrounding transaction").toBe(
          true,
        );
        expect(inside).toEqual(BASE_SETTINGS);
        expect(await settings(pool)).toEqual(BASE_SETTINGS);
        const [afterPid] = await pool<{ pid: number }[]>`select pg_backend_pid() as pid`;
        expect(afterPid!.pid).toBe(beforePid!.pid);
        expect(await count(table)).toBe(key === "sessions" || key === "jobUniqueLocks" ? 2 : 3);
        expect(await deleteBatch(pgPruneStores(pool), key, now)).toBe(1);
        expect(await deleteBatch(pgPruneStores(pool), key, now)).toBe(0);
        expect(await settings(pool)).toEqual(BASE_SETTINGS);
      });
    }
  }

  it("a cancelled middle table reports zero while earlier and later siblings commit with the holder still parked", async () => {
    const lock = await parked("event_search_logs");
    const failures: Failure[][] = [];
    let counts: PruneCounts | undefined;
    const work = track(
      pgSingleFlight(sweeper)(`budget:${fixture.schemaName}`, async (tx) => {
        counts = await pruneModelTables(
          { ...pgPruneStores(tx), jobUniqueLocks: pgPruneStores(dispatch).jobUniqueLocks },
          now,
          { reportCap: () => {}, reportFailures: (items) => failures.push([...items]) },
        );
        expect(await settings(tx as unknown as postgres.TransactionSql)).toEqual(BASE_SETTINGS);
      }),
    );
    let witnessed = false;
    await until(async () => {
      witnessed ||= await observed(sweepName, "Lock", lock.pid);
      return witnessed || work.state.settled;
    });
    const settledWhileParked = await until(() => work.state.settled);
    const committed = {
      joins: await count("join_attempts"),
      boards: await count("board_view_logs"),
      sessions: await count("web_sessions"),
    };
    lock.release();
    await work.pending;
    await lock.pending;

    expect(witnessed).toBe(true);
    expect(
      settledWhileParked,
      "flight waited for the external holder instead of cancelling one table",
    ).toBe(true);
    expect(work.state.result).toEqual({ ok: true, value: true });
    expect(committed).toEqual({ joins: 2, boards: 2, sessions: 1 });
    expect(counts).toEqual({
      agentEventAudits: 1,
      accessLog: 1,
      joinAttempts: 1,
      idempotencyKeys: 1,
      searchLog: 0,
      boardViews: 1,
      sessions: 1,
      jobUniqueLocks: 1,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.map((item) => item.table)).toEqual(["searchLog"]);
    expect(["55P03", "57014"]).toContain((failures[0]![0]!.error as { code: string }).code);
    expect(await count("event_search_logs")).toBe(3);
    const retry = await pruneModelTables(pgPruneStores(sweeper), now, { reportCap: () => {} });
    expect(retry.searchLog).toBe(1);
    expect(retry.boardViews).toBe(0);
  });

  it("a sleeping later batch rolls back the failed table's earlier batches, not healthy siblings", async () => {
    await observer`delete from event_search_logs`;
    await observer`insert into event_search_logs (normalized_query, result_count, occurred_at)
      select 'batch-' || g, 0, ${new Date(now.getTime() - 91 * DAY)} from generate_series(1,1000) as g`;
    await observer`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('stall',0,${new Date(now.getTime() - 91 * DAY)}),('fresh',0,${now})`;
    await sleepingDelete("event_search_logs", true);
    const failures: Failure[][] = [];
    const successfulBatches: number[] = [];
    let counts: PruneCounts | undefined;
    const work = track(
      pgSingleFlight(sweeper)(`budget:${fixture.schemaName}`, async (tx) => {
        const stores = pgPruneStores(tx);
        const observeBatch = (prune: (at: Date) => Promise<number>) => async (at: Date) => {
          const n = await prune(at);
          successfulBatches.push(n);
          return n;
        };
        // Keep the exported isolation port intact: it supplies the scoped
        // prune callback, so observing only pruneOlderThan would miss it.
        const searchLog: PruneStores["searchLog"] = {
          ...stores.searchLog,
          pruneOlderThan: observeBatch((at) => stores.searchLog.pruneOlderThan(at)),
          isolate: stores.searchLog.isolate
            ? (work) => stores.searchLog.isolate!((prune) => work(observeBatch(prune)))
            : undefined,
        };
        counts = await pruneModelTables(
          {
            ...stores,
            jobUniqueLocks: pgPruneStores(dispatch).jobUniqueLocks,
            searchLog,
          },
          now,
          { reportCap: () => {}, reportFailures: (items) => failures.push([...items]) },
        );
      }),
    );
    let witnessed = false;
    await until(async () => {
      witnessed ||= await observed(sweepName, "PgSleep");
      return witnessed || work.state.settled;
    });
    const settledBeforeCleanup = await until(() => work.state.settled);
    if (!work.state.settled) await cancel(sweepName);
    await work.pending;
    await observer`drop trigger stall_delete on event_search_logs`;

    expect(witnessed).toBe(true);
    expect(
      successfulBatches,
      "the parked statement must be the second batch, not the first",
    ).toEqual([1000]);
    expect(settledBeforeCleanup, "slow DELETE never cancelled itself").toBe(true);
    expect(work.state.result).toEqual({ ok: true, value: true });
    expect(counts?.searchLog).toBe(0);
    expect(counts?.boardViews).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.map((item) => item.table)).toEqual(["searchLog"]);
    expect((failures[0]![0]!.error as { code: string }).code).toBe("57014");
    expect(
      await count("event_search_logs"),
      "the first 1000 deletes of the failed drain must roll back too",
    ).toBe(1002);
    expect(await count("board_view_logs")).toBe(2);
    expect(await settings(sweeper)).toEqual(BASE_SETTINGS);
    const retry = await pruneModelTables(pgPruneStores(sweeper), now, { reportCap: () => {} });
    expect(retry.searchLog).toBe(1001);
    expect(await count("event_search_logs")).toBe(1);
  });

  for (const [key, table, mode] of [
    ["middle table", "event_search_logs", "relation"],
    ["separate lock sweep", "job_unique_locks", "relation"],
    ["slow middle table", "event_search_logs", "statement"],
  ] as const) {
    it(`scheduled ${key}: cancels before external cleanup, pages after commit and closes only settled pools`, async () => {
      const lock = mode === "relation" ? await parked(table) : undefined;
      if (mode === "statement") await sleepingDelete(table);
      installWorkerPools();
      const work = track(scheduled());
      let witnessed = false;
      await until(async () => {
        const rows = await observer<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
          where starts_with(application_name, ${workerPrefix}) and state = 'active'
            and query ilike '%delete%'
            and (case when ${mode} = 'relation' then wait_event_type = 'Lock'
              and ${lock?.pid ?? 0} = any(pg_blocking_pids(pid)) else wait_event = 'PgSleep' end)`;
        witnessed ||= rows[0]!.n > 0;
        return witnessed || work.state.settled;
      });
      const settledWhileParked = await until(() => work.state.settled);
      const healthyCommitted = await count("board_view_logs");
      lock?.release();
      if (!work.state.settled && mode === "statement") {
        await observer`select pg_cancel_backend(pid) from pg_stat_activity
          where starts_with(application_name, ${workerPrefix}) and state = 'active'`;
      }
      await work.pending;
      await lock?.pending;
      if (mode === "statement") await observer.unsafe(`drop trigger stall_delete on ${table}`);

      expect(witnessed).toBe(true);
      expect(settledWhileParked, "scheduled handler has no bounded cancellation").toBe(true);
      expect(work.state.result).toEqual({ ok: true, value: undefined });
      // The scheduled handler uses its execution clock, later than fixture NOW:
      // the fixture's cutoff-exact row is eligible by then; only fresh survives.
      expect(healthyCommitted).toBe(1);
      expect(await count(table)).toBe(table === "job_unique_locks" ? 2 : 3);
      assertPageAfterCommit();
      errors.length = 0;
      timeline.length = 0;
      await scheduled();
      expect(errors).toEqual([]);
      expect(await count(table)).toBe(1);
    });
  }

  it("successful lock-sweep batches release deleted lease rows before the full flight finishes (autocommit control)", async () => {
    const reached = deferred();
    const release = deferred();
    releases.push(() => release.resolve());
    const locks = pgPruneStores(dispatch).jobUniqueLocks!;
    let first = true;
    const work = track(
      pgSingleFlight(sweeper)(`budget:${fixture.schemaName}`, async (tx) => {
        await pruneModelTables(
          {
            ...pgPruneStores(tx),
            jobUniqueLocks: {
              async sweepExpired(at) {
                const n = await locks.sweepExpired(at);
                if (first) {
                  first = false;
                  reached.resolve();
                  await release.promise;
                }
                return n;
              },
            },
          },
          now,
          { reportCap: () => {} },
        );
      }),
    );
    const reachedGate = await until(() => !first || work.state.settled);
    expect(reachedGate).toBe(true);
    expect(work.state.settled).toBe(false);
    // The original expired key's deletion is visible before the flight commits.
    const acquire = track(pgUniqueLock(observer).acquire("old", 300));
    const acquiredBeforeFlightEnd = await until(() => acquire.state.settled, 2000);
    const lease = acquire.state.result;
    release.resolve();
    await work.pending;
    await acquire.pending;
    expect(acquiredBeforeFlightEnd).toBe(true);
    expect(lease?.ok && lease.value).toEqual(expect.any(String));
    expect(work.state.result).toEqual({ ok: true, value: true });
    expect(await settings(dispatch)).toEqual(BASE_SETTINGS);
  });

  it("a concurrent renewal survives a skipped-row sweep and the later pass (renewal control)", async () => {
    const renewed = deferred();
    const release = deferred();
    releases.push(() => release.resolve());
    const holding = holder.begin(async (tx) => {
      await tx`update job_unique_locks set expires_at = ${new Date(now.getTime() + DAY)} where key = 'old'`;
      renewed.resolve();
      await release.promise;
    });
    started.push(holding);
    await renewed.promise;
    const work = track(pgPruneStores(dispatch).jobUniqueLocks!.sweepExpired(now));
    const settledWhileRenewing = await until(() => work.state.settled, 2000);
    release.resolve();
    await holding;
    await work.pending;
    expect(settledWhileRenewing).toBe(true);
    expect(work.state.result).toEqual({ ok: true, value: 0 });
    expect(await pgPruneStores(dispatch).jobUniqueLocks!.sweepExpired(now)).toBe(0);
    expect(await count("job_unique_locks")).toBe(2);
    expect(await pgUniqueLock(observer).acquire("old", 300)).toBeNull();
  });

  it("an uncontended scheduled pass preserves fresh rows, stays silent and restores every pool (healthy control)", async () => {
    installWorkerPools();
    await scheduled();
    expect(errors).toEqual([]);
    // Exact cutoffs use the caller-supplied NOW in the adapter/flight cases;
    // scheduled runs use a later execution clock, so their edge rows expire.
    for (const [, table] of TABLES) expect(await count(table), table).toBe(1);
    expect(
      timeline.indexOf("flight:commit"),
      "the commit observer must identify the actual advisory-locked flight",
    ).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("end")).toBeGreaterThan(timeline.indexOf("flight:commit"));
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(workers.every((worker) => worker.ended && worker.activeAtEnd === 0)).toBe(true);
    expect(workers.map((worker) => worker.restored)).toEqual(workers.map(() => BASE_SETTINGS));
  });
});
