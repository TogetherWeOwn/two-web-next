// Lock-skipping controls for the three non-scoped scheduled prune adapters:
// join_attempts, web_sessions and job_unique_locks still skip held rows.
// The five scoped age tables instead defer a whole batch on lock timeout;
// their scheduled-flight/isolation proof lives in
// prune-lock-free-contention-acceptance.test.ts. Cutoff and recovery controls
// here remain unchanged. Reconciled by the test owner for that contract.
//
// Live round-trips use a guarded disposable schema on agent-testdb or the CI
// service only; memory fakes are not used here because row locks need real
// Postgres.
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgUniqueLock } from "../src/jobs/postgres";
import type { Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const DB = process.env.DATABASE_URL;
const DAY = 86_400_000;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function seedAgeTables(
  client: postgres.Sql,
  grantId: string,
  old: Date,
  edge: Date,
  fresh: Date,
) {
  await client`insert into agent_event_audits (operation, request_id, result, created_at)
    values ('create','lock-audit','ok',${old}),('create','free-audit','ok',${old}),
           ('create','edge-audit','ok',${edge}),('create','fresh-audit','ok',${fresh})`;
  await client`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
    values ('lock-acc','members','view','["2"]',1,${old}),('free-acc','members','view','["2"]',1,${old}),
           ('edge-acc','members','view','["2"]',1,${edge}),('fresh-acc','members','view','["2"]',1,${fresh})`;
  await client`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
    values ('added','site','lock-join','10',${old}),('added','site','free-join','11',${old}),
           ('added','site','edge-join','12',${edge}),('denied','site','fresh-join','13',${fresh})`;
  await client`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
    values (${grantId},'lock-key','d',200,'{}',${old}),(${grantId},'free-key','d',200,'{}',${old}),
           (${grantId},'edge-key','d',200,'{}',${edge}),(${grantId},'fresh-key','d',200,'{}',${fresh})`;
  await client`insert into event_search_logs (normalized_query, result_count, occurred_at)
    values ('lock q',0,${old}),('free q',0,${old}),('edge q',1,${edge}),('fresh q',0,${fresh})`;
  await client`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
    values ('lock-board','overall','all',0,${old}),('free-board','overall','all',0,${old}),
           ('edge-board','overall','all',1,${edge}),('fresh-board','overall','all',0,${fresh})`;
  const [event] = await client<{ id: number }[]>`insert into events
    (event_key, title, starts_at, ends_at)
    values ('skip-lock-event', 'Synthetic prune event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z') returning id`;
  await client`insert into event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
    values (${event!.id},'lock-delivery','24h','site','sent',${old}),(${event!.id},'free-delivery','24h','site','sent',${old}),
           (${event!.id},'edge-delivery','24h','site','sent',${edge}),(${event!.id},'fresh-delivery','24h','site','sent',${fresh})`;
}

async function seedSessions(client: postgres.Sql, now: Date) {
  const expired = new Date(now.getTime() - 60_000);
  const live = new Date(now.getTime() + 3_600_000);
  await client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
    values ('lock-sess','1','a',true,false,${expired}),('free-sess','2','b',true,false,${expired}),
           ('edge-sess','3','c',true,false,${now}),('live-sess','4','d',true,false,${live})`;
}

async function seedLocks(client: postgres.Sql, now: Date) {
  const expired = new Date(now.getTime() - 60_000);
  const live = new Date(now.getTime() + 3_600_000);
  await client`insert into job_unique_locks (key, expires_at)
    values ('lock-uls',${expired}),('free-uls',${expired}),
           ('edge-uls',${now}),('live-uls',${live})`;
}

/** Run work while the locker tx holds its row locks; report whether it settled
 *  before release or was observed blocked on the holder. Never awaits a blocked
 *  statement inside the caller's transaction (that would hang the holder). */
async function runObserved<T>(
  observer: postgres.Sql,
  sweeperName: string,
  holderPid: number,
  work: () => Promise<T>,
): Promise<{ settled: boolean; blocked: boolean; value: T | undefined }> {
  const pending = work();
  let settled = false;
  let value: T | undefined;
  let failed: unknown;
  void pending.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      failed = e;
    },
  );
  const deadline = Date.now() + 10_000;
  let blocked = false;
  for (;;) {
    if (settled) break;
    const rows = await observer<{ n: number }[]>`select count(*)::int as n
      from pg_stat_activity
      where application_name = ${sweeperName} and wait_event_type = 'Lock'
        and ${holderPid} = any(pg_blocking_pids(pid))`;
    if (rows[0]!.n >= 1) {
      blocked = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await delay(5);
  }
  if (settled && failed !== undefined) throw failed;
  if (settled) return { settled: true, blocked: false, value };
  if (blocked) return { settled: false, blocked: true, value: undefined };
  throw new Error("sweep neither completed nor reached the held row lock");
}

describe.skipIf(!DB)("scheduled prune skips locked rows (test Postgres)", () => {
  it("non-scoped adapters delete unlocked eligible rows while held, then drain the deferred rows", async () => {
    const fixture = await createJobsFixture(DB!, { max: 4 });
    const sweeperName = `prune_skiplock_${Date.now()}`;
    const sweeper = schemaClient(fixture, sweeperName, 2);
    const observer = schemaClient(fixture, "prune_skiplock_obs", 2);
    const locker = schemaClient(fixture, "prune_skiplock_hold", 1);
    let first: Record<string, number> = {};
    let observedBlocked: string[] = [];
    let settledBeforeRelease = false;
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(sweeper as unknown as Sql);
      const now = new Date();
      const old = new Date(now.getTime() - 91 * DAY);
      const cutoff = new Date(now.getTime() - 90 * DAY);
      const edge = new Date(cutoff.getTime());
      const fresh = new Date(now.getTime() - DAY);
      const [grant] = await observer<{ id: string }[]>`insert into agent_event_grants
        (agent_id, company_id, guild_id, verifier_hash)
        values ('a','co','g',${`skip-h-${fixture.schemaName}`}) returning id`;
      await seedAgeTables(observer, grant!.id, old, edge, fresh);
      await seedSessions(observer, now);
      await seedLocks(observer, now);
      const stores = pgPruneStores(sweeper);

      await locker.begin(async (tx) => {
        const [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`select id from join_attempts where request_id = 'lock-join' for update`;
        await tx`select token_hash from web_sessions where token_hash = 'lock-sess' for update`;
        await tx`select key from job_unique_locks where key = 'lock-uls' for update`;

        const runs: [string, () => Promise<number>][] = [
          ["joinAttempts", () => stores.joinAttempts.pruneOlderThan(cutoff)],
          ["sessions", () => stores.sessions.sweepExpired(now)],
          ["jobUniqueLocks", () => stores.jobUniqueLocks!.sweepExpired(now)],
        ];
        for (const [name, run] of runs) {
          const r = await runObserved(observer, sweeperName, holder!.pid, run);
          if (!r.settled || r.blocked) {
            observedBlocked.push(name);
            break;
          }
          first[name] = r.value!;
        }
        settledBeforeRelease = observedBlocked.length === 0 && Object.keys(first).length === 3;
      });

      // These three adapters retain SKIP LOCKED. They must still commit free
      // rows, including expiry-exact sessions/leases, while the holder parks.
      expect(observedBlocked).toEqual([]);
      expect(settledBeforeRelease).toBe(true);
      expect(first).toEqual({
        joinAttempts: 1,
        sessions: 2,
        jobUniqueLocks: 2,
      });

      // Locked rows survived the pass; cutoff-exact and newer controls did too.
      expect(
        (await observer`select 1 from agent_event_audits where request_id = 'lock-audit'`).length,
      ).toBe(1);
      expect((await observer`select 1 from job_unique_locks where key = 'lock-uls'`).length).toBe(
        1,
      );
      expect((await observer`select 1 from job_unique_locks where key = 'live-uls'`).length).toBe(
        1,
      );
      expect((await observer`select 1 from job_unique_locks where key = 'edge-uls'`).length).toBe(
        0,
      );
      expect(
        (await observer`select 1 from web_sessions where token_hash = 'lock-sess'`).length,
      ).toBe(1);
      expect(
        (await observer`select 1 from web_sessions where token_hash = 'edge-sess'`).length,
      ).toBe(0);
      expect(
        (await observer`select 1 from web_sessions where token_hash = 'live-sess'`).length,
      ).toBe(1);

      // Release happened when the locker transaction ended: the next pass
      // drains the three deferred rows and the six untouched scoped tables.
      const second = {
        agentEventAudits: await stores.agentEventAudits.pruneOlderThan(cutoff),
        accessLog: await stores.accessLog.pruneOlderThan(cutoff),
        joinAttempts: await stores.joinAttempts.pruneOlderThan(cutoff),
        idempotencyKeys: await stores.idempotencyKeys.pruneOlderThan(cutoff),
        searchLog: await stores.searchLog.pruneOlderThan(cutoff),
        boardViews: await stores.boardViews.pruneOlderThan(cutoff),
        reminderDeliveries: await stores.reminderDeliveries.pruneOlderThan(cutoff),
        sessions: await stores.sessions.sweepExpired(now),
        jobUniqueLocks: await stores.jobUniqueLocks!.sweepExpired(now),
      };
      expect(second).toEqual({
        agentEventAudits: 2,
        accessLog: 2,
        joinAttempts: 1,
        idempotencyKeys: 2,
        searchLog: 2,
        boardViews: 2,
        reminderDeliveries: 2,
        sessions: 1,
        jobUniqueLocks: 1,
      });
      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(0);
      expect(await stores.sessions.sweepExpired(now)).toBe(0);
      expect(await stores.jobUniqueLocks!.sweepExpired(now)).toBe(0);
      // Cutoff-exact and fresh age controls survive both passes.
      const audits = await observer<
        { request_id: string }[]
      >`select request_id from agent_event_audits
        where request_id in ('edge-audit','fresh-audit') order by id`;
      expect(audits.map((r) => r.request_id)).toEqual(["edge-audit", "fresh-audit"]);
    } finally {
      await sweeper.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await locker.end({ timeout: 1 });
      await fixture.dispose();
    }
  }, 60_000);

  it("one table's locked row does not prevent other tables' deletions from committing", async () => {
    const fixture = await createJobsFixture(DB!, { max: 4 });
    const sweeperName = `prune_sched_${Date.now()}`;
    const sweeper = schemaClient(fixture, sweeperName, 4);
    const observer = schemaClient(fixture, "prune_sched_obs", 2);
    const locker = schemaClient(fixture, "prune_sched_hold", 1);
    let counts: Record<string, number> | undefined;
    let blocked = false;
    let settled = false;
    let pass: Promise<Record<string, number>> | undefined;
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(sweeper as unknown as Sql);
      const now = new Date();
      const old = new Date(now.getTime() - 91 * DAY);
      const edge = new Date(now.getTime() - 90 * DAY);
      const fresh = new Date(now.getTime() - DAY);
      const [grant] = await observer<{ id: string }[]>`insert into agent_event_grants
        (agent_id, company_id, guild_id, verifier_hash)
        values ('a','co','g',${`sched-h-${fixture.schemaName}`}) returning id`;
      // Every table holds exactly one unlocked eligible row; only join_attempts
      // additionally holds one locked eligible row. Cutoff-exact/newer controls
      // ride along in every table, and sessions carries its live control.
      await observer`insert into agent_event_audits (operation, request_id, result, created_at)
        values ('create','free-audit','ok',${old}),('create','edge-audit','ok',${edge}),('create','fresh-audit','ok',${fresh})`;
      await observer`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
        values ('free-acc','members','view','["2"]',1,${old}),('edge-acc','members','view','["2"]',1,${edge}),('fresh-acc','members','view','["2"]',1,${fresh})`;
      await observer`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        values ('added','site','lock-join','10',${old}),('added','site','free-join','11',${old}),
               ('added','site','edge-join','12',${edge}),('denied','site','fresh-join','13',${fresh})`;
      await observer`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
        values (${grant!.id},'free-key','d',200,'{}',${old}),(${grant!.id},'edge-key','d',200,'{}',${edge}),(${grant!.id},'fresh-key','d',200,'{}',${fresh})`;
      await observer`insert into event_search_logs (normalized_query, result_count, occurred_at)
        values ('free q',0,${old}),('edge q',1,${edge}),('fresh q',0,${fresh})`;
      await observer`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
        values ('free-board','overall','all',0,${old}),('edge-board','overall','all',1,${edge}),('fresh-board','overall','all',0,${fresh})`;
      const [schedEvent] = await observer<{ id: number }[]>`insert into events
        (event_key, title, starts_at, ends_at)
        values ('skip-lock-sched-event', 'Synthetic prune event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z') returning id`;
      await observer`insert into event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
        values (${schedEvent!.id},'free-delivery','24h','site','sent',${old}),(${schedEvent!.id},'edge-delivery','24h','site','sent',${edge}),(${schedEvent!.id},'fresh-delivery','24h','site','sent',${fresh})`;
      await observer`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('free-sess','2','b',true,false,${new Date(now.getTime() - 60_000)}),
               ('edge-sess','3','c',true,false,${now}),
               ('live-sess','4','d',true,false,${new Date(now.getTime() + 3_600_000)})`;
      await observer`insert into job_unique_locks (key, expires_at)
        values ('free-uls',${new Date(now.getTime() - 60_000)}),
               ('live-uls',${new Date(now.getTime() + 3_600_000)})`;

      try {
        await locker.begin(async (tx) => {
          const [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          // Hold exactly one eligible row in exactly one table.
          await tx`select id from join_attempts where request_id = 'lock-join' for update`;
          // Transaction-level scheduled pass, like the single-flight body: the
          // whole prune runs inside one reserved transaction on the sweeper.
          pass = sweeper.begin(
            (stx) =>
              pruneModelTables(
                pgPruneStores(stx as unknown as Parameters<typeof pgPruneStores>[0]),
                now,
              ) as Promise<Record<string, number>>,
          );
          let passSettled = false;
          let passValue: Record<string, number> | undefined;
          void pass.then(
            (v) => {
              passSettled = true;
              passValue = v;
            },
            () => {
              passSettled = true;
            },
          );
          const deadline = Date.now() + 15_000;
          for (;;) {
            if (passSettled) break;
            const rows = await observer<{ n: number }[]>`select count(*)::int as n
              from pg_stat_activity
              where application_name = ${sweeperName} and wait_event_type = 'Lock'
                and ${holder!.pid} = any(pg_blocking_pids(pid))`;
            if (rows[0]!.n >= 1) {
              blocked = true;
              break;
            }
            if (Date.now() >= deadline) break;
            await delay(5);
          }
          settled = passSettled && !blocked;
          if (settled) counts = passValue;
        });
      } finally {
        await pass?.catch(() => {});
      }
      if (!settled) counts = (await pass!) as Record<string, number>;

      // RED before the fix: the pass blocks on the held join row and never
      // settles before release. GREEN: it commits around the lock.
      expect(blocked).toBe(false);
      expect(settled).toBe(true);
      // Every other table drained its free row; the locked table dropped only
      // its free row (locked deferred); sessions dropped free + expiry-exact
      // and the lock sweep dropped its free expired row (live lease stays).
      expect(counts).toMatchObject({
        agentEventAudits: 1,
        accessLog: 1,
        joinAttempts: 1,
        idempotencyKeys: 1,
        searchLog: 1,
        boardViews: 1,
        reminderDeliveries: 1,
        sessions: 2,
        jobUniqueLocks: 1,
      });
      expect(
        (await observer`select 1 from join_attempts where request_id = 'lock-join'`).length,
      ).toBe(1);

      // After release the deferred row drains and the pass runs clean.
      // The live lock lease survives every pass.
      const drain = await pruneModelTables(pgPruneStores(sweeper), now);
      expect(drain.joinAttempts).toBe(1);
      expect(drain.jobUniqueLocks).toBe(0);
      expect((await observer`select 1 from job_unique_locks where key = 'live-uls'`).length).toBe(
        1,
      );
      expect(await pruneModelTables(pgPruneStores(sweeper), now)).toEqual({
        agentEventAudits: 0,
        accessLog: 0,
        joinAttempts: 0,
        idempotencyKeys: 0,
        jobUniqueLocks: 0,
        searchLog: 0,
        boardViews: 0,
        reminderDeliveries: 0,
        sessions: 0,
      });
    } finally {
      await sweeper.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await locker.end({ timeout: 1 });
      await fixture.dispose();
    }
  }, 60_000);

  it("lock sweep on a separate pool commits while the prune transaction is held open, so acquire never waits", async () => {
    // Production wiring (src/jobs/worker.ts): the flight transaction drains
    // the age tables while the lock sweep runs on the autocommit dispatch
    // pool. The sweep deletes the exact rows acquire targets, so holding its
    // row locks until the whole pass commits would block a concurrent
    // INSERT .. ON CONFLICT (the */10 reconcile or an event save landing in
    // the same minute as the 00:00 UTC prune). This test holds a prune-like
    // transaction open and asserts the dispatch-pool sweep plus a concurrent
    // acquire both settle before it commits.
    const fixture = await createJobsFixture(DB!, { max: 4 });
    const sweeperName = `prune_lockfree_${Date.now()}`;
    const sweeper = schemaClient(fixture, sweeperName, 2);
    const acquirerName = `prune_acquire_${Date.now()}`;
    const acquirer = schemaClient(fixture, acquirerName, 2);
    const observer = schemaClient(fixture, "prune_lockfree_obs", 2);
    const holder = schemaClient(fixture, "prune_lockfree_hold", 1);
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(sweeper as unknown as Sql);
      const now = new Date();
      const expired = new Date(now.getTime() - 60_000);
      const live = new Date(now.getTime() + 3_600_000);
      await observer`insert into agent_event_audits (operation, request_id, result, created_at)
        values ('create','held-audit','ok',${new Date(now.getTime() - 91 * DAY)})`;
      await observer`insert into job_unique_locks (key, expires_at)
        values ('prune-held-expired',${expired}),('prune-held-live',${live})`;

      await holder.begin(async (tx) => {
        const [pid] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        // Simulate the long prune pass: an uncommitted delete on another
        // table stays open on this connection while lock traffic runs
        // on the dispatch-like pools.
        await tx`delete from agent_event_audits where request_id = 'held-audit'`;

        const sweep = await runObserved(observer, sweeperName, pid!.pid, () =>
          pgPruneStores(sweeper).jobUniqueLocks!.sweepExpired(now),
        );
        expect(sweep.settled && !sweep.blocked, "sweep settles before prune commit").toBe(true);
        expect(sweep.value).toBe(1);

        const acquire = await runObserved(observer, acquirerName, pid!.pid, () =>
          pgUniqueLock(acquirer).acquire("prune-held-expired", 300),
        );
        expect(acquire.settled && !acquire.blocked, "acquire returns before prune commit").toBe(
          true,
        );
        expect(acquire.value).toEqual(expect.any(String));

        // The live lease is untouched by the sweep and still fences.
        const fenced = await runObserved(observer, acquirerName, pid!.pid, () =>
          pgUniqueLock(acquirer).acquire("prune-held-live", 300),
        );
        expect(fenced.settled && !fenced.blocked).toBe(true);
        expect(fenced.value).toBeNull();
      });

      // The held pass committed its audit delete; both lock keys remain live.
      expect(await observer`select id from agent_event_audits`).toHaveLength(0);
      const keys = await observer<{ key: string }[]>`select key from job_unique_locks order by key`;
      expect(keys.map((r) => r.key)).toEqual(["prune-held-expired", "prune-held-live"]);
    } finally {
      await sweeper.end({ timeout: 1 });
      await acquirer.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await holder.end({ timeout: 1 });
      await fixture.dispose();
    }
  }, 60_000);
});
