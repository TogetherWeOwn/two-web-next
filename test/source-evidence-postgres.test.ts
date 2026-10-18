// route-inventory: GET /admin/queue/source-evidence/:id
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEvidenceSelects } from "../src/admin/source-evidence";
import type { SourceReadReport } from "../src/jobs/events";
import { loadReplayCandidateWithSql } from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const sourceIdentity = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

describe.skipIf(!process.env.DATABASE_URL)("evidence-only source reads on disposable DB", () => {
  let fixture: JobsFixture;
  let sql: JobsFixture["client"];
  let failureId: number;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 2 });
    sql = fixture.client;
  });
  afterAll(async () => fixture?.dispose());

  beforeEach(async () => {
    await sql`delete from queue_failed_jobs`;
    await sql`delete from queue_jobs`;
    await sql`delete from event_sync_attempts`;
    await sql`delete from events`;
    await sql`insert into events (event_key, title, starts_at, ends_at, status, discord_event_id, synced_revision)
      values (${sourceIdentity}, 'Evidence fixture', now(), now() + interval '1 hour', 'published', 'mapped', 1)`;
    const [row] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${crypto.randomUUID()}::uuid, 'sync-event', ${`sync-event:${sourceIdentity}`}, 'private transport diagnostics') returning id`;
    failureId = Number(row!.id);
  });

  async function collect(id: number) {
    const reports: SourceReadReport[] = [];
    const candidate = await loadReplayCandidateWithSql(sql, id, STAGING_APP_URL, {
      onSourceRead: (report) => {
        reports.push(report);
      },
    });
    return { candidate, reports };
  }

  it("collects one fresh marker per executed SELECT on the clean-source path", async () => {
    const startedAt = Date.now();
    const { candidate, reports } = await collect(failureId);
    expect(candidate).not.toBeNull();
    expect(reports.map((report) => report.statement)).toEqual([
      "queue_failed_jobs_by_id",
      "events_by_key_exists",
      "stale_keys",
      "pending_sync",
      "failed_sync",
    ]);
    const selects = buildEvidenceSelects(reports, true, startedAt, Date.now());
    expect(selects).toHaveLength(5);
    expect(selects[0]).toMatchObject({
      index: 0,
      statement: "queue_failed_jobs_by_id",
      rowCount: 1,
    });
    expect(typeof selects[0]!.readAt).toBe("string");
    // The public advice shape still strips identity; evidence never carries it.
    expect(JSON.stringify(selects)).not.toContain("private transport diagnostics");
  });

  it("records the missing-source path with an empty events read", async () => {
    await sql`delete from events`;
    const startedAt = Date.now();
    const { candidate, reports } = await collect(failureId);
    expect(candidate?.preview.disposition.action).toBe("keep");
    expect(reports.map((report) => report.statement)).toEqual([
      "queue_failed_jobs_by_id",
      "events_by_key_exists",
    ]);
    const selects = buildEvidenceSelects(reports, true, startedAt, Date.now());
    expect(selects[1]).toMatchObject({
      statement: "events_by_key_exists",
      rowCount: 0,
      readAt: null,
    });
  });

  it("reports an unknown incident with a single empty failed-row read", async () => {
    const { candidate, reports } = await collect(1_000_000_007);
    expect(candidate).toBeNull();
    expect(reports).toEqual([{ statement: "queue_failed_jobs_by_id", rowCount: 0, readAt: null }]);
  });

  it("needsSync short-circuits the later reconciliation reads on a dirty source", async () => {
    await sql`update events set title = 'Dirty' where event_key = ${sourceIdentity}`;
    const { candidate, reports } = await collect(failureId);
    expect(candidate?.preview.disposition.action).toBe("replay");
    expect(reports.map((report) => report.statement)).toEqual([
      "queue_failed_jobs_by_id",
      "events_by_key_exists",
      "stale_keys",
      "pending_sync",
    ]);
  });

  it("leaves every table unchanged and writes no activity_log receipt", async () => {
    async function counts() {
      const [failedRow] = await sql`select count(*)::int as failed from queue_failed_jobs`;
      const [loggedRow] = await sql`select count(*)::int as logged from activity_log`;
      return {
        failed: Number((failedRow as unknown as { failed: number }).failed),
        logged: Number((loggedRow as unknown as { logged: number }).logged),
      };
    }
    const before = await counts();
    await collect(failureId);
    expect(await counts()).toEqual(before);
  });

  it("runs the snapshot in repeatable-read read-only posture", async () => {
    const seen: unknown[][] = [];
    const wrapped = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === "begin") {
          return (...args: unknown[]) => {
            seen.push(args);
            const begin = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => unknown;
            return Reflect.apply(begin, target, args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const candidate = await loadReplayCandidateWithSql(
      wrapped as postgres.Sql,
      failureId,
      STAGING_APP_URL,
    );
    expect(candidate).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("isolation level repeatable read read only");
  });

  it("the snapshot posture is database-enforced read-only", async () => {
    await expect(
      sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx`insert into queue_failed_jobs (job_id, kind, key, reason)
          values (${crypto.randomUUID()}::uuid, 'sync-event', 'sync-event:write-attempt', 'refused')`;
      }),
    ).rejects.toThrow();
  });
});
