// Member-data retention ledger pins (L7 first slice).
// Publishes docs/retention-ledger.md rows and pins each row's mechanism:
// constants (read-only) plus prune coverage. Changes no policy and no
// prune behavior; it fails when a window, mechanism, or proof drifts.
//
// Must not duplicate test/prune.test.ts or edit src/jobs/constants.ts:
// constants are imported read-only here.
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardViewLogs, eventSyncAttempts } from "../src/db/admin-schema";
import {
  AGENT_EVENT_AUDIT_RETENTION_DAYS,
  backoffFor,
  BOARD_VIEW_LOG_RETENTION_DAYS,
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  IDEMPOTENCY_KEY_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  PRUNE_CRON,
  PRUNE_DELETE_BATCH_SIZE,
  PRUNE_DELETE_MAX_BATCHES,
  SYNC_EVENT,
} from "../src/jobs/constants";
import { checkJoinThrottle, THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { discardFailedJob } from "../src/jobs/redrive";
import type { PruneStores } from "../src/jobs/types";
import { OAUTH_JOURNEY_SWEEP_BATCH_SIZE, OAUTH_JOURNEY_TTL_SECONDS } from "../src/oauth-journeys";
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
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// Whole-statement mutation windows include raw SQL deletes/truncates, Drizzle
// sql-template deletes with an interpolated table object, and the Drizzle
// delete(table) form. Schema qualification, quoted identifiers and SQL
// comments must not turn a repo-wide retention pin into a token-only scan.
function deleteWindows(body: string, table: string): string[] {
  const out: string[] = [];
  const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\r\n]*(?:\r?\n|$))+`;
  const tableRef = String.raw`(?:(?:"?[a-z_][\w$]*"?)\s*\.\s*)?"?${table}"?`;
  const anyTableRef = String.raw`(?:(?:"?[a-z_][\w$]*"?)\s*\.\s*)?"?[a-z_][\w$]*"?`;
  const symbols: Record<string, string> = {
    activity_log: "activityLog",
    agent_event_audits: "agentEventAudits",
    agent_event_grants: "agentEventGrants",
    agent_event_hits: "agentEventHits",
    agent_event_idempotency_keys: "agentEventIdempotencyKeys",
    event_sync_attempts: "eventSyncAttempts",
    queue_jobs: "queueJobs",
    queue_failed_jobs: "queueFailedJobs",
    job_unique_locks: "jobUniqueLocks",
  };
  const symbol = symbols[table];
  // Build the symbol and alias set before the SQL pass so interpolated
  // `delete from ${table}` and `db.delete(alias)` spellings match.
  const tableNames = new Set<string>();
  if (symbol) {
    tableNames.add(symbol);
    let m: RegExpExecArray | null;
    const importedAliases = new RegExp(`\\b${symbol}\\s+as\\s+([\\w$]+)`, "g");
    while ((m = importedAliases.exec(body)) !== null) tableNames.add(m[1]!);
    // Destructured renames: const { queueJobs: jobs } = schema (or any RHS).
    const destructured = new RegExp(
      `(?:const|let|var)\\s*\\{[^}]*?\\b${symbol}\\s*:\\s*([\\w$]+)`,
      "g",
    );
    while ((m = destructured.exec(body)) !== null) tableNames.add(m[1]!);
    let foundAlias = true;
    while (foundAlias) {
      foundAlias = false;
      const names = [...tableNames].join("|");
      const assignedAliases = new RegExp(
        `\\b(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:[\\w$]+\\s*\\.\\s*)?(?:${names})\\b`,
        "g",
      );
      while ((m = assignedAliases.exec(body)) !== null) {
        if (!tableNames.has(m[1]!)) {
          tableNames.add(m[1]!);
          foundAlias = true;
        }
      }
    }
  }
  const sqlRe = new RegExp(
    `(?:delete${gap}from${gap}(?:only${gap})?${tableRef}|truncate${gap}(?:table${gap})?(?:only${gap})?(?:${anyTableRef}(?:${gap})?,(?:${gap})?)*${tableRef})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = sqlRe.exec(body)) !== null) {
    const close = body.indexOf("`", m.index);
    out.push(body.slice(m.index, close === -1 ? m.index + 600 : close));
  }
  if (symbol) {
    const names = [...tableNames].join("|");
    // Drizzle sql-template with an interpolated table object:
    // sql`delete from ${queueJobs} ...`, sql`delete from ${schema.queueJobs} ...`,
    // and the same through a destructured/import alias. The repo already
    // interpolates schema refs into sql templates (src/hotzones/aggregates.ts).
    const ourInterp = String.raw`\$\{\s*(?:[\w$]+\s*\.\s*)*(?:${names})\s*\}`;
    const anyInterp = String.raw`\$\{\s*(?:[\w$]+\s*\.\s*)*[a-z_][\w$]*\s*\}`;
    const interpDeleteRe = new RegExp(
      String.raw`delete${gap}from${gap}(?:only${gap})?${ourInterp}`,
      "gi",
    );
    while ((m = interpDeleteRe.exec(body)) !== null) {
      const close = body.indexOf("`", m.index);
      out.push(body.slice(m.index, close === -1 ? m.index + 600 : close));
    }
    const interpTruncateRe = new RegExp(
      String.raw`truncate${gap}(?:table${gap})?(?:only${gap})?(?:(?:${anyTableRef}|${anyInterp})(?:${gap})?,(?:${gap})?)*${ourInterp}`,
      "gi",
    );
    while ((m = interpTruncateRe.exec(body)) !== null) {
      const close = body.indexOf("`", m.index);
      out.push(body.slice(m.index, close === -1 ? m.index + 600 : close));
    }
    const ormRe = new RegExp(
      `\\.\\s*delete\\s*\\(\\s*(?:[\\w$]+\\s*\\.\\s*)?(?:${names})\\s*\\)`,
      "g",
    );
    while ((m = ormRe.exec(body)) !== null) out.push(m[0]);
  }
  return out;
}

// Flags a module that writes sync-attempt rows: raw SQL inserts/updates of
// event_sync_attempts, or the Drizzle table-object form
// db.insert(eventSyncAttempts)/db.update(eventSyncAttempts), optionally
// schema-qualified. Selects (reads) never match, and deletes are the
// deleteWindows scanner's job, not this one.
function writesSyncAttempts(body: string): boolean {
  if (
    body.includes("insert into event_sync_attempts") ||
    body.includes("update event_sync_attempts")
  )
    return true;
  return /\.\s*(?:insert|update)\s*\(\s*(?:[\w$]+\s*\.\s*)*eventSyncAttempts\b/.test(body);
}

function normalizeSqlWindow(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
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
    expect(doc).toContain("src/events/rsvp.ts:321-325");
    expect(doc).toContain("Retain indefinitely per CISO decision");
    // The cited line range must actually hold the prune: shifting rsvp.ts
    // without re-basing the citation fails here instead of going stale.
    // Pinned per-line so a one-line shift already breaks (line 321 must open
    // pruneThrottle, line 323 must hold the delete).
    const rsvpLines = read("src/events/rsvp.ts").split("\n");
    expect(rsvpLines[320]).toContain("pruneThrottle");
    expect(rsvpLines[322]).toContain("delete from web_throttle_hits");
  });

  it("distinguishes the throttle age cutoff from path-dependent physical cleanup", () => {
    const row = read("docs/retention-ledger.md")
      .split("\n")
      .find((line) => line.startsWith("| `web_throttle_hits` |"));
    expect(row).toBeDefined();
    expect(row).toMatch(/five minutes is an age cutoff, not a deletion timer/i);
    expect(row).toMatch(/cleanup is lazy and path-dependent/i);
    expect(row).toMatch(/expired rows can linger on a quiet site/i);
    expect(row).toMatch(/until a later request that runs cleanup/i);
    expect(row).toMatch(/after every verdict, admitted or refused/i);
    expect(row).not.toMatch(/do not run it/i);
    expect(row).not.toMatch(/(?:next|every|any) counted request(?: anywhere)?/i);
  });

  it("publishes the event-search table, access paths, and established prune window", () => {
    const doc = read("docs/retention-ledger.md");
    expect(EVENT_SEARCH_LOG_RETENTION_DAYS).toBe(90);
    for (const claim of [
      "`event_search_logs` (`public`, Drizzle `eventSearchLogs`)",
      "EVENT_SEARCH_LOG_RETENTION_DAYS = 90",
      "occurred_at < cutoff",
      "1,000",
      "100 batches per table per pass",
      "recordSearch",
      "bin/import/content-funnel.mjs",
      "topZeroResultSearches",
      "src/admin/routes.tsx",
      "src/db/read-classification.ts",
    ]) {
      expect(doc, `ledger must pin event-search claim: ${claim}`).toContain(claim);
    }
    expect(read("src/jobs/postgres.ts")).toContain(
      "select id from event_search_logs where occurred_at < ${cutoff}",
    );
    expect(read("src/jobs/cron.ts")).toContain(
      "drainPruneTable(\n      (c) => stores.searchLog.pruneOlderThan(c),\n      cutoff(now, EVENT_SEARCH_LOG_RETENTION_DAYS),",
    );
  });

  it("publishes the anonymous board-view lifecycle in its own row", () => {
    expect(BOARD_VIEW_LOG_RETENTION_DAYS).toBe(90);
    expect(PRUNE_CRON).toBe("0 0 * * *");
    expect(PRUNE_DELETE_BATCH_SIZE).toBe(1000);
    expect(PRUNE_DELETE_MAX_BATCHES).toBe(100);
    const fields = Object.values(getTableColumns(boardViewLogs)).map((column) => column.name);
    expect(fields).toEqual([
      "id",
      "normalized_board_key",
      "scope",
      "season",
      "result_count",
      "occurred_at",
    ]);
    const rows = read("docs/retention-ledger.md")
      .split("\n")
      .filter((line) => /^\| `board_view_logs`(?:\s|\|)/.test(line));
    expect(rows, "one dedicated board-view row, not the event-search row").toHaveLength(1);
    const row = rows[0]!;
    for (const claim of [
      "BOARD_VIEW_LOG_RETENTION_DAYS = 90",
      "90-day eligibility, not a deletion deadline",
      "Anonymous usage fields",
      ...fields.map((field) => `\`${field}\``),
      "no user ID, session, Discord ID, IP, or username",
      "Hono (`src/hotzones/routes.tsx`, `src/leaderboards/routes.tsx`)",
      "Kit (`src/kit-hotzones.ts`, `web/src/hooks.server.ts`)",
      "best-effort `recordBoardView`",
      "anonymous describes the record, not necessarily the visitor",
      "Member-board recording follows a released HTTP 200",
      "separate from fail-closed `member_data_access_logs` auditing",
      "Daily `model:prune`",
      'PRUNE_CRON = "0 0 * * *"',
      "pruneModelTables",
      "drainPruneTable",
      "pgPruneStores().boardViews.pruneOlderThan",
      "occurred_at < cutoff",
      "cutoff-exact and newer rows survive",
      "at most 1,000 rows (`PRUNE_DELETE_BATCH_SIZE = 1000`)",
      "up to 100 batches per table per pass (`PRUNE_DELETE_MAX_BATCHES = 100`)",
      "full final batch pages once via `scheduled.failing@model:prune`",
      "older rows may remain until a later pass",
      "../src/db/admin-schema.ts",
      "../src/hotzones/board-log.ts",
      "../src/jobs/constants.ts",
      "../src/jobs/cron.ts",
      "../src/jobs/worker.ts",
      "../src/jobs/postgres.ts",
      "../test/prune.test.ts",
    ]) {
      expect(row, `board-view row must pin: ${claim}`).toContain(claim);
    }
  });

  it("pins the board-view writer and scheduled prune paths without duplicating prune proofs", () => {
    for (const [path, call] of [
      ["src/hotzones/routes.tsx", "await recordBoardView(db, {"],
      ["src/leaderboards/routes.tsx", "await recordBoardView(db, entry).catch(() => {});"],
      ["src/kit-hotzones.ts", "await (args.recordBoardViewFn ?? recordBoardView)(db, opts)"],
      [
        "web/src/hooks.server.ts",
        "recordQueuedBoardView(event.locals, response.status, recordBoardView)",
      ],
      ["src/hotzones/board-log.ts", "await tx.insert(boardViewLogs).values({"],
      ["src/hotzones/board-log.ts", "if (!queued || status !== 200) return;"],
      ["src/leaderboards/routes.tsx", "if (!view || c.res.status !== 200) return;"],
      ["src/jobs/worker.ts", "jobUniqueLocks: pgPruneStores(dispatchClient).jobUniqueLocks"],
      ["src/jobs/worker.ts", "...pgPruneStores(db),"],
      // The cap page fires only after the flight commits: the scheduled
      // prune reports the cap without paging inside the transaction, and the
      // handler pages post-commit so a commit failure cannot leave a cap page
      // muting the real failure page.
      ["src/jobs/worker.ts", "reportCap: (capped) => {"],
      ["src/jobs/worker.ts", 'alertScheduledFailing("model:prune", new PruneBatchCapError())'],
    ] as const) {
      expect(read(path), `board-view call path: ${path}`).toContain(call);
    }
    const cron = read("src/jobs/cron.ts");
    expect(cron).toContain(
      'if (cron === PRUNE_CRON) return flight("model:prune", async (db) => void (await jobs.prune(db)));',
    );
    expect(cron).toContain(
      "drainPruneTable(\n      (c) => stores.boardViews.pruneOlderThan(c),\n      cutoff(now, BOARD_VIEW_LOG_RETENTION_DAYS),",
    );
    expect(cron).toContain('["boardViews", boardViews.capped]');
    expect(cron).toContain('alertScheduledFailing("model:prune", new PruneBatchCapError())');
    expect(normalizeSqlWindow(read("src/jobs/postgres.ts"))).toContain(
      "delete from board_view_logs where id in ( select id from board_view_logs where occurred_at < ${cutoff} order by id limit ${PRUNE_DELETE_BATCH_SIZE} for update skip locked ) returning 1",
    );
    const proof = read("test/prune.test.ts");
    for (const name of [
      "prunes each table by age, sweeps expired sessions, and re-runs clean",
      "drains a multi-batch backlog in one pass and sums the counts",
      "stops at the per-table batch cap and pages once for the pass",
      "each age-pruned statement obeys its per-statement batch bound",
    ]) {
      expect(proof, `existing prune proof: ${name}`).toContain(`it("${name}"`);
    }
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
    // validity, the daily sweep bounds row lifetime.
    expect(doc).not.toContain("settles every message");
    expect(doc).toContain("orphaned rows");
    expect(doc).toContain("reviewed operator correction");
    expect(doc).toContain("runbook.md#queue-containment-drain-and-failed-job-replay");
    expect(doc).toContain("pgPruneStores().jobUniqueLocks.sweepExpired(now)");
    expect(doc).toContain("expires_at <= now");
    expect(doc).toContain("live leases stay");
    expect(doc).toContain("`jobUniqueLocks` in `cappedTables`");
    expect(doc).toContain("src/jobs/cron.ts");
    expect(doc).not.toContain("until the next acquire of the same key");
    expect(doc).not.toContain("unbounded for keys never re-dispatched");
    expect(doc).not.toContain("(no sweeper)");
  });

  it("publishes the sync-attempt lifecycle: writers, readers, and no age prune", () => {
    const fields = Object.values(getTableColumns(eventSyncAttempts)).map((column) => column.name);
    expect(fields).toEqual([
      "idempotency_key",
      "event_id",
      "revision",
      "action",
      "payload",
      "mirrored_at",
      "state",
      "request_attempts",
      "next_attempt_at",
    ]);
    const rows = read("docs/retention-ledger.md")
      .split("\n")
      .filter((line) => /^\| `event_sync_attempts`(?:\s|\|)/.test(line));
    expect(rows, "one dedicated sync-attempt row").toHaveLength(1);
    const row = rows[0]!;
    for (const claim of [
      "`event_sync_attempts` (`public`, Drizzle `eventSyncAttempts`)",
      "No age window in code",
      "retained indefinitely",
      "late redelivery cannot replay edits",
      "ON DELETE cascade",
      "no app path deletes events",
      "Sole writer is `pgEventStore`",
      "`prepareSync`",
      "`claimSync`",
      "`deferSync`",
      "`completeSync`",
      "`failSync`",
      "`event_sync_attempts_pending_idx`",
      "`obsolete`",
      "`needsSync`",
      "`pendingSync`",
      "`hasFailedSync`",
      "`stale_keys`",
      "`failed_sync`",
      "`pending_sync`",
      "No prune store exists",
      "`PruneStores`",
      "`pruneModelTables`",
      "six age-pruned tables plus the session and lock sweeps",
      "no retention-days constant names sync attempts",
      "only in test fixtures as cleanup",
      "../drizzle/1020_event-sync-revisions.sql",
      "../src/db/admin-schema.ts",
      "../src/jobs/events.ts",
      "../src/jobs/cron.ts",
      "../src/jobs/postgres.ts",
      "../src/admin/source-evidence.ts",
      "runbook.md#queue-containment-drain-and-failed-job-replay",
    ]) {
      expect(row, `sync-attempt row must pin: ${claim}`).toContain(claim);
    }
    const scope = read("docs/retention-ledger.md")
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(scope.some((line) => line.includes("`event_sync_attempts`"))).toBe(true);
    expect(read("docs/retention-ledger.md")).not.toContain("documented in a later slice");
  });

  it("publishes the web_oauth_journeys row: 10-minute TTL with bounded request-path sweep", () => {
    expect(OAUTH_JOURNEY_TTL_SECONDS).toBe(600);
    expect(OAUTH_JOURNEY_SWEEP_BATCH_SIZE).toBe(1000);
    const lines = read("docs/retention-ledger.md").split("\n");
    const rows = lines.filter((line) => /^\| `web_oauth_journeys`(?:\s|\|)/.test(line));
    expect(rows, "one dedicated web_oauth_journeys row").toHaveLength(1);
    // The row must render inside the GFM table: no blank line may sit between
    // table rows, or the row drops out as a literal pipe paragraph.
    const idx = lines.findIndex((line) => /^\| `web_oauth_journeys`(?:\s|\|)/.test(line));
    expect(idx).toBeGreaterThan(0);
    expect(lines[idx - 1]!.trim()).not.toBe("");
    expect(lines[idx - 1]!.startsWith("| ")).toBe(true);
    const row = rows[0]!;
    for (const claim of [
      "`web_oauth_journeys`",
      "10-minute TTL",
      "OAUTH_JOURNEY_TTL_SECONDS = 600",
      "issue()` sets `expires_at = now() + 600 seconds`",
      "10 minutes is an age cutoff, not a deletion timer",
      "Cleanup is lazy and path-dependent",
      "expired rows can linger on a quiet site",
      "until a later auth or join start",
      "never deletes on consume",
      "No daily prune",
      "pruneModelTables",
      "GET /auth/discord",
      "GET /join/discord",
      "sweepExpired",
      "inline before `issue()`",
      "OAUTH_JOURNEY_SWEEP_BATCH_SIZE = 1000",
      "for update skip locked",
      "expires_at <= now()",
      "across repeated starts",
      "src/oauth-journeys.ts",
      "drizzle/1022_web-sessions-oauth-journeys.sql",
      "src/db/schema.ts",
      "src/auth/routes.ts",
      "src/join/route-start.ts",
    ]) {
      expect(row, `journey row must pin: ${claim}`).toContain(claim);
    }
    // The proof cites the whole journey module, not a line range that goes
    // stale when lines above the store shift.
    expect(row).not.toContain("src/oauth-journeys.ts:6-13");
    // Mechanism pins: the bounded sweep lives in the journey store, the
    // request paths run it inline, and the daily prune never mentions it.
    const journeys = read("src/oauth-journeys.ts");
    expect(journeys).toContain("OAUTH_JOURNEY_TTL_SECONDS = 600");
    expect(journeys).toContain("OAUTH_JOURNEY_SWEEP_BATCH_SIZE = 1000");
    expect(normalizeSqlWindow(journeys)).toContain(
      "delete from web_oauth_journeys where state_hash in ( select state_hash from web_oauth_journeys where expires_at <= now() order by expires_at, state_hash limit ${OAUTH_JOURNEY_SWEEP_BATCH_SIZE} for update skip locked ) returning state_hash",
    );
    // The issue window is part of the documented mechanism too: expiry comes
    // from the TTL constant, never a literal.
    expect(normalizeSqlWindow(journeys)).toContain(
      "insert into web_oauth_journeys (state_hash, flow, expires_at) values (${stateHash}, ${flow}, now() + ${OAUTH_JOURNEY_TTL_SECONDS} * interval '1 second')",
    );
    expect(read("drizzle/1022_web-sessions-oauth-journeys.sql")).toContain(
      'CREATE TABLE IF NOT EXISTS "web_oauth_journeys"',
    );
    // Both starts sweep inline before issue() inside their own start handler:
    // a swap that still contains both strings must fail here.
    for (const [path, route, flow] of [
      ["src/auth/routes.ts", 'app.get("/auth/discord"', "auth"],
      ["src/join/route-start.ts", 'app.get("/join/discord"', "join"],
    ] as const) {
      const body = read(path);
      const start = body.indexOf(route);
      expect(start, `${path} start route`).toBeGreaterThanOrEqual(0);
      const nextRoute = body.indexOf('app.get("', start + route.length);
      const slice = nextRoute === -1 ? body.slice(start) : body.slice(start, nextRoute);
      const sweep = slice.indexOf("await store.journeys.sweepExpired();");
      const issue = slice.indexOf(`await store.journeys.issue(await hashToken(state), "${flow}")`);
      expect(sweep, `${path} sweeps in the start handler`).toBeGreaterThanOrEqual(0);
      expect(issue, `${path} issues in the start handler`).toBeGreaterThanOrEqual(0);
      expect(sweep, `${path} sweeps before issuing`).toBeLessThan(issue);
    }
    expect(read("src/jobs/cron.ts")).not.toContain("web_oauth_journeys");
    expect(read("src/jobs/postgres.ts")).not.toContain("web_oauth_journeys");
    // Negative control: an invented row name pins nothing.
    const invented = read("docs/retention-ledger.md")
      .split("\n")
      .filter((line) => /^\| `web_oauth_journeys_invented`(?:\s|\|)/.test(line));
    expect(invented, "invented journey row must fail the pin").toHaveLength(0);
  });
});

describe("retention ledger agent-event rows (L8a)", () => {
  it("pins the agent-event prune windows (read-only)", () => {
    expect(AGENT_EVENT_AUDIT_RETENTION_DAYS).toBe(90);
    expect(IDEMPOTENCY_KEY_RETENTION_DAYS).toBe(90);
  });

  it("publishes one row per agent-event table with window, mechanism, and proof", () => {
    const doc = read("docs/retention-ledger.md");
    for (const table of [
      "agent_events",
      "agent_event_grants",
      "agent_event_hits",
      "agent_event_audits",
      "agent_event_idempotency_keys",
    ]) {
      expect(doc, `ledger must row ${table}`).toContain(table);
    }
    const rows = doc.split("\n").filter((line) => line.startsWith("| `agent_"));
    expect(rows, "one dedicated row per agent-event table").toHaveLength(5);
    // Contiguity: no blank line may separate the agent rows from the
    // board_view_logs row — a blank line ends the GFM table and the rows
    // would render as raw pipe text outside it.
    const lines = doc.split("\n");
    const boardIdx = lines.findIndex((line) => line.startsWith("| `board_view_logs`"));
    expect(boardIdx, "board_view_logs row precedes the agent rows").toBeGreaterThanOrEqual(0);
    expect(lines.slice(boardIdx + 1, boardIdx + 6)).toEqual(rows);
    for (const claim of [
      "AGENT_EVENT_AUDIT_RETENTION_DAYS = 90",
      "IDEMPOTENCY_KEY_RETENTION_DAYS = 90",
      "No prune by design",
      "never by deletion",
      "5-minute rolling",
      "60-second budget",
      "no named constant",
      "retired by `drizzle/1019_shared-agent-events.sql`",
      'DROP TABLE "agent_events"',
      "no `agentEvents` export",
      "ON DELETE cascade",
      "ON DELETE SET NULL",
      "append-only trigger (`drizzle/1018`)",
      "2160 hours",
      "cutoff-exact rows survive",
      "at most 1,000 rows",
      "up to 100 batches per pass",
      "checkGrant",
      "grant_expired",
      "grant_disabled",
      "src/agent-events/grants.ts",
      "src/agent-events/shield.ts",
      "src/agent-events/rate-limit.ts",
      "src/agent-events/audit.ts",
      "bin/import/audit.mjs",
      "../drizzle/0001_agent-events.sql",
      "../drizzle/1008_agent-event-idempotency-prune-idx.sql",
      "../drizzle/1019_shared-agent-events.sql",
      "../drizzle/1023_agent-event-audits-prune-idx.sql",
      "../src/db/schema.ts",
      "../src/jobs/cron.ts",
      "../src/jobs/postgres.ts",
    ]) {
      expect(doc, `agent-event ledger must pin: ${claim}`).toContain(claim);
    }
  });

  it("states each agent-event window without inventing a deletion deadline", () => {
    const line = (prefix: string): string => {
      const row = read("docs/retention-ledger.md")
        .split("\n")
        .find((l) => l.startsWith(prefix));
      expect(row, `ledger must row ${prefix}`).toBeDefined();
      return row!;
    };
    // Retired table: no window at all, surviving rows live on as events rows.
    expect(line("| `agent_events` ")).toMatch(/no longer exists/i);
    expect(line("| `agent_events` ")).toMatch(/live on as `events` rows/i);
    // Grants are credentials: expiry/disability rejects admission, deletes nothing.
    expect(line("| `agent_event_grants`")).toMatch(/retain indefinitely/i);
    expect(line("| `agent_event_grants`")).toMatch(/no app path deletes a grant/i);
    // A grant with audit history cannot be deleted: the 1018 append-only
    // trigger refuses the ON DELETE SET NULL rewrite; the cascade only
    // applies when no audits remain.
    expect(line("| `agent_event_grants`")).toMatch(/while any.*audit.*refuses the deletion/i);
    expect(line("| `agent_event_grants`")).toMatch(
      /only a grant with no remaining audits could cascade/i,
    );
    expect(line("| `agent_event_grants`")).toContain("bin/import/audit.mjs");
    // Hits mirror the throttle row: the cutoff is an age, not a timer.
    expect(line("| `agent_event_hits`")).toMatch(/an age cutoff, not a deletion timer/i);
    expect(line("| `agent_event_hits`")).toMatch(/linger on a quiet ingress until a later pass/i);
    // Age-pruned pair: cutoff-exact rows survive both.
    expect(line("| `agent_event_audits`")).toMatch(/cutoff-exact rows survive/i);
    expect(line("| `agent_event_idempotency_keys`")).toMatch(/cutoff-exact rows survive/i);
    expect(line("| `agent_event_idempotency_keys`")).toMatch(/never deleted by the request path/i);
    // Runtime writer plus the legacy import writer — never a sole-writer claim.
    expect(line("| `agent_event_audits`")).toMatch(/runtime writer/i);
    expect(line("| `agent_event_audits`")).toContain("bin/import/audit.mjs");
    expect(line("| `agent_event_audits`")).not.toMatch(/sole writer/i);
    expect(line("| `agent_event_idempotency_keys`")).toContain("bin/import/audit.mjs");
  });

  it("negative control: an invented row fails the pin", () => {
    // Proves the row-presence pins above are not vacuous: a table that was
    // never published must have no row and no mention.
    const doc = read("docs/retention-ledger.md");
    for (const invented of ["agent_event_merkle_roots", "agent_event_receipts"]) {
      expect(doc, `invented table must stay unpublished: ${invented}`).not.toContain(invented);
      const rows = doc.split("\n").filter((line) => line.startsWith(`| \`${invented}\``));
      expect(rows, `invented table must have no row: ${invented}`).toHaveLength(0);
    }
  });

  it("pruneModelTables age-prunes agent audits and idempotency keys at the 90-day cutoff", async () => {
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
      jobUniqueLocks: {
        async sweepExpired(_now: Date): Promise<number> {
          return 0;
        },
      },
    } satisfies PruneStores;
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    tables.agentEventAudits.at.push(old, edge, fresh);
    tables.idempotencyKeys.at.push(old, edge, fresh);

    const counts = await pruneModelTables(stores, now);

    expect(counts.agentEventAudits).toBe(1);
    expect(counts.idempotencyKeys).toBe(1);
    expect(tables.agentEventAudits.at).toEqual([edge, fresh]);
    expect(tables.idempotencyKeys.at).toEqual([edge, fresh]);
    expect(tables.agentEventAudits.cutoffs).toEqual([edge, edge]);
    expect(tables.idempotencyKeys.cutoffs).toEqual([edge, edge]);
  });

  it("pins the agent audit and idempotency prune wiring without duplicating prune proofs", () => {
    const cron = read("src/jobs/cron.ts");
    expect(cron).toContain("(c) => stores.agentEventAudits.pruneOlderThan(c),");
    expect(cron).toContain("cutoff(now, AGENT_EVENT_AUDIT_RETENTION_DAYS),");
    expect(cron).toContain("(c) => stores.idempotencyKeys.pruneOlderThan(c),");
    expect(cron).toContain("cutoff(now, IDEMPOTENCY_KEY_RETENTION_DAYS),");
    expect(cron).toContain('["agentEventAudits", agentEventAudits.capped]');
    expect(cron).toContain('["idempotencyKeys", idempotencyKeys.capped]');
    const pg = normalizeSqlWindow(read("src/jobs/postgres.ts"));
    expect(pg).toContain(
      "delete from agent_event_audits where id in ( select id from agent_event_audits where created_at < ${cutoff} and created_at < clock_timestamp() - interval '2160 hours' order by id limit ${PRUNE_DELETE_BATCH_SIZE} for update skip locked ) returning 1",
    );
    expect(pg).toContain(
      "delete from agent_event_idempotency_keys where id in ( select id from agent_event_idempotency_keys where created_at < ${cutoff} order by id limit ${PRUNE_DELETE_BATCH_SIZE} for update skip locked ) returning 1",
    );
    // Sole audit writer is insert-only; dispatch reads the trail, postgres only prunes.
    expect(read("src/agent-events/audit.ts")).toContain("INSERT INTO agent_event_audits");
    // Repo-wide: only the prune store may delete audit or idempotency rows,
    // so the request path can never widen into a drain.
    for (const table of ["agent_event_audits", "agent_event_idempotency_keys"]) {
      const offenders = listTsFiles(join(root, "src")).filter((file) => {
        if (file.endsWith("src/jobs/postgres.ts")) return false;
        return deleteWindows(readFileSync(file, "utf8"), table).length > 0;
      });
      expect(offenders, `only postgres.ts may delete ${table}: ${offenders.join(", ")}`).toEqual(
        [],
      );
    }
    // Retired table: no Drizzle export, dropped by 1019, content carried by events.
    expect(read("src/db/schema.ts")).not.toContain("agentEvents");
    expect(read("drizzle/1019_shared-agent-events.sql")).toContain('DROP TABLE "agent_events"');
    expect(read("drizzle/1019_shared-agent-events.sql")).toContain(
      'ALTER TABLE "events" ADD COLUMN "agent_grant_id"',
    );
    const proof = read("test/prune.test.ts");
    for (const name of [
      "deletes only rows older than each cutoff; cutoff-exact rows survive",
      "audit pruning skips only rows inside the worker/database clock-skew window",
    ]) {
      expect(proof, `existing prune proof: ${name}`).toContain(`it("${name}"`);
    }
  });

  it("agent grants have no prune: expiry enforced at admission, no src delete", () => {
    // Repo-wide: no src file may delete a grant row; expiry/disability
    // rejects admission instead (403), never deletes.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      const body = readFileSync(file, "utf8");
      if (deleteWindows(body, "agent_event_grants").length > 0) offenders.push(file);
    }
    expect(offenders, `no src file may delete agent_event_grants: ${offenders.join(", ")}`).toEqual(
      [],
    );
    const grants = read("src/agent-events/grants.ts");
    expect(grants).toContain("grant_expired");
    expect(grants).toContain("grant_disabled");
    expect(grants).toContain("expires_at_ms <= Date.now()");
    expect(read("src/db/schema.ts")).toContain('"agent_event_grants"');
    expect(read("drizzle/0001_agent-events.sql")).toContain('CREATE TABLE "agent_event_grants"');
  });

  it("agent hits prune lazily on the shield and rate-limit paths", () => {
    const window =
      "DELETE FROM agent_event_hits USING candidates WHERE agent_event_hits.id = candidates.id";
    // One bounded oldest-first statement per pass: shield runs it inside the
    // bucket lock on every pass; the limiter runs it after every verdict
    // (admitted, refused, and busy-503) outside the locks.
    expect(
      deleteWindows(read("src/agent-events/shield.ts"), "agent_event_hits").map(normalizeSqlWindow),
    ).toEqual([window]);
    expect(
      deleteWindows(read("src/agent-events/rate-limit.ts"), "agent_event_hits").map(
        normalizeSqlWindow,
      ),
    ).toEqual([window, window]);
    // Repo-wide: only those two modules may delete hit rows.
    const offenders = listTsFiles(join(root, "src")).filter((file) => {
      if (
        file.endsWith("src/agent-events/shield.ts") ||
        file.endsWith("src/agent-events/rate-limit.ts")
      )
        return false;
      return deleteWindows(readFileSync(file, "utf8"), "agent_event_hits").length > 0;
    });
    expect(
      offenders,
      `only shield/rate-limit may delete agent_event_hits: ${offenders.join(", ")}`,
    ).toEqual([]);
    // Full statement including the WITH candidates CTE that carries the age
    // and the bound: per-file presence is not enough — either limiter
    // statement drifting must turn the suite red (1 in shield, 2 in rate-limit).
    const full =
      "WITH candidates AS (SELECT id FROM agent_event_hits WHERE at < now() - interval '5 minutes' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) " +
      window;
    const fullCount = (path: string): number =>
      normalizeSqlWindow(read(path)).split(full).length - 1;
    expect(fullCount("src/agent-events/shield.ts")).toBe(1);
    expect(fullCount("src/agent-events/rate-limit.ts")).toBe(2);
    // Budget is the rows in the last 60 s; five minutes is the prune age.
    for (const path of ["src/agent-events/shield.ts", "src/agent-events/rate-limit.ts"]) {
      const body = read(path);
      expect(body, `${path} budget`).toContain("at > now() - interval '60 seconds'");
      expect(body, `${path} prune age`).toContain("at < now() - interval '5 minutes'");
      expect(body, `${path} bound`).toContain("ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED");
    }
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
      jobUniqueLocks: {
        async sweepExpired(_now: Date): Promise<number> {
          return 0;
        },
      },
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
    // Two calls each with the identical cutoff: the short first batch is not
    // drained proof (a SKIP LOCKED window can hide unvisited rows), so the
    // pass runs one empty proving batch before reporting uncapped.
    expect(tables.accessLog.cutoffs).toEqual([edge, edge]);
    expect(tables.joinAttempts.cutoffs).toEqual([edge, edge]);
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
      "WHERE at < now() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES})",
    );
    // Bounded oldest-first batch, off the admission path.
    expect(service).toContain("ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED");
    expect(service).toContain(
      "DELETE FROM web_throttle_hits USING (SELECT id FROM web_throttle_hits",
    );
    const doc = read("docs/member-erasure.md");
    expect(doc).toContain("THROTTLE_COUNTER_RETENTION_MINUTES = 5");
  });

  it("pins the activity_log retain decision: docs claim it, no prune code exists", () => {
    const docs = read("docs/member-erasure.md");
    expect(docs).toContain("activity_log");
    expect(docs).toContain("retained indefinitely per CISO decision");
    expect(docs).toContain("No job prunes it");
    // Repo-wide: raw SQL and Drizzle deletes/truncates are forbidden; inserts
    // remain allowed and do not match the mutation-window scanner.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      const body = readFileSync(file, "utf8");
      if (deleteWindows(body, "activity_log").length > 0) offenders.push(file);
    }
    expect(offenders, `no src file may prune activity_log: ${offenders.join(", ")}`).toEqual([]);
  });

  it("sync attempts have no age prune: no constant, no store, no src delete", () => {
    // No retention-days constant names sync attempts; every named window is 90 days elsewhere.
    expect(read("src/jobs/constants.ts")).not.toMatch(
      /sync.?attempt.*retention|retention.*sync.?attempt/i,
    );
    // The prune wiring never mentions the attempts table: six age-pruned
    // stores plus the session and lock sweeps, and sync attempts is not among them.
    expect(read("src/jobs/cron.ts")).not.toContain("event_sync_attempts");
    expect(read("src/jobs/postgres.ts")).not.toContain("event_sync_attempts");
    const pruned = [
      "agentEventAudits",
      "accessLog",
      "joinAttempts",
      "idempotencyKeys",
      "searchLog",
      "boardViews",
    ];
    for (const store of pruned) {
      expect(read("src/jobs/cron.ts"), `prune must still drain ${store}`).toContain(
        `(c) => stores.${store}.pruneOlderThan(c),`,
      );
    }
    expect(read("src/jobs/cron.ts")).toContain("(d) => stores.sessions.sweepExpired(d), now");
    expect(read("src/jobs/cron.ts")).toContain(
      "const locks = stores.jobUniqueLocks ?? { sweepExpired: async (_d: Date): Promise<number> => 0 };",
    );
    expect(read("src/jobs/cron.ts")).toContain("(d) => locks.sweepExpired(d), now");
    // Repo-wide: raw SQL deletes/truncates of the attempts table are forbidden
    // in src (test fixtures may delete for cleanup). Updates are lifecycle
    // transitions, not retention deletes, and stay allowed.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(root, "src"))) {
      const body = readFileSync(file, "utf8");
      if (deleteWindows(body, "event_sync_attempts").length > 0) offenders.push(file);
    }
    expect(
      offenders,
      `no src file may delete event_sync_attempts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("pins the sync-attempt writer, pending index, schema, and readers", () => {
    // Sole writer: only the event store inserts or updates attempt rows, in
    // raw SQL today or the Drizzle table-object form tomorrow.
    const writers = listTsFiles(join(root, "src")).filter((file) =>
      writesSyncAttempts(readFileSync(file, "utf8")),
    );
    expect(writers.map((file) => file.replace(root, "").replace(/^\/+/, ""))).toEqual([
      "src/jobs/events.ts",
    ]);
    const store = read("src/jobs/events.ts");
    expect(store).toContain("insert into event_sync_attempts");
    expect(store).toContain("update event_sync_attempts set state = 'succeeded'");
    expect(store).toContain("update event_sync_attempts set state = 'failed'");
    expect(store).toContain(
      "request_attempts = a.request_attempts + case when candidate.obsolete then 0 else 1 end",
    );
    expect(store).toContain("update event_sync_attempts set next_attempt_at = ${nextAttemptAt}");
    // One pending row per event: the partial unique index fences retries.
    expect(read("src/db/admin-schema.ts")).toContain(
      'uniqueIndex("event_sync_attempts_pending_idx")',
    );
    expect(read("drizzle/1020_event-sync-revisions.sql")).toContain(
      'CREATE TABLE "event_sync_attempts"',
    );
    expect(read("drizzle/1020_event-sync-revisions.sql")).toContain("ON DELETE cascade");
    // Readers: recovery/eligibility checks plus the admin evidence verifier.
    for (const probe of ["needsSync", "staleEventKeys", "pendingSync", "hasFailedSync"]) {
      expect(store, `event store must read via ${probe}`).toContain(probe);
    }
    const evidence = read("src/admin/source-evidence.ts");
    expect(evidence).toContain("from event_sync_attempts");
    expect(evidence).toContain('statement: "pending_sync"');
    expect(evidence).toContain('statement: "failed_sync"');
    expect(evidence).toContain('statement: "stale_keys"');
  });

  it("flags Drizzle table-object writes to sync attempts, not reads or deletes", () => {
    // A future db.insert(eventSyncAttempts)/db.update(eventSyncAttempts) in
    // any src module must join the sole-writer set above; reads and deletes
    // belong to the reader pins and the deleteWindows scanner instead.
    for (const body of [
      "await db.insert(eventSyncAttempts).values({ eventId })",
      "await db.insert(schema.eventSyncAttempts).values({ eventId })",
      "await db.update(eventSyncAttempts).set({ state: 'failed' })",
      "await sql`insert into event_sync_attempts (event_id) values (${id})`",
      "await sql`update event_sync_attempts set state = 'failed'`",
    ])
      expect(writesSyncAttempts(body), `writer: ${body}`).toBe(true);
    for (const body of [
      "await db.select().from(eventSyncAttempts)",
      "await sql`select 1 from event_sync_attempts where state = 'pending'`",
      "await db.delete(eventSyncAttempts)",
      "await db.insert(queueJobs).values(job)",
    ])
      expect(writesSyncAttempts(body), `not a writer: ${body}`).toBe(false);
  });
});

describe("retention ledger queue mechanisms (no DB)", () => {
  it("detects SQL and Drizzle delete variants in source scans", () => {
    const cases: [string, string][] = [
      ["DELETE /* c */ FROM ONLY public.queue_jobs WHERE created_at < cutoff", "queue_jobs"],
      ["TRUNCATE TABLE other_table, queue_jobs", "queue_jobs"],
      ['DELETE FROM "public"."queue_failed_jobs" WHERE failed_at < cutoff', "queue_failed_jobs"],
      ["db.delete(schema.jobUniqueLocks)", "job_unique_locks"],
      ["import { queueJobs as q } from './schema'; db.delete(q)", "queue_jobs"],
      ["const q = schema.queueJobs; const q2 = q; db.delete(q2)", "queue_jobs"],
      ["db.delete(activityLog)", "activity_log"],
      // Drizzle sql-template with an interpolated table object (late-novel).
      ["db.execute(sql`delete from ${queueJobs} where available_at < ${cutoff}`)", "queue_jobs"],
      [
        "db.execute(sql`delete from ${queueFailedJobs} where failed_at < ${cutoff}`)",
        "queue_failed_jobs",
      ],
      [
        "db.execute(sql`delete from ${jobUniqueLocks} where expires_at < now()`)",
        "job_unique_locks",
      ],
      [
        "db.execute(sql`delete from ${schema.queueJobs} where available_at < ${cutoff}`)",
        "queue_jobs",
      ],
      ["sql`truncate table ${queueJobs}`", "queue_jobs"],
      ["const { queueJobs: jobs } = schema; db.delete(jobs)", "queue_jobs"],
      ["const { queueJobs: jobs } = schema; const q2 = jobs; db.delete(q2)", "queue_jobs"],
      // Agent-event table-object deletes ride the same symbol mapping.
      ["db.delete(agentEventAudits)", "agent_event_audits"],
      ["import { agentEventGrants as g } from './schema'; db.delete(g)", "agent_event_grants"],
      ["const h = schema.agentEventHits; db.delete(h)", "agent_event_hits"],
      [
        "db.execute(sql`delete from ${agentEventIdempotencyKeys} where created_at < ${cutoff}`)",
        "agent_event_idempotency_keys",
      ],
      // Sync-attempt table-object deletes ride the same symbol mapping.
      ["db.delete(eventSyncAttempts)", "event_sync_attempts"],
      ["import { eventSyncAttempts as a } from './schema'; db.delete(a)", "event_sync_attempts"],
      ["const t = schema.eventSyncAttempts; db.delete(t)", "event_sync_attempts"],
      ["db.execute(sql`delete from ${eventSyncAttempts} where id = ${id}`)", "event_sync_attempts"],
      [
        "db.execute(sql`delete from ${schema.eventSyncAttempts} where id = ${id}`)",
        "event_sync_attempts",
      ],
    ];
    for (const [body, table] of cases)
      expect(deleteWindows(body, table), `${table}: ${body}`).not.toEqual([]);
    expect(deleteWindows("insert into activity_log values (1)", "activity_log")).toEqual([]);
    expect(deleteWindows("select * from queue_jobs", "queue_jobs")).toEqual([]);
    // Inserts are the writer path, not deletes: they must not trip the scanner.
    expect(
      deleteWindows(
        "await db.insert(eventSyncAttempts).values({ eventId })",
        "event_sync_attempts",
      ),
    ).toEqual([]);
  });

  it("pins the .tsx directory walk: listTsFiles covers route/page modules", () => {
    // src carries 60 .tsx route/page modules; a .ts-only walk would miss a
    // prune planted in one of them (e.g. src/admin/routes.tsx).
    const srcFiles = listTsFiles(join(root, "src"));
    expect(
      srcFiles.some((f) => f.endsWith(".tsx")),
      "src must contain .tsx files",
    ).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), "ledger-tsx-"));
    try {
      mkdirSync(join(tmp, "nested"), { recursive: true });
      writeFileSync(join(tmp, "nested", "page.ts"), "export const x = 1;\n");
      writeFileSync(
        join(tmp, "nested", "routes.tsx"),
        "await sql`delete from queue_jobs where available_at < ${cutoff}`\n",
      );
      const found = listTsFiles(tmp);
      expect(
        found.some((f) => f.endsWith("routes.tsx")),
        "walk must return nested .tsx",
      ).toBe(true);
      const evil = readFileSync(join(tmp, "nested", "routes.tsx"), "utf8");
      expect(deleteWindows(evil, "queue_jobs")).not.toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("queue_jobs has no age-based delete: every delete is a job_id lifecycle transition", () => {
    // The decided behavior is no-sweep: an age predicate on queue_jobs would
    // undercount live depth. dequeued/failed settle by job_id instead.
    const postgresTs = read("src/jobs/postgres.ts");
    expect(postgresTs).toContain("No sweep");
    // Pin both complete lifecycle statements. Exact whole-window comparisons
    // reject additional predicates, not just age-based ones.
    const pgWindows = deleteWindows(postgresTs, "queue_jobs");
    expect(pgWindows.map(normalizeSqlWindow).sort()).toEqual(
      [
        "delete from queue_jobs where job_id = ${jobId}::uuid",
        "delete from queue_jobs where job_id = ${jobId}::uuid",
      ].sort(),
    );
    const offenders = listTsFiles(join(root, "src")).filter((file) => {
      if (file.endsWith("src/jobs/postgres.ts")) return false;
      return deleteWindows(readFileSync(file, "utf8"), "queue_jobs").length > 0;
    });
    expect(offenders, `only postgres.ts may delete queue_jobs: ${offenders.join(", ")}`).toEqual(
      [],
    );
    const consumer = read("src/jobs/consumer.ts");
    expect(consumer).toContain("deps.ledger.dequeued(jobId)");
    expect(consumer).toContain("deps.ledger.failed(jobId, body.kind, key,");
  });

  it("queue_failed_jobs leaves only through the one-row library discard", () => {
    const redrive = read("src/jobs/redrive.ts");
    // Pin the complete one-row statement, including its return clause, so
    // adding a second predicate cannot widen the discard into a drain.
    const redriveWindows = deleteWindows(redrive, "queue_failed_jobs");
    expect(redriveWindows.map(normalizeSqlWindow)).toEqual([
      "delete from queue_failed_jobs where id = ${failureId} returning 1",
    ]);
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

  it("job_unique_locks are TTL leases with fenced release and an expiry sweep", () => {
    const postgresTs = read("src/jobs/postgres.ts");
    // Acquire wins only over expired rows; release compare-deletes by token.
    expect(postgresTs).toContain("where job_unique_locks.expires_at < clock_timestamp()");
    // Pin both complete statements: the daily expiry sweep plus the fenced
    // compare-delete. Appended predicates on the fenced delete would otherwise
    // turn it into a bulk sweep.
    const pgWindows = deleteWindows(postgresTs, "job_unique_locks");
    expect(pgWindows.map(normalizeSqlWindow)).toEqual([
      "delete from job_unique_locks where expires_at <= ${now} and expires_at <= clock_timestamp() and key in ( select key from job_unique_locks where expires_at <= ${now} and expires_at <= clock_timestamp() order by key limit ${PRUNE_DELETE_BATCH_SIZE} for update skip locked ) returning 1",
      "delete from job_unique_locks where key = ${key} and owner_token = ${leaseToken}::uuid",
    ]);
    // Repo-wide: postgres.ts is the sole delete site, not an exempt file.
    const offenders = listTsFiles(join(root, "src")).filter((file) => {
      if (file.endsWith("src/jobs/postgres.ts")) return false;
      return deleteWindows(readFileSync(file, "utf8"), "job_unique_locks").length > 0;
    });
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
