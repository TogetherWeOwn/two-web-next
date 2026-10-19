// Builder-owned bound proof for the scheduled reconcile prepare transaction.
// handleScheduled runs closeFinished + materializeSeries + staleEventKeys in
// one writeTransaction on the dispatch pool (max: 1). Without a server-side
// bound, a row lock held by another transaction wedges that connection for
// the whole pass; with the bound the pass fails fast (55P03) and pages once
// via scheduled.failing. NOT an acceptance file: the Test Author owns
// *-acceptance.test.ts; this file is the builder's RED->GREEN gate and stays
// out of that namespace on purpose.
//
// Hermetic pins cover the constant and the statement shape; live round-trips
// use a guarded disposable schema on agent-testdb or the CI service only,
// because row locks and session settings need real Postgres.
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { RECONCILE_CRON } from "../src/jobs/constants";
import type { EventStore, TxClient } from "../src/jobs/types";
import {
  RECONCILE_PREPARE_DB_TIMEOUT_MS,
  handleScheduled,
  reconcileWriteTransaction,
  setReconcilePrepareTimeouts,
} from "../src/jobs/worker";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reconcile prepare bound (hermetic)", () => {
  it("keeps the prepare budget on the file's 5s statement precedent", () => {
    // successorSql opens with connection: { statement_timeout: 5000 }; the
    // prepare transaction names that same 5s order once for both budgets.
    expect(RECONCILE_PREPARE_DB_TIMEOUT_MS).toBe(5000);
  });

  it("scopes lock/statement timeouts in the transaction before the prepare work", async () => {
    const poolCalls: string[] = [];
    const txCalls: string[] = [];
    let began = false;
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      txCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
      return Promise.resolve([]);
    }) as unknown as TxClient;
    const pool = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        poolCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
        return Promise.resolve([]);
      },
      {
        begin: async (fn: (tx: TxClient) => Promise<unknown>) => {
          began = true;
          return fn(tx);
        },
      },
    );

    const seen: string[] = [];
    const result = await reconcileWriteTransaction(pool as never)(async (events: EventStore) => {
      seen.push(
        typeof events.closeFinished,
        typeof events.materializeSeries,
        typeof events.staleEventKeys,
      );
      await events.closeFinished(new Date());
      return { closed: 1, materialized: 2, stale: ["k"] };
    });

    expect(result).toEqual({ closed: 1, materialized: 2, stale: ["k"] });
    expect(began).toBe(true);
    // Nothing runs on the pool outside the transaction: session settings leak
    // to the next holder of a pooled connection otherwise.
    expect(poolCalls).toEqual([]);
    expect(seen).toEqual(["function", "function", "function"]);
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]).toContain("set_config");
    expect(txCalls[0]).toContain("lock_timeout");
    expect(txCalls[0]).toContain("statement_timeout");
    expect(txCalls[0]).toContain(`${RECONCILE_PREPARE_DB_TIMEOUT_MS}ms`);
    expect(txCalls[1]).toContain("update events set status");
  });
});

const DB = process.env.DATABASE_URL;
// The lock budget is 5s; the pass must settle (by failing) well inside this
// wall-clock deadline even when its UPDATE is stuck behind a held row lock.
// An unbounded wait loses this race and fails as the wrong error below.
const SETTLE_DEADLINE_MS = 15_000;
const SCHEDULER_APP = "reconcile_prepare_bound";

function schemaClient(fixture: JobsFixture, applicationName: string, max = 2) {
  const target = new URL(DB!);
  return postgres(DB!, {
    max,
    port: 5432,
    password: () => target.password,
    connection: { search_path: fixture.schemaName, application_name: applicationName },
    onnotice: () => {},
  });
}

async function seedFinishedEvent(sql: postgres.Sql, tag: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`insert into events
    (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
      recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
    values (${`prepare-bound-${tag}-${Date.now()}`}, 'Bounded prepare',
      ${new Date(Date.now() - 7_200_000)}, ${new Date(Date.now() - 3_600_000)},
      'Europe/London', 'hall', 'published', null,
      null, null, null, null)
    returning id`;
  return row!.id;
}

describe.skipIf(!DB)("reconcile prepare bound (test Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let realPostgres: typeof postgres;

  beforeEach(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createJobsFixture(DB!, { max: 4 });
    sql = fixture.client;
    const schemaName = fixture.schemaName;
    // Redirect only worker-created pools into this owned schema. Every pool
    // still has the worker's max:1 setting and must validate before connecting.
    // An explicit caller application_name survives (locker/observer roles keep
    // theirs); worker pools take the scheduler name the observer matches on.
    vi.mocked(postgres).mockImplementation(((raw: string, options: postgres.Options<{}>) => {
      const url = testDatabaseUrl(raw);
      const incoming = (options.connection ?? {}) as Record<string, unknown>;
      return realPostgres(url.href, {
        ...options,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: {
          ...incoming,
          search_path: schemaName,
          application_name: (incoming.application_name as string | undefined) ?? SCHEDULER_APP,
        },
        onnotice: () => {},
      });
    }) as typeof postgres);
  });
  afterEach(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
    fixture = undefined;
  });

  const controller = () => ({ cron: RECONCILE_CRON, scheduledTime: Date.now(), noRetry() {} });
  const envFor = () =>
    ({
      DATABASE_URL: DB!,
      SYNC_EVENT_QUEUE: { send: async () => {} },
      INTERNAL_ACTION_QUEUE: { send: async () => {} },
    }) as unknown as JobsEnv;

  const waitForPrepareWaiter = async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await sql`select pid from pg_stat_activity
        where application_name = ${SCHEDULER_APP} and wait_event_type = 'Lock'
          and query ilike '%update events set status%'`;
      if (waiting.length >= 1) return;
      if (Date.now() >= deadline)
        throw new Error("expected the prepare UPDATE to wait on the held lock");
      await delay(25);
    }
  };

  it("reports 5s budgets inside the prepare transaction and leaks nothing", async () => {
    const settings = () => sql<{ statement: string; lock: string }[]>`
      select current_setting('statement_timeout') as statement,
             current_setting('lock_timeout') as lock`;
    const before = await settings();
    await sql.begin(async (tx) => {
      await setReconcilePrepareTimeouts(tx as unknown as TxClient);
      expect(
        await tx<{ statement: string; lock: string }[]>`
        select current_setting('statement_timeout') as statement,
               current_setting('lock_timeout') as lock`,
      ).toEqual([{ statement: "5s", lock: "5s" }]);
    });
    // Transaction-local (SET LOCAL): a later session on the same pool sees the
    // database defaults, never the prepare budgets.
    expect(await settings()).toEqual(before);
  });

  it("cancels a slow statement inside the prepare transaction", async () => {
    // With the bound this rejects at ~5s with 57014; without it pg_sleep(6)
    // completes and the rejection assertion fails instead.
    await expect(
      sql.begin(async (tx) => {
        await setReconcilePrepareTimeouts(tx as unknown as TxClient);
        await tx`select pg_sleep(6)`;
      }),
    ).rejects.toMatchObject({ code: "57014" });
  }, 30_000);

  it("fails the scheduled pass within the bound behind a held event row lock, paging once", async () => {
    const eventId = await seedFinishedEvent(sql, "held");
    const locker = schemaClient(fixture!, "prepare_bound_hold", 1);
    const errorCalls: unknown[][] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void errorCalls.push(args));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let first: { ok: boolean; error?: unknown } | undefined;
      let elapsedMs = 0;
      await locker.begin(async (tx) => {
        await tx`select id from events where id = ${eventId} for update`;
        const started = Date.now();
        const running = handleScheduled(controller(), envFor());
        const settled = running.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        // The prepare UPDATE must reach the held lock before the verdict: no
        // fixed sleep, and a pass that fails before touching the row fails here.
        await waitForPrepareWaiter();
        const deadline = delay(SETTLE_DEADLINE_MS).then(() => ({
          ok: false as const,
          error: new Error("timed out waiting for the bounded prepare failure"),
        }));
        first = await Promise.race([settled, deadline]);
        elapsedMs = Date.now() - started;
      });
      expect(elapsedMs).toBeLessThan(SETTLE_DEADLINE_MS);
      // Deterministic RED without the bound: the UPDATE waits forever, the
      // deadline wins, and the code pin below fails on the plain timeout
      // error. GREEN: the bound cancels the UPDATE at ~5s. Equal 5s budgets
      // race: whichever timer fires first cancels the lock-waiting UPDATE,
      // so the code is 55P03 or 57014. Either proves server-side cancellation
      // within the bound; the scheduled path pages both identically and the
      // next pass retries.
      expect(first!.ok).toBe(false);
      expect(["55P03", "57014"]).toContain(
        (first!.error as { code?: unknown } | null | undefined)?.code,
      );
      // The prepare rolled back: the finished row is still published.
      const [after] = await sql<
        { status: string }[]
      >`select status from events where id = ${eventId}`;
      expect(after!.status).toBe("published");
      // One redacted page, the same shape as the total-outage path: job plus
      // exception class, never the statement or its bound values.
      const lines = errorCalls
        .filter((args) => args.length === 1 && typeof args[0] === "string")
        .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .filter((line) => line.event === "scheduled.failing");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ job: "events:reconcile", exception: "PostgresError" });
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await locker.end({ timeout: 1 });
    }
  }, 60_000);

  it("closes the finished row once the held lock releases before the budget expires", async () => {
    const eventId = await seedFinishedEvent(sql, "released");
    const locker = schemaClient(fixture!, "prepare_bound_hold", 1);
    try {
      let running: Promise<void> | undefined;
      await locker.begin(async (tx) => {
        await tx`select id from events where id = ${eventId} for update`;
        running = handleScheduled(controller(), envFor());
        // Releasing (not startup timing) unblocks the waiter: it was observed
        // queued on the held lock first. This control passes with and without
        // the bound; it guards the fixture, not the budget.
        await waitForPrepareWaiter();
      });
      await expect(running!).resolves.toBeUndefined();
      const [after] = await sql<
        { status: string }[]
      >`select status from events where id = ${eventId}`;
      expect(after!.status).toBe("past");
    } finally {
      await locker.end({ timeout: 1 });
    }
  }, 60_000);
});
