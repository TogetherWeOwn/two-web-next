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
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
} from "../src/jobs/constants";
import { checkJoinThrottle, THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
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
});
