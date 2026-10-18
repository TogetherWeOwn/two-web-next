// Acceptance oracle: every scheduled model:prune adapter (the six age
// deletes plus the web_sessions expiry sweep) skips an eligible row that an
// independent transaction holds FOR UPDATE instead of waiting on it. The
// unlocked eligible rows still delete, cutoff-exact and newer rows survive,
// the locked row is deferred untouched and drains on a later pass once the
// holder releases, and one table's locked row never stalls the whole
// single-flight scheduled pass: the other tables' deletions commit and are
// visible to other connections while the holder still holds.
//
// Remove row-lock avoidance (SKIP LOCKED candidate selection) from any one
// adapter and that adapter's case here must stall past the race bound;
// remove it from the scheduled composition and the single-flight case must
// stall with it. Waiting on the holder and then deleting its row in the
// same pass is a failure, not an alternative pass.
//
// No claim is made about unrelated schema/table locks; only independently
// row-locked eligible candidates are covered.
//
// Live round-trips use a guarded disposable schema on agent-testdb or the
// explicitly allowed GitHub CI Postgres service.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgSingleFlight } from "../src/jobs/postgres";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

const DAY = 86_400_000;
// A skip-locked prune answers in milliseconds against these tiny tables.
// Anything still unsettled at the bound is waiting on the holder's lock.
const LOCK_RACE_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ageDates(now: Date) {
  // Fixed cutoff for every direct call: edge rows sit exactly on it
  // (`< cutoff` is false, so they survive as the database clock advances).
  // Old rows are 91 days back, a full day past both the cutoff and the
  // audit database-clock guard, so no skew can flip eligibility mid-test.
  const cutoff = new Date(now.getTime() - 90 * DAY);
  return {
    cutoff,
    old: new Date(now.getTime() - 91 * DAY),
    edge: new Date(cutoff.getTime()),
    fresh: new Date(now.getTime() - DAY),
  };
}

/** Independent second connection used only to hold one eligible row locked. */
function holderFor(fixture: JobsFixture): postgres.Sql {
  const url = testDatabaseUrl(process.env.DATABASE_URL!);
  return postgres(url.href, {
    max: 1,
    port: 5432,
    password: () => url.password,
    connection: { search_path: fixture.schemaName },
    onnotice: () => {},
  });
}

/**
 * Hold `lockStatement`'s row FOR UPDATE on a separate connection, run `call`
 * against the race bound, and run `whileLocked` with the result while the
 * holder still holds. The holder always rolls back and any blocked call is
 * awaited after the release, so a stalling implementation fails this case
 * without leaving work dangling into later tests.
 */
async function attemptWhileLocked<T>(args: {
  fixture: JobsFixture;
  lockStatement: string;
  call: () => Promise<T>;
  whileLocked: (result: T) => Promise<void>;
}): Promise<void> {
  const holder = holderFor(args.fixture);
  let call: Promise<T> | undefined;
  try {
    await holder.unsafe("BEGIN");
    await holder.unsafe(args.lockStatement);
    call = args.call();
    const outcome = await Promise.race([
      call.then((result) => ({ settled: true as const, result })),
      sleep(LOCK_RACE_MS).then(() => ({ settled: false as const })),
    ]);
    expect(outcome.settled, "prune must not wait on the locked eligible row").toBe(true);
    if (outcome.settled) await args.whileLocked(outcome.result);
  } finally {
    await holder.unsafe("ROLLBACK").catch(() => undefined);
    await holder.end();
    await call?.catch(() => null);
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "scheduled prune adapters skip locked eligible rows (test Postgres)",
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

    it("control: an unlocked pass deletes eligible rows and keeps cutoff-exact/newer rows", async () => {
      const stores = pgPruneStores(sql);
      const now = new Date();
      const { cutoff, old, edge, fresh } = ageDates(now);

      await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
        values ('ctl-search-old-a',3,${old}),('ctl-search-old-b',2,${old}),
               ('ctl-search-edge',1,${edge}),('ctl-search-fresh',0,${fresh})`;
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(2);
      const searches = await sql<
        { normalized_query: string }[]
      >`select normalized_query from event_search_logs
          where normalized_query like 'ctl-search-%' order by normalized_query`;
      expect(searches.map((r) => r.normalized_query)).toEqual([
        "ctl-search-edge",
        "ctl-search-fresh",
      ]);
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(0);

      await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('ctl-session-old','1','a',true,false,${new Date(now.getTime() - 1000)}),
               ('ctl-session-edge','2','b',true,false,${now}),
               ('ctl-session-live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;
      // Expiry-exact sessions are eligible (reads require expires_at > now).
      expect(await stores.sessions.sweepExpired(now)).toBe(2);
      const sessions = await sql<{ token_hash: string }[]>`select token_hash from web_sessions
          where token_hash like 'ctl-session-%' order by token_hash`;
      expect(sessions.map((r) => r.token_hash)).toEqual(["ctl-session-live"]);
      expect(await stores.sessions.sweepExpired(now)).toBe(0);

      // Remove the control survivors: the lock cases below reuse these two
      // tables with their own later cutoffs, under which the control's
      // cutoff-exact row would become eligible and skew their exact counts.
      await sql`delete from event_search_logs where normalized_query like 'ctl-search-%'`;
      await sql`delete from web_sessions where token_hash like 'ctl-session-%'`;
    });

    it("agentEventAudits skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      await sql`insert into agent_event_audits (operation, request_id, result, created_at)
        values ('create','sl-audit-locked','ok',${old}),('create','sl-audit-free-a','ok',${old}),
               ('create','sl-audit-free-b','ok',${old}),('create','sl-audit-edge','ok',${edge}),
               ('create','sl-audit-fresh','ok',${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { request_id: string }[]
          >`select request_id from agent_event_audits where request_id like 'sl-audit-%' order by request_id`
        ).map((r) => r.request_id);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from agent_event_audits where request_id = 'sl-audit-locked' for update",
        call: () => stores.agentEventAudits.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual(["sl-audit-edge", "sl-audit-fresh", "sl-audit-locked"]);
        },
      });

      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-audit-edge", "sl-audit-fresh"]);
      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(0);
    });

    it("accessLog skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
        values ('sl-access-locked','members','view','["2"]',1,${old}),
               ('sl-access-free-a','members','view','["2"]',1,${old}),
               ('sl-access-free-b','members','view','["2"]',1,${old}),
               ('sl-access-edge','members','view','["2"]',1,${edge}),
               ('sl-access-fresh','members','view','["2"]',1,${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { viewer_discord_id: string }[]
          >`select viewer_discord_id from member_data_access_logs where viewer_discord_id like 'sl-access-%' order by viewer_discord_id`
        ).map((r) => r.viewer_discord_id);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from member_data_access_logs where viewer_discord_id = 'sl-access-locked' for update",
        call: () => stores.accessLog.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual([
            "sl-access-edge",
            "sl-access-fresh",
            "sl-access-locked",
          ]);
        },
      });

      expect(await stores.accessLog.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-access-edge", "sl-access-fresh"]);
      expect(await stores.accessLog.pruneOlderThan(cutoff)).toBe(0);
    });

    it("joinAttempts skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        values ('added','site','sl-join-locked','10',${old}),('added','site','sl-join-free-a','10',${old}),
               ('added','site','sl-join-free-b','10',${old}),('added','site','sl-join-edge','11',${edge}),
               ('denied','site','sl-join-fresh','12',${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { request_id: string }[]
          >`select request_id from join_attempts where request_id like 'sl-join-%' order by request_id`
        ).map((r) => r.request_id);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from join_attempts where request_id = 'sl-join-locked' for update",
        call: () => stores.joinAttempts.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual(["sl-join-edge", "sl-join-fresh", "sl-join-locked"]);
        },
      });

      expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-join-edge", "sl-join-fresh"]);
      expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(0);
    });

    it("idempotencyKeys skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      const [grant] = await sql<
        { id: string }[]
      >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        values ('a','co','g',${`sl-h-${fixture!.schemaName}`}) returning id`;
      await sql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
        values (${grant!.id},'sl-key-locked','d',200,'{}',${old}),(${grant!.id},'sl-key-free-a','d',200,'{}',${old}),
               (${grant!.id},'sl-key-free-b','d',200,'{}',${old}),(${grant!.id},'sl-key-edge','d',200,'{}',${edge}),
               (${grant!.id},'sl-key-fresh','d',200,'{}',${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { key: string }[]
          >`select key from agent_event_idempotency_keys where key like 'sl-key-%' order by key`
        ).map((r) => r.key);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from agent_event_idempotency_keys where key = 'sl-key-locked' for update",
        call: () => stores.idempotencyKeys.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual(["sl-key-edge", "sl-key-fresh", "sl-key-locked"]);
        },
      });

      expect(await stores.idempotencyKeys.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-key-edge", "sl-key-fresh"]);
      expect(await stores.idempotencyKeys.pruneOlderThan(cutoff)).toBe(0);
    });

    it("searchLog skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
        values ('sl-search-locked',3,${old}),('sl-search-free-a',3,${old}),
               ('sl-search-free-b',2,${old}),('sl-search-edge',1,${edge}),('sl-search-fresh',0,${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { normalized_query: string }[]
          >`select normalized_query from event_search_logs where normalized_query like 'sl-search-%' order by normalized_query`
        ).map((r) => r.normalized_query);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from event_search_logs where normalized_query = 'sl-search-locked' for update",
        call: () => stores.searchLog.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual([
            "sl-search-edge",
            "sl-search-fresh",
            "sl-search-locked",
          ]);
        },
      });

      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-search-edge", "sl-search-fresh"]);
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(0);
    });

    it("boardViews skips a locked eligible row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const { cutoff, old, edge, fresh } = ageDates(new Date());
      await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
        values ('sl-board-locked','overall','all',3,${old}),('sl-board-free-a','overall','all',3,${old}),
               ('sl-board-free-b','overall','all',2,${old}),('sl-board-edge','overall','all',1,${edge}),
               ('sl-board-fresh','overall','all',0,${fresh})`;
      const survivors = async () =>
        (
          await sql<
            { normalized_board_key: string }[]
          >`select normalized_board_key from board_view_logs where normalized_board_key like 'sl-board-%' order by normalized_board_key`
        ).map((r) => r.normalized_board_key);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select id from board_view_logs where normalized_board_key = 'sl-board-locked' for update",
        call: () => stores.boardViews.pruneOlderThan(cutoff),
        whileLocked: async (deleted) => {
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual(["sl-board-edge", "sl-board-fresh", "sl-board-locked"]);
        },
      });

      expect(await stores.boardViews.pruneOlderThan(cutoff)).toBe(1);
      expect(await survivors()).toEqual(["sl-board-edge", "sl-board-fresh"]);
      expect(await stores.boardViews.pruneOlderThan(cutoff)).toBe(0);
    });

    it("sessions sweep skips a locked expired row and drains it after release", async () => {
      const stores = pgPruneStores(sql);
      const now = new Date();
      const expired = new Date(now.getTime() - 60_000);
      await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('sl-session-locked','1','a',true,false,${expired}),
               ('sl-session-free','1','a',true,false,${expired}),
               ('sl-session-edge','2','b',true,false,${now}),
               ('sl-session-live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;
      const survivors = async () =>
        (
          await sql<
            { token_hash: string }[]
          >`select token_hash from web_sessions where token_hash like 'sl-session-%' order by token_hash`
        ).map((r) => r.token_hash);

      await attemptWhileLocked({
        fixture: fixture!,
        lockStatement:
          "select token_hash from web_sessions where token_hash = 'sl-session-locked' for update",
        call: () => stores.sessions.sweepExpired(now),
        whileLocked: async (deleted) => {
          // The free expired row and the expiry-exact row sweep; the locked
          // expired row defers and the live row is untouched.
          expect(deleted).toBe(2);
          expect(await survivors()).toEqual(["sl-session-live", "sl-session-locked"]);
        },
      });

      expect(await stores.sessions.sweepExpired(now)).toBe(1);
      expect(await survivors()).toEqual(["sl-session-live"]);
      expect(await stores.sessions.sweepExpired(now)).toBe(0);
    });

    it("one table's locked row does not stall or roll back the scheduled pass", async () => {
      // Isolated schema: the scheduled pass reports whole-table counts, so
      // no other case's survivors may be in scope.
      const iso = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const { migrate } = await import("../src/sessions");
        await migrate(iso.client as unknown as Parameters<typeof migrate>[0]);
        const psql = iso.client;
        const now = new Date();
        const { old, fresh } = ageDates(now);

        await psql`insert into agent_event_audits (operation, request_id, result, created_at)
          values ('create','sched-audit-old','ok',${old})`;
        await psql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
          values ('sched-access-old','members','view','["2"]',1,${old})`;
        await psql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
          values ('added','site','sched-join-locked','10',${old}),
                 ('added','site','sched-join-old','10',${old}),
                 ('denied','site','sched-join-fresh','12',${fresh})`;
        const [grant] = await psql<
          { id: string }[]
        >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
          values ('a','co','g',${`sched-h-${iso.schemaName}`}) returning id`;
        await psql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
          values (${grant!.id},'sched-key-old','d',200,'{}',${old})`;
        await psql`insert into event_search_logs (normalized_query, result_count, occurred_at)
          values ('sched-search-old',3,${old})`;
        await psql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
          values ('sched-board-old','overall','all',3,${old})`;
        await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
          values ('sched-session-old','1','a',true,false,${new Date(now.getTime() - 60_000)})`;

        const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

        let firstCounts: Awaited<ReturnType<typeof pruneModelTables>> | undefined;
        await attemptWhileLocked({
          fixture: iso,
          lockStatement:
            "select id from join_attempts where request_id = 'sched-join-locked' for update",
          call: () =>
            pgSingleFlight(psql)(`sl-sched-${Date.now()}`, async (db) => {
              firstCounts = await pruneModelTables(pgPruneStores(db), now);
            }),
          whileLocked: async (ran) => {
            expect(ran).toBe(true);
            expect(firstCounts).toEqual({
              agentEventAudits: 1,
              accessLog: 1,
              joinAttempts: 1,
              idempotencyKeys: 1,
              searchLog: 1,
              boardViews: 1,
              sessions: 1,
            });
            // Read from the fixture's own autocommit connection while the
            // holder still holds: the other tables' deletions are already
            // committed and visible, not parked in an open transaction.
            expect(
              await count(psql`select count(*)::int as n from agent_event_audits
                where request_id = 'sched-audit-old'`),
            ).toBe(0);
            expect(
              await count(psql`select count(*)::int as n from member_data_access_logs
                where viewer_discord_id = 'sched-access-old'`),
            ).toBe(0);
            expect(
              await count(psql`select count(*)::int as n from agent_event_idempotency_keys
                where key = 'sched-key-old'`),
            ).toBe(0);
            expect(
              await count(psql`select count(*)::int as n from event_search_logs
                where normalized_query = 'sched-search-old'`),
            ).toBe(0);
            expect(
              await count(psql`select count(*)::int as n from board_view_logs
                where normalized_board_key = 'sched-board-old'`),
            ).toBe(0);
            expect(
              await count(psql`select count(*)::int as n from web_sessions
                where token_hash = 'sched-session-old'`),
            ).toBe(0);
            // The locked row defers; the fresh row was never eligible.
            const joins = await psql<
              { request_id: string }[]
            >`select request_id from join_attempts order by request_id`;
            expect(joins.map((r) => r.request_id)).toEqual([
              "sched-join-fresh",
              "sched-join-locked",
            ]);
          },
        });

        // Logs carry counts only: no row markers or session material.
        expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("sched-");

        // The next pass drains exactly the deferred row and nothing else.
        expect(await pruneModelTables(pgPruneStores(psql), now)).toEqual({
          agentEventAudits: 0,
          accessLog: 0,
          joinAttempts: 1,
          idempotencyKeys: 0,
          searchLog: 0,
          boardViews: 0,
          sessions: 0,
        });
        const joins = await psql<
          { request_id: string }[]
        >`select request_id from join_attempts order by request_id`;
        expect(joins.map((r) => r.request_id)).toEqual(["sched-join-fresh"]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
        await iso.dispose();
      }
    });
  },
);
