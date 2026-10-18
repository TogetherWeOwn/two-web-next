// Daily model:prune retention sweep over agent-event audits,
// access logs, join attempts, idempotency keys and search logs (90-day windows)
// plus the web_sessions expiry cleanup (no legacy equivalent).
// Runs inside the existing prune cron under the advisory-lock single-flight.
//
// Memory fakes always run; live round-trips use a guarded disposable schema
// on agent-testdb or the explicitly allowed GitHub CI Postgres service.
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AGENT_EVENT_AUDIT_RETENTION_DAYS,
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  IDEMPOTENCY_KEY_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  PRUNE_CRON,
  PRUNE_DELETE_BATCH_SIZE,
  PRUNE_DELETE_MAX_BATCHES,
} from "../src/jobs/constants";
import { pruneModelTables, runScheduled } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const DAY = 86_400_000;

function memTable() {
  const at: Date[] = [];
  const cutoffs: Date[] = [];
  return {
    at,
    cutoffs,
    async pruneOlderThan(cutoff: Date): Promise<number> {
      cutoffs.push(cutoff);
      let n = 0;
      for (let i = at.length - 1; i >= 0; i--) {
        if (at[i]! < cutoff) {
          at.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}

function memStores(now: Date): Omit<PruneStores, "sessions"> & {
  sessions: SessionStore;
  tables: Record<string, ReturnType<typeof memTable>>;
} {
  const tables = {
    agentEventAudits: memTable(),
    accessLog: memTable(),
    joinAttempts: memTable(),
    idempotencyKeys: memTable(),
    searchLog: memTable(),
    boardViews: memTable(),
  };
  return {
    ...tables,
    sessions: createMemorySessionStore(() => now.getTime()),
    tables,
  };
}

describe("model:prune windows and sweep (memory, no DB)", () => {
  it("retention windows match the legacy 90-day defaults", () => {
    // Legacy: config/member_access_log.php, config/join.php,
    // config/agent-events.php, config/event_search_log.php — all 90.
    expect(AGENT_EVENT_AUDIT_RETENTION_DAYS).toBe(90);
    expect(MEMBER_ACCESS_LOG_RETENTION_DAYS).toBe(90);
    expect(JOIN_ATTEMPT_RETENTION_DAYS).toBe(90);
    expect(IDEMPOTENCY_KEY_RETENTION_DAYS).toBe(90);
    expect(EVENT_SEARCH_LOG_RETENTION_DAYS).toBe(90);
  });

  it("prune deletes carry a documented fixed per-statement batch bound", () => {
    // Each statement removes at most this many rows per pruned table,
    // including the scheduled session expiry sweep; the pass drains per
    // table up to PRUNE_DELETE_MAX_BATCHES batches and pages once per pass
    // when the cap is hit with rows possibly pending.
    expect(PRUNE_DELETE_BATCH_SIZE).toBe(1000);
    expect(PRUNE_DELETE_MAX_BATCHES).toBe(100);
  });

  it("drains a multi-batch backlog in one pass and sums the counts", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const calls: number[] = [];
    const stubTable = (returns: number[]) => ({
      async pruneOlderThan(_cutoff: Date): Promise<number> {
        calls.push(1);
        return returns.length > 0 ? returns.shift()! : 0;
      },
    });
    const tables = {
      agentEventAudits: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
      accessLog: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
      joinAttempts: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
      idempotencyKeys: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
      searchLog: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
      boardViews: stubTable([PRUNE_DELETE_BATCH_SIZE, 3]),
    };
    const stores = {
      ...tables,
      sessions: createMemorySessionStore(() => now.getTime()),
    };
    const counts = await pruneModelTables(stores, now);
    expect(counts).toMatchObject({
      agentEventAudits: PRUNE_DELETE_BATCH_SIZE + 3,
      accessLog: PRUNE_DELETE_BATCH_SIZE + 3,
      joinAttempts: PRUNE_DELETE_BATCH_SIZE + 3,
      idempotencyKeys: PRUNE_DELETE_BATCH_SIZE + 3,
      searchLog: PRUNE_DELETE_BATCH_SIZE + 3,
      boardViews: PRUNE_DELETE_BATCH_SIZE + 3,
    });
  });

  it("stops at the per-table batch cap and pages once for the pass", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const callCounts = { n: 0 };
      const endless = {
        async pruneOlderThan(_cutoff: Date): Promise<number> {
          callCounts.n++;
          return PRUNE_DELETE_BATCH_SIZE;
        },
      };
      const stores = {
        agentEventAudits: endless,
        accessLog: endless,
        joinAttempts: endless,
        idempotencyKeys: endless,
        searchLog: endless,
        boardViews: endless,
        sessions: createMemorySessionStore(() => now.getTime()),
      };
      const counts = await pruneModelTables(stores, now);
      const perTable = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;
      expect(counts).toMatchObject({
        agentEventAudits: perTable,
        accessLog: perTable,
        joinAttempts: perTable,
        idempotencyKeys: perTable,
        searchLog: perTable,
        boardViews: perTable,
      });
      // Each of the six tables stopped after exactly the max batches.
      expect(callCounts.n).toBe(6 * PRUNE_DELETE_MAX_BATCHES);
      // The capped pass pages once for the whole pass instead of warning.
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const raw = error.mock.calls[0]![0];
      expect(typeof raw).toBe("string");
      expect(raw as string).not.toContain("\n");
      const line = JSON.parse(raw as string) as Record<string, unknown>;
      expect(Object.keys(line).sort()).toEqual([
        "build_sha",
        "error_class",
        "event",
        "exception",
        "job",
        "level",
        "release",
      ]);
      expect(line).toMatchObject({
        level: "critical",
        event: "scheduled.failing",
        job: "model:prune",
      });
      expect(line.error_class).toBe(line.exception);
      expect(line.release).toBe(line.build_sha);
      // The page line carries no table or count detail.
      expect(raw as string).not.toContain("agentEventAudits");
      expect(raw as string).not.toContain("cappedTables");
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });

  it("deletes only rows older than each cutoff; cutoff-exact rows survive", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const stores = memStores(now);
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    for (const t of Object.values(stores.tables)) t.at.push(old, edge, fresh);

    const counts = await pruneModelTables(stores, now);
    expect(counts).toMatchObject({
      agentEventAudits: 1,
      accessLog: 1,
      joinAttempts: 1,
      idempotencyKeys: 1,
      searchLog: 1,
      boardViews: 1,
    });
    for (const [name, t] of Object.entries(stores.tables)) {
      expect(t.at, name).toEqual([edge, fresh]);
      expect(t.cutoffs, name).toEqual([edge]);
    }
  });

  it("session sweep removes expired and exactly-now rows, keeps live ones", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const sessions = createMemorySessionStore(() => now.getTime());
    const row = (expiresAt: Date, tokenHash: string) => ({
      tokenHash,
      userId: "42",
      username: "r",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt,
    });
    await sessions.create(row(new Date(now.getTime() - 1000), "old"));
    await sessions.create(row(new Date(now.getTime()), "edge"));
    await sessions.create(row(new Date(now.getTime() + 3600_000), "live"));
    expect(await sessions.sweepExpired(now)).toBe(2);
    expect(await sessions.get("old")).toBeNull();
    expect(await sessions.get("edge")).toBeNull();
    expect(await sessions.get("live")).not.toBeNull();
  });

  it("re-run is a no-op (idempotent)", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const stores = memStores(now);
    for (const t of Object.values(stores.tables)) t.at.push(new Date(now.getTime() - 91 * DAY));
    const sessions = stores.sessions;
    await sessions.create({
      tokenHash: "gone",
      userId: "42",
      username: "r",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(now.getTime() - 1000),
    });
    await pruneModelTables(stores, now);
    expect(await pruneModelTables(stores, now)).toEqual({
      agentEventAudits: 0,
      accessLog: 0,
      joinAttempts: 0,
      idempotencyKeys: 0,
      searchLog: 0,
      boardViews: 0,
      sessions: 0,
    });
  });

  it("single-flight skip: the prune job does not run when the lock is held", async () => {
    const prune = vi.fn(async (_db: unknown) => {});
    const tx = {};
    expect(await runScheduled(PRUNE_CRON, async () => false, { reconcile: prune, prune })).toBe(
      false,
    );
    expect(prune).not.toHaveBeenCalled();
    // The flight hands the body its reserved transaction client; the body
    // must receive it (the max:1 deadlock fix pins work to that client).
    expect(
      await runScheduled(PRUNE_CRON, async (_name, fn) => (await fn(tx as never), true), {
        reconcile: prune,
        prune,
      }),
    ).toBe(true);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(tx);
  });
});

// The shared fixture validates testDatabaseUrl() before constructing a driver,
// pins credentials/port, and migrates only its owned schema (no public writes).
describe.skipIf(!process.env.DATABASE_URL)("model:prune (test Postgres)", () => {
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

  it("audit pruning skips only rows inside the worker/database clock-skew window", async () => {
    // Fixed 2160 hours, as the trigger guard is; '90 days' shifts by an hour across DST.
    await sql`insert into agent_event_audits (operation, request_id, result, created_at)
      values ('create', 'skew-old', 'ok', clock_timestamp() - interval '2160 hours' - interval '60 seconds'),
             ('create', 'skew-in-window', 'ok', clock_timestamp() - interval '2160 hours' + interval '60 seconds')`;

    try {
      const workerNow = new Date(Date.now() + 120_000);
      expect((await pruneModelTables(pgPruneStores(sql), workerNow)).agentEventAudits).toBe(1);
      const left = await sql<{ request_id: string }[]>`select request_id from agent_event_audits`;
      expect(left.map((r) => r.request_id)).toEqual(["skew-in-window"]);
    } finally {
      await clearAuditRows(sql, ["agent_event_audits"]);
    }
  });

  it("prunes each table by age, sweeps expired sessions, and re-runs clean", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);

    await sql`insert into agent_event_audits (operation, request_id, result, created_at)
      values ('create','old','ok',${old}),('create','edge','ok',${edge}),('create','fresh','ok',${fresh})`;
    await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('1','members','view','["2"]',1,${old}),('1','members','view','["2"]',1,${edge}),('1','members','view','["2"]',1,${fresh})`;
    await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      values ('added','site','r1','10',${old}),('added','site','r2','11',${edge}),('denied','site','r3','12',${fresh})`;
    const [grant] = await sql<
      { id: string }[]
    >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      values ('a','co','g',${`h-${fixture!.schemaName}`}) returning id`;
    await sql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
      values (${grant!.id},'k-old','d',200,'{}',${old}),(${grant!.id},'k-edge','d',200,'{}',${edge}),(${grant!.id},'k-fresh','d',200,'{}',${fresh})`;
    await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('old q',3,${old}),('edge q',1,${edge}),('fresh q',0,${fresh})`;
    await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
      values ('hotzones','overall','all',3,${old}),('hotzones','overall','all',1,${edge}),('hotzones','overall','all',0,${fresh})`;
    await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values ('gone','1','a',true,false,${new Date(now.getTime() - 1000)}),
             ('edge','2','b',true,false,${now}),
             ('live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;

    const counts = await pruneModelTables(pgPruneStores(sql), now);
    expect(counts).toEqual({
      agentEventAudits: 1,
      accessLog: 1,
      joinAttempts: 1,
      idempotencyKeys: 1,
      searchLog: 1,
      boardViews: 1,
      sessions: 2,
    });

    // Audit cutoff-exact rows survive; newer rows remain untouched.
    const audits = await sql<
      { request_id: string }[]
    >`select request_id from agent_event_audits where request_id in ('old', 'edge', 'fresh') order by id`;
    expect(audits.map((r) => r.request_id)).toEqual(["edge", "fresh"]);

    // Survivors: cutoff-exact age rows stay; only expired sessions are gone.
    const access = await sql<
      { occurred_at: Date }[]
    >`select occurred_at from member_data_access_logs order by id`;
    expect(access.map((r) => r.occurred_at.getTime())).toEqual([edge.getTime(), fresh.getTime()]);
    const joins = await sql<
      { request_id: string }[]
    >`select request_id from join_attempts order by id`;
    expect(joins.map((r) => r.request_id)).toEqual(["r2", "r3"]);
    const keys = await sql<
      { key: string }[]
    >`select key from agent_event_idempotency_keys order by id`;
    expect(keys.map((r) => r.key)).toEqual(["k-edge", "k-fresh"]);
    const searches = await sql<
      { normalized_query: string }[]
    >`select normalized_query from event_search_logs order by id`;
    expect(searches.map((r) => r.normalized_query)).toEqual(["edge q", "fresh q"]);
    const boardViews = await sql<
      { result_count: number }[]
    >`select result_count from board_view_logs order by id`;
    expect(boardViews.map((r) => r.result_count)).toEqual([1, 0]);
    const sessions = await sql<{ token_hash: string }[]>`select token_hash from web_sessions`;
    expect(sessions.map((r) => r.token_hash)).toEqual(["live"]);

    expect(await pruneModelTables(pgPruneStores(sql), now)).toEqual({
      agentEventAudits: 0,
      accessLog: 0,
      joinAttempts: 0,
      idempotencyKeys: 0,
      searchLog: 0,
      boardViews: 0,
      sessions: 0,
    });
  });

  it("each age-pruned statement is batch-bounded; one pass drains the backlog", async () => {
    // More expired rows than one batch per table; markers carry a `cap-`
    // prefix so the earlier test's leftover edge/fresh rows stay out of the
    // survivor assertions (the shared fixture drops its schema on dispose).
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    const extra = PRUNE_DELETE_BATCH_SIZE + 3;

    await sql`insert into agent_event_audits (operation, request_id, result, created_at)
      select 'create', 'cap-' || g, 'ok', ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into agent_event_audits (operation, request_id, result, created_at)
      values ('create','cap-edge','ok',${edge}),('create','cap-fresh','ok',${fresh})`;
    await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      select '1','members','view','["2"]',1, ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('1','members','view','["2"]',1,${edge}),('1','members','view','["2"]',1,${fresh})`;
    await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      select 'added','site','cap-r' || g,'10', ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      values ('added','site','cap-r-edge','11',${edge}),('denied','site','cap-r-fresh','12',${fresh})`;
    const [grant] = await sql<
      { id: string }[]
    >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      values ('a','co','g',${`cap-h-${fixture!.schemaName}`}) returning id`;
    await sql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
      select ${grant!.id}, 'cap-k' || g, 'd', 200, '{}', ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
      values (${grant!.id},'cap-k-edge','d',200,'{}',${edge}),(${grant!.id},'cap-k-fresh','d',200,'{}',${fresh})`;
    await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
      select 'cap q ' || g, 0, ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
      select 'hotzones', 'overall', 'all', 0, ${old} from generate_series(1, ${extra}) g`;
    await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('cap q edge',1,${edge}),('cap q fresh',0,${fresh})`;
    await sql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
      values ('hotzones','overall','all',1,${edge}),('hotzones','overall','all',0,${fresh})`;

    // Each table holds `extra` expired rows of its own (91 days old: past
    // both the 90-day cutoff and the audit database-clock guard by a full day,
    // so no clock skew can flip them), plus the earlier test's edge/fresh
    // leftovers. Expired backlog per table is therefore above one batch.
    // One pass drains the whole backlog: each statement stays batch-bounded
    // while the pass repeats until a short batch. No per-pass total exceeds
    // the batch cap (batches × size); global totals are not asserted because
    // the earlier test's leftover edge rows sit exactly on the audit
    // clock-guard boundary and can flip eligibility between statements — the
    // marker-scoped checks below are the exact drain proof instead.
    const first = await pruneModelTables(pgPruneStores(sql), now);
    const perPassCap = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;
    for (const [name, n] of Object.entries(first)) {
      expect(n, `single pass ${name}`).toBeLessThanOrEqual(name === "sessions" ? 0 : perPassCap);
    }
    expect(first.agentEventAudits).toBeGreaterThanOrEqual(extra);
    expect(first.accessLog).toBeGreaterThanOrEqual(extra);
    expect(first.joinAttempts).toBeGreaterThanOrEqual(extra);
    expect(first.idempotencyKeys).toBeGreaterThanOrEqual(extra);
    expect(first.searchLog).toBeGreaterThanOrEqual(extra);
    expect(first.boardViews).toBeGreaterThanOrEqual(extra);

    // A re-run is clean: the backlog drained in the single pass above.
    expect(await pruneModelTables(pgPruneStores(sql), now)).toEqual({
      agentEventAudits: 0,
      accessLog: 0,
      joinAttempts: 0,
      idempotencyKeys: 0,
      searchLog: 0,
      boardViews: 0,
      sessions: 0,
    });

    // Every expired `cap-` row is gone; only the cutoff-exact and fresh
    // markers remain, so the reported counts were exact, not estimates.
    const gone = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    expect(
      await gone(
        sql`select count(*)::int as n from agent_event_audits
          where request_id like 'cap-%' and request_id not in ('cap-edge', 'cap-fresh')`,
      ),
    ).toBe(0);
    expect(
      await gone(
        sql`select count(*)::int as n from join_attempts
          where request_id like 'cap-r%' and request_id not in ('cap-r-edge', 'cap-r-fresh')`,
      ),
    ).toBe(0);
    expect(
      await gone(
        sql`select count(*)::int as n from agent_event_idempotency_keys
          where key like 'cap-k%' and key not in ('cap-k-edge', 'cap-k-fresh')`,
      ),
    ).toBe(0);
    expect(
      await gone(
        sql`select count(*)::int as n from event_search_logs
          where normalized_query like 'cap q%' and normalized_query not in ('cap q edge', 'cap q fresh')`,
      ),
    ).toBe(0);
    expect(
      await gone(sql`select count(*)::int as n from board_view_logs where occurred_at < ${old}`),
    ).toBe(0);
    // Access logs carry no text marker; every row this test inserted at `old`
    // (91 days, a full day past cutoff and guard) is gone. The earlier test's
    // leftovers are newer than `old`, so they cannot match.
    expect(
      await gone(
        sql`select count(*)::int as n from member_data_access_logs where occurred_at < ${old}`,
      ),
    ).toBe(0);

    // Cutoff-exact rows survive, newer rows remain.
    const audits = await sql<
      { request_id: string }[]
    >`select request_id from agent_event_audits where request_id like 'cap-%' order by id`;
    expect(audits.map((r) => r.request_id)).toEqual(["cap-edge", "cap-fresh"]);
    const joins = await sql<
      { request_id: string }[]
    >`select request_id from join_attempts where request_id like 'cap-r%' order by id`;
    expect(joins.map((r) => r.request_id)).toEqual(["cap-r-edge", "cap-r-fresh"]);
    const keys = await sql<
      { key: string }[]
    >`select key from agent_event_idempotency_keys where key like 'cap-k%' order by id`;
    expect(keys.map((r) => r.key)).toEqual(["cap-k-edge", "cap-k-fresh"]);
    const searches = await sql<
      { normalized_query: string }[]
    >`select normalized_query from event_search_logs where normalized_query like 'cap q%' order by id`;
    expect(searches.map((r) => r.normalized_query)).toEqual(["cap q edge", "cap q fresh"]);
  });

  it("each age-pruned statement obeys its per-statement batch bound", async () => {
    // Per-statement oracle: the shared batch test above proves the draining
    // pass clears a backlog, but an unbounded statement would also pass it.
    // This test calls each adapter's pruneOlderThan directly on an isolated
    // schema: 1,003 eligible old rows plus cutoff-exact/fresh markers must
    // report 1,000, then 3, then 0, with exact survivors after each call.
    const iso = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(iso.client as unknown as Parameters<typeof migrate>[0]);
      const psql = iso.client;
      const stores = pgPruneStores(psql);
      // Fixed cutoff for every direct call: edge markers sit exactly on it
      // (`< cutoff` is false, so they survive even as the database clock
      // advances past them). Old rows are 91 days back, a full day past both
      // the cutoff and the audit database-clock guard, so no skew can flip
      // eligibility mid-test.
      const now = new Date();
      const cutoff = new Date(now.getTime() - 90 * DAY);
      const old = new Date(now.getTime() - 91 * DAY);
      const edge = new Date(cutoff.getTime());
      const fresh = new Date(now.getTime() - DAY);
      const extra = PRUNE_DELETE_BATCH_SIZE + 3;

      await psql`insert into agent_event_audits (operation, request_id, result, created_at)
        select 'create', 'per-audit-' || g, 'ok', ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into agent_event_audits (operation, request_id, result, created_at)
        values ('create','per-audit-edge','ok',${edge}),('create','per-audit-fresh','ok',${fresh})`;
      await psql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
        select 'per-access-old','members','view','["2"]',1, ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
        values ('per-access-edge','members','view','["2"]',1,${edge}),('per-access-fresh','members','view','["2"]',1,${fresh})`;
      await psql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        select 'added','site','per-join-' || g,'10', ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        values ('added','site','per-join-edge','11',${edge}),('denied','site','per-join-fresh','12',${fresh})`;
      const [grant] = await psql<
        { id: string }[]
      >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        values ('a','co','g',${`per-h-${iso.schemaName}`}) returning id`;
      await psql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
        select ${grant!.id}, 'per-key-' || g, 'd', 200, '{}', ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
        values (${grant!.id},'per-key-edge','d',200,'{}',${edge}),(${grant!.id},'per-key-fresh','d',200,'{}',${fresh})`;
      await psql`insert into event_search_logs (normalized_query, result_count, occurred_at)
        select 'per-search-' || g, 0, ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into event_search_logs (normalized_query, result_count, occurred_at)
        values ('per-search edge',1,${edge}),('per-search fresh',0,${fresh})`;
      await psql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
        select 'per-board', 'overall', 'all', 0, ${old} from generate_series(1, ${extra}) g`;
      await psql`insert into board_view_logs (normalized_board_key, scope, season, result_count, occurred_at)
        values ('per-board-edge','overall','all',1,${edge}),('per-board-fresh','overall','all',0,${fresh})`;

      const remaining = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

      // agentEventAudits.
      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from agent_event_audits
            where request_id like 'per-audit-%' and request_id not in ('per-audit-edge', 'per-audit-fresh')`,
        ),
      ).toBe(3);
      expect(
        (
          await psql<
            { request_id: string }[]
          >`select request_id from agent_event_audits where request_id in ('per-audit-edge', 'per-audit-fresh') order by id`
        ).map((r) => r.request_id),
      ).toEqual(["per-audit-edge", "per-audit-fresh"]);
      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from agent_event_audits
            where request_id like 'per-audit-%' and request_id not in ('per-audit-edge', 'per-audit-fresh')`,
        ),
      ).toBe(0);
      expect(await stores.agentEventAudits.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { request_id: string }[]
          >`select request_id from agent_event_audits where request_id like 'per-audit-%' order by id`
        ).map((r) => r.request_id),
      ).toEqual(["per-audit-edge", "per-audit-fresh"]);

      // accessLog.
      expect(await stores.accessLog.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from member_data_access_logs where viewer_discord_id = 'per-access-old'`,
        ),
      ).toBe(3);
      expect(
        (
          await psql<
            { viewer_discord_id: string }[]
          >`select viewer_discord_id from member_data_access_logs where viewer_discord_id in ('per-access-edge', 'per-access-fresh') order by id`
        ).map((r) => r.viewer_discord_id),
      ).toEqual(["per-access-edge", "per-access-fresh"]);
      expect(await stores.accessLog.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from member_data_access_logs where viewer_discord_id = 'per-access-old'`,
        ),
      ).toBe(0);
      expect(await stores.accessLog.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { viewer_discord_id: string }[]
          >`select viewer_discord_id from member_data_access_logs order by id`
        ).map((r) => r.viewer_discord_id),
      ).toEqual(["per-access-edge", "per-access-fresh"]);

      // joinAttempts.
      expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from join_attempts
            where request_id like 'per-join-%' and request_id not in ('per-join-edge', 'per-join-fresh')`,
        ),
      ).toBe(3);
      expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from join_attempts
            where request_id like 'per-join-%' and request_id not in ('per-join-edge', 'per-join-fresh')`,
        ),
      ).toBe(0);
      expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { request_id: string }[]
          >`select request_id from join_attempts where request_id like 'per-join-%' order by id`
        ).map((r) => r.request_id),
      ).toEqual(["per-join-edge", "per-join-fresh"]);

      // idempotencyKeys.
      expect(await stores.idempotencyKeys.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from agent_event_idempotency_keys
            where key like 'per-key-%' and key not in ('per-key-edge', 'per-key-fresh')`,
        ),
      ).toBe(3);
      expect(await stores.idempotencyKeys.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from agent_event_idempotency_keys
            where key like 'per-key-%' and key not in ('per-key-edge', 'per-key-fresh')`,
        ),
      ).toBe(0);
      expect(await stores.idempotencyKeys.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { key: string }[]
          >`select key from agent_event_idempotency_keys where key like 'per-key-%' order by id`
        ).map((r) => r.key),
      ).toEqual(["per-key-edge", "per-key-fresh"]);

      // searchLog.
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from event_search_logs
            where normalized_query like 'per-search-%' and normalized_query not in ('per-search edge', 'per-search fresh')`,
        ),
      ).toBe(3);
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from event_search_logs
            where normalized_query like 'per-search-%' and normalized_query not in ('per-search edge', 'per-search fresh')`,
        ),
      ).toBe(0);
      expect(await stores.searchLog.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { normalized_query: string }[]
          >`select normalized_query from event_search_logs where normalized_query like 'per-search%' order by id`
        ).map((r) => r.normalized_query),
      ).toEqual(["per-search edge", "per-search fresh"]);

      // boardViews.
      expect(await stores.boardViews.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(
        await remaining(
          psql`select count(*)::int as n from board_view_logs where normalized_board_key = 'per-board'`,
        ),
      ).toBe(3);
      expect(await stores.boardViews.pruneOlderThan(cutoff)).toBe(3);
      expect(
        await remaining(
          psql`select count(*)::int as n from board_view_logs where normalized_board_key = 'per-board'`,
        ),
      ).toBe(0);
      expect(await stores.boardViews.pruneOlderThan(cutoff)).toBe(0);
      expect(
        (
          await psql<
            { normalized_board_key: string }[]
          >`select normalized_board_key from board_view_logs order by id`
        ).map((r) => r.normalized_board_key),
      ).toEqual(["per-board-edge", "per-board-fresh"]);
    } finally {
      await iso.dispose();
    }
  });
});
