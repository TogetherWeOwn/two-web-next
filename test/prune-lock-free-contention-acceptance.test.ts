// Test-author owned. Removing model:prune's timeout, swallowing its SQL error,
// losing a savepoint, or restoring scoped SKIP LOCKED must fail this proof.
// A held row defers the whole affected batch, not just that row. Healthy tables
// commit before release, failed counts are zero, and a later flight recovers.
import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import { pruneModelTables, type PruneCounts } from "../src/jobs/cron";
import { pgPruneStores, pgSingleFlight } from "../src/jobs/postgres";
import { migrate, type Sql } from "../src/sessions";
import { createJobsFixture } from "./helpers/jobs-db";
import { observeLockWait, pruneClient, within } from "./helpers/prune-contention";

const DB = process.env.DATABASE_URL;
const DAY = 86_400_000;
const scoped = [
  { table: "agent_event_audits", key: "agentEventAudits", clock: "created_at" },
  { table: "member_data_access_logs", key: "accessLog", clock: "occurred_at" },
  { table: "agent_event_idempotency_keys", key: "idempotencyKeys", clock: "created_at" },
  { table: "event_search_logs", key: "searchLog", clock: "occurred_at" },
  { table: "board_view_logs", key: "boardViews", clock: "occurred_at" },
  { table: "event_reminder_deliveries", key: "reminderDeliveries", clock: "sent_at" },
] as const;
type Failure = { table: keyof PruneCounts; error: unknown };

async function seed(sql: postgres.Sql, now: Date) {
  const old = new Date(now.getTime() - 91 * DAY);
  const edge = new Date(now.getTime() - 90 * DAY);
  const fresh = new Date(now.getTime() - DAY);
  const [grant] = await sql`insert into agent_event_grants
    (agent_id, company_id, guild_id, verifier_hash) values ('a','co','g','fixture-hash') returning id`;
  const [event] = await sql<{ id: number }[]>`insert into events
    (event_key, title, starts_at, ends_at)
    values ('lock-free-event', 'Synthetic prune event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z') returning id`;
  // The free row precedes the held row: a partial DELETE must roll back too.
  for (const at of [old, old, edge, fresh]) {
    await sql`insert into agent_event_audits (operation, request_id, result, created_at)
      values ('create','fixture','ok',${at})`;
    await sql`insert into member_data_access_logs
      (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('1','members','view','["2"]',1,${at})`;
    await sql`insert into agent_event_idempotency_keys
      (grant_id, key, payload_digest, status, body, created_at)
      values (${grant!.id},${crypto.randomUUID()},'d',200,'{}',${at})`;
    await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('fixture',0,${at})`;
    await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
      values ('fixture','overall','all',0,${at})`;
    await sql`insert into event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
      values (${event!.id},${crypto.randomUUID()},'24h','site','sent',${at})`;
  }
  await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
    values ('added','site','old','1',${old}),('added','site','edge','1',${edge}),
           ('added','site','fresh','1',${fresh})`;
  await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
    values ('expired','1','a',true,false,${new Date(now.getTime() - 1000)}),
           ('live','1','a',true,false,${new Date(now.getTime() + 3_600_000)})`;
  await sql`insert into job_unique_locks (key, expires_at)
    values ('expired',${new Date(now.getTime() - 1000)}),
           ('live',${new Date(now.getTime() + 3_600_000)})`;
  return { old, edge, fresh };
}

const zeros: PruneCounts = {
  agentEventAudits: 0,
  accessLog: 0,
  joinAttempts: 0,
  idempotencyKeys: 0,
  searchLog: 0,
  boardViews: 0,
  reminderDeliveries: 0,
  sessions: 0,
  jobUniqueLocks: 0,
};

describe.skipIf(!DB)("scoped prune bounded deferral (test Postgres, acceptance)", () => {
  it.each(scoped)(
    "$table times out while held, isolates failure, commits peers and recovers",
    async (held) => {
      const fixture = await createJobsFixture(DB!);
      const name = `scoped_prune_${fixture.schemaName}`;
      const sweeper = pruneClient(fixture.schemaName, name);
      const locker = pruneClient(fixture.schemaName, "scoped_prune_holder");
      const observer = fixture.client;
      let pending: Promise<unknown> | undefined;
      try {
        await migrate(sweeper as unknown as Sql);
        const now = new Date();
        const times = await seed(observer, now);
        const [baseline] = await sweeper`select current_setting('lock_timeout') as timeout`;
        await locker.unsafe("BEGIN");
        const [holder] = await locker<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await locker.unsafe(`select id from ${held.table} order by id offset 1 limit 1 for update`);
        const reports: (readonly Failure[])[] = [];
        const caps: boolean[] = [];
        let counts: PruneCounts | undefined;
        const start = Date.now();
        pending = pgSingleFlight(sweeper)("model:prune", async (tx) => {
          counts = await pruneModelTables(
            {
              ...pgPruneStores(tx),
              // Keep the production dispatch-pool boundary for leases.
              jobUniqueLocks: pgPruneStores(observer).jobUniqueLocks,
            },
            now,
            {
              reportCap: (value) => caps.push(value),
              reportFailures: (failures) => reports.push(failures),
            },
          );
        });
        void pending.catch(() => {});
        await observeLockWait(observer, name, holder!.pid);
        // The flight remains single-flight even while one table is waiting.
        let competingRan = false;
        expect(
          await pgSingleFlight(observer)("model:prune", async () => {
            competingRan = true;
          }),
        ).toBe(false);
        expect(competingRan).toBe(false);
        expect(await within(pending, 9000)).toBe(true);
        expect(Date.now() - start).toBeLessThan(10_000);
        // All assertions are before ROLLBACK: releasing the held row cannot
        // manufacture a passing timeout or healthy-table commit.
        expect(reports).toHaveLength(1);
        expect(reports[0]).toHaveLength(1);
        expect(reports[0]![0]!.table).toBe(held.key);
        // Equal 5 s lock and statement deadlines race: lock_timeout reports
        // 55P03, statement_timeout reports 57014. Either bounded cancellation
        // proves deferral under the witnessed held lock; the
        // execution-budget suite pins each deadline separately.
        expect(["55P03", "57014"]).toContain((reports[0]![0]!.error as { code: string }).code);
        expect(caps).toEqual([false]);
        expect(counts).toEqual({
          agentEventAudits: 2,
          accessLog: 2,
          joinAttempts: 1,
          idempotencyKeys: 2,
          searchLog: 2,
          boardViews: 2,
          reminderDeliveries: 2,
          sessions: 1,
          jobUniqueLocks: 1,
          [held.key]: 0,
        });
        for (const table of scoped) {
          const rows = await observer.unsafe(
            `select ${table.clock} as at from ${table.table} order by id`,
          );
          expect(
            rows.map((row) => row.at),
            table.table,
          ).toEqual(
            table.key === held.key
              ? [times.old, times.old, times.edge, times.fresh]
              : [times.edge, times.fresh],
          );
        }
        expect(
          (await observer`select request_id from join_attempts order by id`).map(
            (r) => r.request_id,
          ),
        ).toEqual(["edge", "fresh"]);
        expect(
          (await observer`select token_hash from web_sessions`).map((r) => r.token_hash),
        ).toEqual(["live"]);
        expect((await observer`select key from job_unique_locks`).map((r) => r.key)).toEqual([
          "live",
        ]);
        // max:1 makes this the same backend; SET LOCAL must not leak to the pool.
        expect((await sweeper`select current_setting('lock_timeout') as timeout`)[0]!.timeout).toBe(
          baseline!.timeout,
        );
        await locker.unsafe("ROLLBACK");
        const recoveryReports: (readonly Failure[])[] = [];
        let recovered: PruneCounts | undefined;
        expect(
          await pgSingleFlight(sweeper)("model:prune", async (tx) => {
            recovered = await pruneModelTables(pgPruneStores(tx), now, {
              reportFailures: (failures) => recoveryReports.push(failures),
            });
          }),
        ).toBe(true);
        expect(recovered).toEqual({ ...zeros, [held.key]: 2 });
        expect(recoveryReports).toEqual([]);
        expect(await pruneModelTables(pgPruneStores(sweeper), now)).toEqual(zeros);
        for (const table of scoped) {
          const rows = await observer.unsafe(
            `select ${table.clock} as at from ${table.table} order by id`,
          );
          expect(
            rows.map((row) => row.at),
            `${table.table} cutoff controls`,
          ).toEqual([times.edge, times.fresh]);
        }
      } finally {
        await locker.unsafe("ROLLBACK");
        await pending?.catch(() => {});
        await sweeper.end({ timeout: 1 });
        await locker.end({ timeout: 1 });
        await fixture.dispose();
      }
    },
    30_000,
  );

  it("keeps the canonical append-only triggers without a role or privilege change", async () => {
    const fixture = await createJobsFixture(DB!);
    const sql = fixture.client;
    try {
      await sql`insert into agent_event_audits (operation, request_id, result)
        values ('read','append-control','ok')`;
      await sql`insert into member_data_access_logs
        (viewer_discord_id, resource, action, subject_user_ids, subject_count)
        values ('1','members','view','[]',0)`;
      await sql`insert into activity_log (description) values ('append-control')`;
      // The existing trigger must refuse fresh-row DELETE and every UPDATE,
      // even for the disposable fixture owner. No SELECT/DELETE-only-role
      // claim: this checks the trigger, not the parent's rights evidence.
      for (const table of ["agent_event_audits", "member_data_access_logs", "activity_log"]) {
        const before = await sql.unsafe(`select * from ${table} order by id`);
        await expect(sql.unsafe(`update ${table} set id = id`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(sql.unsafe(`delete from ${table}`)).rejects.toMatchObject({ code: "42501" });
        expect(await sql.unsafe(`select * from ${table} order by id`)).toEqual(before);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
