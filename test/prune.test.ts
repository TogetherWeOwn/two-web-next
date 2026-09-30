/// <reference types="vite/client" />
// W13 model:prune (TOG-10100): daily retention sweep over JoinAttempt +
// AgentEventIdempotencyKey + EventSearchLog (90-day windows, legacy
// constants) plus the web_sessions expiry cleanup (no legacy equivalent).
// Runs inside the existing prune cron under the advisory-lock single-flight.
//
// Same layering as the other suites: memory fakes always run in CI; live
// round-trips run against agent-testdb in a throwaway schema and skip
// without DATABASE_URL. Never point this at anything but agent-testdb.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  IDEMPOTENCY_KEY_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  PRUNE_CRON,
} from "../src/jobs/constants";
import { pruneModelTables, runScheduled } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import agentEvents from "../drizzle/0001_agent-events.sql?raw";
import joinMigration from "../drizzle/1000_join-attempts-throttle.sql?raw";
import adminSlice from "../drizzle/1001_admin-slice.sql?raw";
import searchLogMigration from "../drizzle/1005_event-search-logs.sql?raw";

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
    accessLog: memTable(),
    joinAttempts: memTable(),
    idempotencyKeys: memTable(),
    searchLog: memTable(),
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
    expect(MEMBER_ACCESS_LOG_RETENTION_DAYS).toBe(90);
    expect(JOIN_ATTEMPT_RETENTION_DAYS).toBe(90);
    expect(IDEMPOTENCY_KEY_RETENTION_DAYS).toBe(90);
    expect(EVENT_SEARCH_LOG_RETENTION_DAYS).toBe(90);
  });

  it("deletes only rows older than each cutoff; cutoff-exact rows survive", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const stores = memStores(now);
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    for (const t of Object.values(stores.tables)) t.at.push(old, edge, fresh);

    const counts = await pruneModelTables(stores, now);
    expect(counts).toMatchObject({ accessLog: 1, joinAttempts: 1, idempotencyKeys: 1, searchLog: 1 });
    for (const [name, t] of Object.entries(stores.tables)) {
      expect(t.at, name).toEqual([edge, fresh]);
      expect(t.cutoffs, name).toEqual([edge]);
    }
  });

  it("session sweep removes expired and exactly-now rows, keeps live ones", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const sessions = createMemorySessionStore(() => now.getTime());
    const row = (expiresAt: Date, tokenHash: string) => ({
      tokenHash, userId: "42", username: "r", avatar: null, member: true, moderator: false, expiresAt,
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
      tokenHash: "gone", userId: "42", username: "r", avatar: null,
      member: true, moderator: false, expiresAt: new Date(now.getTime() - 1000),
    });
    await pruneModelTables(stores, now);
    expect(await pruneModelTables(stores, now)).toEqual({
      accessLog: 0, joinAttempts: 0, idempotencyKeys: 0, searchLog: 0, sessions: 0,
    });
  });

  it("single-flight skip: the prune job does not run when the lock is held", async () => {
    const prune = vi.fn(async (_db: unknown) => {});
    const tx = {};
    expect(await runScheduled(PRUNE_CRON, async () => false, { reconcile: prune, prune })).toBe(false);
    expect(prune).not.toHaveBeenCalled();
    // The flight hands the body its reserved transaction client; the body
    // must receive it (the max:1 deadlock fix pins work to that client).
    expect(await runScheduled(PRUNE_CRON, async (_name, fn) => (await fn(tx as never), true), { reconcile: prune, prune })).toBe(true);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(tx);
  });
});

// Live against agent-testdb in a throwaway schema. Skipped when DATABASE_URL is
// unset (CI has no test-DB access). Never point this at anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("model:prune (agent-testdb)", () => {
  const schemaName = `w13_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, connection: { search_path: schemaName }, onnotice: () => {} });
    // Canonical migration SQL is the source of truth. drizzle qualifies FK
    // targets with "public"; strip it so the throwaway schema owns them.
    const strip = (s: string) => s.replaceAll('"public".', "");
    for (const file of [agentEvents, joinMigration, adminSlice, searchLogMigration]) {
      for (const stmt of strip(file).split("--> statement-breakpoint")) {
        if (stmt.trim()) await sql.unsafe(stmt);
      }
    }
    const { migrate } = await import("../src/sessions");
    await migrate(sql as unknown as Parameters<typeof migrate>[0]);
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  it("prunes each table by age, sweeps expired sessions, and re-runs clean", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);

    await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('1','members','view','["2"]',1,${old}),('1','members','view','["2"]',1,${edge}),('1','members','view','["2"]',1,${fresh})`;
    await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      values ('added','site','r1','10',${old}),('added','site','r2','11',${edge}),('denied','site','r3','12',${fresh})`;
    const [grant] = await sql<{ id: string }[]>`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      values ('a','co','g',${`h-${schemaName}`}) returning id`;
    await sql`insert into agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, created_at)
      values (${grant!.id},'k-old','d',200,'{}',${old}),(${grant!.id},'k-edge','d',200,'{}',${edge}),(${grant!.id},'k-fresh','d',200,'{}',${fresh})`;
    await sql`insert into event_search_logs (normalized_query, result_count, occurred_at)
      values ('old q',3,${old}),('edge q',1,${edge}),('fresh q',0,${fresh})`;
    await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values ('gone','1','a',true,false,${new Date(now.getTime() - 1000)}),
             ('edge','2','b',true,false,${now}),
             ('live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;

    const counts = await pruneModelTables(pgPruneStores(sql), now);
    expect(counts).toEqual({ accessLog: 1, joinAttempts: 1, idempotencyKeys: 1, searchLog: 1, sessions: 2 });

    // Survivors: cutoff-exact age rows stay; only expired sessions are gone.
    const access = await sql<{ occurred_at: Date }[]>`select occurred_at from member_data_access_logs order by id`;
    expect(access.map((r) => r.occurred_at.getTime())).toEqual([edge.getTime(), fresh.getTime()]);
    const joins = await sql<{ request_id: string }[]>`select request_id from join_attempts order by id`;
    expect(joins.map((r) => r.request_id)).toEqual(["r2", "r3"]);
    const keys = await sql<{ key: string }[]>`select key from agent_event_idempotency_keys order by id`;
    expect(keys.map((r) => r.key)).toEqual(["k-edge", "k-fresh"]);
    const searches = await sql<{ normalized_query: string }[]>`select normalized_query from event_search_logs order by id`;
    expect(searches.map((r) => r.normalized_query)).toEqual(["edge q", "fresh q"]);
    const sessions = await sql<{ token_hash: string }[]>`select token_hash from web_sessions`;
    expect(sessions.map((r) => r.token_hash)).toEqual(["live"]);

    expect(await pruneModelTables(pgPruneStores(sql), now)).toEqual({
      accessLog: 0, joinAttempts: 0, idempotencyKeys: 0, searchLog: 0, sessions: 0,
    });
  });
});
