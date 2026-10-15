// Member-data retention ledger pins (L7 first slice).
// Publishes docs/retention-ledger.md rows and pins each row's mechanism:
// constants (read-only) plus prune coverage. Changes no policy and no
// prune behavior; it fails when a window, mechanism, or proof drifts.
//
// Must not duplicate test/prune.test.ts or edit src/jobs/constants.ts:
// constants are imported read-only here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backoffFor,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  SYNC_EVENT,
} from "../src/jobs/constants";
import { checkJoinThrottle, THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { discardFailedJob } from "../src/jobs/redrive";
import type { PruneStores } from "../src/jobs/types";
import { createMemorySessionStore, SESSION_TTL_SECONDS } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const DAY = 86_400_000;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Whole-statement delete windows: slice from each `delete from <table>`
// match to the closing backtick of its SQL template literal, so a
// multi-line prune (delete ... in ( + newline + select ... created_at < ...)
// is judged as one statement instead of one line.
function deleteWindows(body: string, table: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`delete\\s+from\\s+${table}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const close = body.indexOf("`", m.index);
    out.push(body.slice(m.index, close === -1 ? m.index + 600 : close));
  }
  return out;
}

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

describe("retention ledger constants (read-only)", () => {
  it("pins the member-data windows", () => {
    expect(MEMBER_ACCESS_LOG_RETENTION_DAYS).toBe(90);
    expect(JOIN_ATTEMPT_RETENTION_DAYS).toBe(90);
    expect(THROTTLE_COUNTER_RETENTION_MINUTES).toBe(5);
    expect(SESSION_TTL_SECONDS).toBe(60 * 120);
  });

  it("pins the queue retry and lock-TTL constants", () => {
    expect(SYNC_EVENT.uniqueForSeconds).toBe(300);
    expect(SYNC_EVENT.tries).toBe(6);
    expect(SYNC_EVENT.backoffSeconds).toEqual([10, 60, 300, 900, 3600]);
    expect(SYNC_EVENT.debounceSeconds).toBe(10);
    // The retry gap holds at the last value past the budget.
    expect(backoffFor(SYNC_EVENT.backoffSeconds, 99)).toBe(3600);
  });
});

describe("retention ledger doc rows", () => {
  it("publishes one row per member-data table with window, mechanism, and proof", () => {
    const doc = read("docs/retention-ledger.md");
    for (const table of [
      "member_data_access_logs",
      "activity_log",
      "web_throttle_hits",
      "web_sessions",
      "join_attempts",
    ]) {
      expect(doc, `ledger must row ${table}`).toContain(table);
    }
    expect(doc).toContain("MEMBER_ACCESS_LOG_RETENTION_DAYS");
    expect(doc).toContain("JOIN_ATTEMPT_RETENTION_DAYS");
    expect(doc).toContain("THROTTLE_COUNTER_RETENTION_MINUTES");
    expect(doc).toContain("sweepExpired");
    expect(doc).toContain("SESSION_TTL_SECONDS");
    expect(doc).toContain("2160 hours");
    expect(doc).toContain("member-erasure.md#what-is-retained-and-why");
    expect(doc).toContain("src/jobs/cron.ts");
    expect(doc).toContain("src/events/rsvp.ts:208-212");
    expect(doc).toContain("Retain indefinitely per CISO decision");
    // The cited line range must actually hold the prune: shifting rsvp.ts
    // without re-basing the citation fails here instead of going stale.
    // Pinned per-line so a one-line shift already breaks (line 208 must open
    // pruneThrottle, line 210 must hold the delete).
    const rsvpLines = read("src/events/rsvp.ts").split("\n");
    expect(rsvpLines[207]).toContain("pruneThrottle");
    expect(rsvpLines[209]).toContain("delete from web_throttle_hits");
  });

  it("publishes one row per queue/lock table with window, mechanism, and proof", () => {
    const doc = read("docs/retention-ledger.md");
    for (const table of ["queue_jobs", "queue_failed_jobs", "job_unique_locks"]) {
      expect(doc, `ledger must row ${table}`).toContain(table);
    }
    expect(doc).toContain("No age prune by design");
    expect(doc).toContain("No sweep");
    expect(doc).toContain("pgQueueLedger");
    expect(doc).toContain("library-only");
    expect(doc).toContain("discardFailedJob");
    expect(doc).toContain("listFailedJobs");
    expect(doc).toContain("queue-redrive-runbook.md");
    expect(doc).toContain("uniqueForSeconds = 300");
    expect(doc).toContain("pgUniqueLock");
    expect(doc).toContain("src/jobs/consumer.ts");
    expect(doc).toContain("src/jobs/sync-event.ts");
    // Accurate bounds: orphans outlive message lifetime; TTL bounds lease
    // validity, not row lifetime.
    expect(doc).not.toContain("settles every message");
    expect(doc).toContain("orphaned rows");
    expect(doc).toContain("reviewed operator correction");
    expect(doc).toContain("runbook.md#queue-containment-drain-and-failed-job-replay");
    expect(doc).toContain("until the next acquire of the same key");
    expect(doc).toContain("unbounded for keys never re-dispatched");
  });
});

describe("retention ledger mechanisms (memory, no DB)", () => {
  it("pruneModelTables age-prunes access logs and join attempts at the 90-day cutoff", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const tables = {
      agentEventAudits: memTable(),
      accessLog: memTable(),
      joinAttempts: memTable(),
      idempotencyKeys: memTable(),
      searchLog: memTable(),
      boardViews: memTable(),
    };
    const stores = {
      ...tables,
      sessions: createMemorySessionStore(() => now.getTime()),
    } satisfies PruneStores;
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    tables.accessLog.at.push(old, edge, fresh);
    tables.joinAttempts.at.push(old, edge, fresh);

    const counts = await pruneModelTables(stores, now);

    expect(counts.accessLog).toBe(1);
    expect(counts.joinAttempts).toBe(1);
    expect(tables.accessLog.at).toEqual([edge, fresh]);
    expect(tables.joinAttempts.at).toEqual([edge, fresh]);
    expect(tables.accessLog.cutoffs).toEqual([edge]);
    expect(tables.joinAttempts.cutoffs).toEqual([edge]);
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

  it("pins the throttle rolling prune to the 5-minute shared constant", () => {
    const rsvp = read("src/events/rsvp.ts");
    expect(rsvp).toContain("async function pruneThrottle");
    // Full predicate: a 500-minute window or a flipped `at >` stops matching.
    expect(rsvp).toContain(
      "where at < clock_timestamp() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES})",
    );
    const service = read("src/join/service.ts");
    expect(service).toContain("THROTTLE_COUNTER_RETENTION_MINUTES = 5");
    expect(service).toContain(
      "DELETE FROM web_throttle_hits WHERE at < now() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES})",
    );
    const doc = read("docs/member-erasure.md");
    expect(doc).toContain("THROTTLE_COUNTER_RETENTION_MINUTES = 5");
  });

  it("pins the activity_log retain decision: docs claim it, no prune code exists", () => {
    const docs = read("docs/member-erasure.md");
    expect(docs).toContain("activity_log");
    expect(docs).toContain("retained indefinitely per CISO decision");
    expect(docs).toContain("No job prunes it");
    // Repo-wide: any `delete from activity_log` / `truncate ... activity_log`
    // under src/ fails, so a new prune file cannot slip past a two-file scan.
    // Inserts (`insert into activity_log`) are allowed and do not match.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      const body = readFileSync(file, "utf8");
      if (/delete\s+from\s+activity_log/i.test(body) || /truncate\s+.*activity_log/i.test(body)) {
        offenders.push(file);
      }
    }
    expect(offenders, `no src file may prune activity_log: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("retention ledger queue mechanisms (no DB)", () => {
  it("queue_jobs has no age-based delete: every delete is a job_id lifecycle transition", () => {
    // The decided behavior is no-sweep: an age predicate on queue_jobs would
    // undercount live depth. dequeued/failed settle by job_id instead.
    const postgresTs = read("src/jobs/postgres.ts");
    expect(postgresTs).toContain("No sweep");
    // postgres.ts holds exactly the two lifecycle deletes, both the exact
    // job_id form — a third delete (age prune or otherwise) fails here.
    const pgWindows = deleteWindows(postgresTs, "queue_jobs");
    expect(pgWindows.length).toBe(2);
    for (const w of pgWindows)
      expect(w, `lifecycle delete must be job_id-scoped: ${w.trim().slice(0, 120)}`).toMatch(
        /where\s+job_id\s*=\s*\$\{jobId\}::uuid/,
      );
    // Repo-wide whole-statement scan: an age predicate anywhere in the
    // statement fails, even when the repo's batched-prune idiom puts it on
    // the select line below the delete.
    const ageDeletes: string[] = [];
    const nonJobIdDeletes: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      const body = readFileSync(file, "utf8");
      for (const w of deleteWindows(body, "queue_jobs")) {
        if (/<\s*\$\{|<\s*cutoff|interval|created_at\s*<|available_at\s*<|failed_at\s*</i.test(w))
          ageDeletes.push(`${file}: ${w.split("\n")[0]!.trim()}`);
        if (!/job_id/i.test(w)) nonJobIdDeletes.push(`${file}: ${w.split("\n")[0]!.trim()}`);
      }
    }
    expect(ageDeletes, `no age-based delete on queue_jobs`).toEqual([]);
    expect(nonJobIdDeletes, `every queue_jobs delete is job_id-scoped`).toEqual([]);
    const consumer = read("src/jobs/consumer.ts");
    expect(consumer).toContain("deps.ledger.dequeued(jobId)");
    expect(consumer).toContain("deps.ledger.failed(jobId, body.kind, key,");
  });

  it("queue_failed_jobs leaves only through the one-row library discard", () => {
    const redrive = read("src/jobs/redrive.ts");
    expect(redrive).toContain("delete from queue_failed_jobs where id = ${failureId}");
    // redrive.ts holds exactly that one-row delete — a bulk drain added
    // there fails here instead of slipping past a file skip.
    const redriveWindows = deleteWindows(redrive, "queue_failed_jobs");
    expect(redriveWindows.length).toBe(1);
    expect(redriveWindows[0]).toMatch(/where\s+id\s*=\s*\$\{failureId\}/);
    // Repo-wide: only redrive.ts may delete a dead-letter row, so no
    // operational route can drain history. Redispatch leaves the row alone.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      if (file.endsWith("src/jobs/redrive.ts")) continue;
      const body = readFileSync(file, "utf8");
      if (deleteWindows(body, "queue_failed_jobs").length > 0) offenders.push(file);
    }
    expect(
      offenders,
      `only redrive.ts may delete queue_failed_jobs: ${offenders.join(", ")}`,
    ).toEqual([]);
    const runbook = read("docs/queue-redrive-runbook.md");
    expect(runbook).toContain("never touched here");
    expect(runbook).toContain("only a later confirmed recovery discards");
    expect(runbook).toContain("library-only");
  });

  it("job_unique_locks are TTL leases with fenced release and no sweeper", () => {
    const postgresTs = read("src/jobs/postgres.ts");
    // Acquire wins only over expired rows; release compare-deletes by token.
    expect(postgresTs).toContain("where job_unique_locks.expires_at < clock_timestamp()");
    expect(postgresTs).toContain(
      "delete from job_unique_locks where key = ${key} and owner_token = ${leaseToken}::uuid",
    );
    // postgres.ts holds exactly the one fenced release — a sweeper or bulk
    // expiry added there fails here instead of slipping past a file skip.
    const pgWindows = deleteWindows(postgresTs, "job_unique_locks");
    expect(pgWindows.length).toBe(1);
    expect(pgWindows[0]).toMatch(
      /where\s+key\s*=\s*\$\{key\}\s+and\s+owner_token\s*=\s*\$\{leaseToken\}::uuid/,
    );
    // Repo-wide: the fenced release in postgres.ts is the only delete, so no
    // sweeper or bulk expiry can slip in unnoticed.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      if (file.endsWith("src/jobs/postgres.ts")) continue;
      const body = readFileSync(file, "utf8");
      if (deleteWindows(body, "job_unique_locks").length > 0) offenders.push(file);
    }
    expect(
      offenders,
      `only postgres.ts may delete job_unique_locks: ${offenders.join(", ")}`,
    ).toEqual([]);
    // Dispatch holds the lease for exactly the pinned TTL; the consumer says
    // stuck rows self-heal through that TTL instead of a cleanup job.
    const dispatch = read("src/jobs/sync-event.ts");
    expect(dispatch).toContain("lock.acquire(key, SYNC_EVENT.uniqueForSeconds)");
    const consumer = read("src/jobs/consumer.ts");
    expect(consumer).toContain("self-heals via its TTL");
  });
});

// Live round-trips use a guarded disposable schema on agent-testdb or the
// explicitly allowed GitHub CI Postgres service.
describe.skipIf(!process.env.DATABASE_URL)("retention ledger (test Postgres)", () => {
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

  it("prunes access logs and join attempts older than 90 days, keeps edge and fresh", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);

    await sql`insert into member_data_access_logs (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
      values ('1','members','view','["2"]',1,${old}),('1','members','view','["2"]',1,${edge}),('1','members','view','["2"]',1,${fresh})`;
    await sql`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      values ('added','site','ledger-r1','10',${old}),('added','site','ledger-r2','11',${edge}),('denied','site','ledger-r3','12',${fresh})`;

    const counts = await pruneModelTables(pgPruneStores(sql), now);
    expect(counts.accessLog).toBe(1);
    expect(counts.joinAttempts).toBe(1);

    const access = await sql<
      { occurred_at: Date }[]
    >`select occurred_at from member_data_access_logs order by id`;
    expect(access.map((r) => r.occurred_at.getTime())).toEqual([edge.getTime(), fresh.getTime()]);
    const joins = await sql<
      { request_id: string }[]
    >`select request_id from join_attempts where request_id in ('ledger-r1','ledger-r2','ledger-r3') order by id`;
    expect(joins.map((r) => r.request_id)).toEqual(["ledger-r2", "ledger-r3"]);
  });

  it("sweeps expired sessions and rolling-prunes throttle hits via the production join path", async () => {
    const now = new Date();
    await sql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values ('ledger-gone','1','a',true,false,${new Date(now.getTime() - 1000)}),
             ('ledger-live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;
    const bucket = "ledger-join-throttle";
    await sql`insert into web_throttle_hits (bucket, at)
      values (${bucket}, clock_timestamp() - make_interval(mins => 10)),
             (${bucket}, clock_timestamp())`;

    const counts = await pruneModelTables(pgPruneStores(sql), now);
    expect(counts.sessions).toBe(1);
    const sessions = await sql<
      { token_hash: string }[]
    >`select token_hash from web_sessions where token_hash in ('ledger-gone','ledger-live')`;
    expect(sessions.map((r) => r.token_hash)).toEqual(["ledger-live"]);

    // Production prune: judges and records first, then expires old rows. A
    // 5000-minute window or a no-op prune leaves 3 rows and fails here.
    const verdict = await checkJoinThrottle(
      sql as unknown as Parameters<typeof checkJoinThrottle>[0],
      bucket,
      10,
    );
    expect(verdict.limited).toBe(false);
    const hits = await sql<
      { at: Date }[]
    >`select at from web_throttle_hits where bucket = ${bucket} order by at`;
    expect(hits.length).toBe(2);
    const floor = Date.now() - THROTTLE_COUNTER_RETENTION_MINUTES * 60_000 - 60_000;
    for (const h of hits) expect(h.at.getTime()).toBeGreaterThan(floor);
  });

  it("queue ledger settles rows by lifecycle: dequeued removes, failed moves to the dead letter", async () => {
    const ledger = pgQueueLedger(sql);
    const tag = `ledger-${Date.now()}`;
    const done = crypto.randomUUID();
    const dead = crypto.randomUUID();
    const past = new Date(Date.now() - 1000);
    await ledger.enqueued({
      jobId: done,
      kind: "sync-event",
      key: `sync-event:${tag}`,
      availableAt: past,
    });
    await ledger.enqueued({
      jobId: dead,
      kind: "sync-event",
      key: `sync-event:${tag}`,
      availableAt: past,
    });

    await ledger.reserved(done);
    await ledger.released(done, new Date(Date.now() + 300_000));
    await ledger.dequeued(done);
    await ledger.failed(dead, "sync-event", `sync-event:${tag}`, "carrier exhausted");

    const live = await sql<
      { job_id: string }[]
    >`select job_id from queue_jobs where job_id in (${done}::uuid, ${dead}::uuid)`;
    expect(live).toEqual([]);
    const buried = await sql<
      { job_id: string; reason: string }[]
    >`select job_id, reason from queue_failed_jobs where job_id in (${done}::uuid, ${dead}::uuid)`;
    expect(buried.map((r) => r.job_id)).toEqual([dead]);
    expect(buried[0]!.reason).toContain("carrier exhausted");

    // Confirmed recovery discards exactly one dead-letter row.
    const failureId = (
      await sql<{ id: number }[]>`select id from queue_failed_jobs where job_id = ${dead}::uuid`
    )[0]!.id;
    expect(await discardFailedJob(sql, failureId)).toBe(true);
    expect(await discardFailedJob(sql, failureId)).toBe(false);
    const remaining = await sql<
      { job_id: string }[]
    >`select job_id from queue_failed_jobs where job_id = ${dead}::uuid`;
    expect(remaining).toEqual([]);
  });

  it("unique lock holds for its TTL, supersedes only expired leases, releases by token", async () => {
    const lock = pgUniqueLock(sql);
    const key = `ledger-lock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const first = await lock.acquire(key, SYNC_EVENT.uniqueForSeconds);
    expect(first).not.toBeNull();
    // Still held: a second holder loses.
    expect(await lock.acquire(key, SYNC_EVENT.uniqueForSeconds)).toBeNull();
    // A wrong token cannot release the holder's lease.
    await lock.release(key, crypto.randomUUID());
    expect(await lock.acquire(key, SYNC_EVENT.uniqueForSeconds)).toBeNull();
    await lock.release(key, first!);
    const second = await lock.acquire(key, SYNC_EVENT.uniqueForSeconds);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await lock.release(key, second!);

    // An expired lease is superseded on the next acquire (TTL self-heal).
    const staleKey = `ledger-lock-stale-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const stale = await lock.acquire(staleKey, -1);
    expect(stale).not.toBeNull();
    const heir = await lock.acquire(staleKey, SYNC_EVENT.uniqueForSeconds);
    expect(heir).not.toBeNull();
    expect(heir).not.toBe(stale);
    await lock.release(staleKey, heir!);
  });
});
