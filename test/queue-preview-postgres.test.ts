import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordQueuePreviewAccess } from "../src/admin/queue-preview";
import type { Env } from "../src/env";
import * as eventStores from "../src/jobs/events";
import { previewFailedJobWithSql } from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return { ...actual, default: Object.assign(vi.fn(actual.default), actual.default) };
});

const sourceIdentity = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const realEventStore = eventStores.pgEventStore;

describe.skipIf(!process.env.DATABASE_URL)("read-only one-row preview SQL", () => {
  let fixture: JobsFixture;
  let sql: JobsFixture["client"];
  let failureId: number;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 2 });
    sql = fixture.client;
  });
  afterAll(async () => fixture?.dispose());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await sql`delete from queue_failed_jobs`;
    await sql`delete from queue_jobs`;
    await sql`delete from event_sync_attempts`;
    await sql`delete from events`;
    await sql`insert into events (event_key, title, starts_at, ends_at, status, discord_event_id, synced_revision)
      values (${sourceIdentity}, 'Preview fixture', now(), now() + interval '1 hour', 'published', 'mapped', 1)`;
    const [row] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${crypto.randomUUID()}::uuid, 'sync-event', ${`sync-event:${sourceIdentity}`}, 'private transport diagnostics') returning id`;
    failureId = Number(row!.id);
  });

  async function state() {
    return {
      failed: [...(await sql`select * from queue_failed_jobs order by id`)],
      live: [...(await sql`select * from queue_jobs order by job_id`)],
      locks: [...(await sql`select * from job_unique_locks order by key`)],
      events: [...(await sql`select * from events order by id`)],
      attempts: [...(await sql`select * from event_sync_attempts order by idempotency_key`)],
    };
  }

  async function expectPreview(action: string, reason: RegExp) {
    const before = await state();
    const preview = await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL);
    expect(preview).toMatchObject({
      failure: { id: failureId, kind: "sync-event" },
      disposition: { action },
    });
    expect(preview!.disposition.reason).toMatch(reason);
    expect(JSON.stringify(preview)).not.toContain("private transport diagnostics");
    expect(preview!.disposition).not.toHaveProperty("idempotencyKey");
    expect(await state()).toEqual(before);
  }

  async function pending() {
    await sql`update events set title = 'Dirty' where event_key = ${sourceIdentity}`;
    const attempt = await realEventStore(sql).prepareSync(
      sourceIdentity,
      crypto.randomUUID(),
      new Date(),
    );
    if (!attempt || "waiting" in attempt) throw new Error("fixture snapshot missing");
    return attempt;
  }

  it("the operational receipt persists only bounded metadata in the existing activity trail", async () => {
    const before = await state();
    const preview = await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL);
    const close = vi.fn().mockResolvedValue(undefined);
    // Borrow only our migrated fixture schema; resource ownership is tested separately.
    vi.mocked(postgres).mockReturnValueOnce(
      new Proxy(sql, {
        get(target, key, receiver) {
          return key === "end" ? close : Reflect.get(target, key, receiver);
        },
      }),
    );
    await recordQueuePreviewAccess(
      { DATABASE_URL: process.env.DATABASE_URL! } as Env,
      "100000000000000111",
      preview!,
    );
    const [receipt] = await sql`select * from activity_log where subject_id = ${String(failureId)}`;
    expect(receipt).toMatchObject({
      log_name: "operations",
      description: "queue.failed.preview",
      subject_type: "queue_failed_jobs",
      subject_id: String(failureId),
      causer_type: "User",
      causer_id: "100000000000000111",
      event: "view",
      properties: {
        disposition: { before: null, after: "discard-stale" },
        observedAt: { before: null, after: preview!.observedAt },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private transport diagnostics");
    expect(await state()).toEqual(before);
    expect(close).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it("clean source is a stale advice only; both ledger rows, locks and source stay unchanged", async () => {
    await sql`insert into queue_jobs (job_id, kind, key, available_at)
      values (${crypto.randomUUID()}::uuid, 'sync-event', 'another row', now())`;
    await expectPreview("discard-stale", /source.*clean/);
  });
  it("dirty source advises replay without preparing, dispatching or deleting anything", async () => {
    await sql`update events set title = 'Changed' where event_key = ${sourceIdentity}`;
    await expectPreview("replay", /fresh dispatch/);
  });
  it("current revision refusal keeps the dead letter", async () => {
    const attempt = await pending();
    await realEventStore(sql).failSync(attempt.idempotencyKey);
    await expectPreview("keep", /definitive refusal/);
  });
  it("a refusal of an older revision does not hide a new dirty revision", async () => {
    const attempt = await pending();
    await realEventStore(sql).failSync(attempt.idempotencyKey);
    await sql`update events set title = 'Next revision' where event_key = ${sourceIdentity}`;
    await expectPreview("replay", /fresh dispatch/);
  });
  it.each([
    ["due", 1, "past", "replay", /due recovery/],
    ["future", 1, "future", "keep", /not due/],
    ["unsettled", 1, "null", "keep", /unsettled/],
    ["exhausted", 6, "past", "keep", /budget exhausted/],
  ] as const)(
    "%s pending request is classified without changing its claim or budget",
    async (_label, attempts, due, action, reason) => {
      const attempt = await pending();
      const next = due === "null" ? null : new Date(Date.now() + (due === "past" ? -60000 : 60000));
      await sql`update event_sync_attempts set request_attempts = ${attempts}, next_attempt_at = ${next}
      where idempotency_key = ${attempt.idempotencyKey}::uuid`;
      await expectPreview(action, reason);
    },
  );
  it("a pending request survives on a source closed to past", async () => {
    await pending();
    await sql`update events set status = 'past' where event_key = ${sourceIdentity}`;
    await expectPreview("keep", /pending.*operator recovery/);
  });
  it("missing source, malformed identity and other job kinds keep, never become stale advice", async () => {
    await sql`delete from events`;
    await expectPreview("keep", /source is missing/);
    await sql`update queue_failed_jobs set key = 'sync-event:invalid' where id = ${failureId}`;
    await expectPreview("keep", /invalid source identity/);
    await sql`update queue_failed_jobs set kind = 'announcement', key = null where id = ${failureId}`;
    const before = await state();
    expect(await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).toMatchObject({
      disposition: { action: "keep", reason: "non-sync-event kind is outside this tool" },
    });
    expect(await state()).toEqual(before);
  });
  describe("staging demo event keys", () => {
    const seedKey = "seed-calendar-05";
    async function seedSource(key: string, title = "Seed fixture") {
      await sql`delete from events`;
      await sql`insert into events (event_key, title, starts_at, ends_at, status)
        values (${key}, ${title}, now(), now() + interval '1 hour', 'published')`;
      await sql`update queue_failed_jobs set key = ${`sync-event:${key}`} where id = ${failureId}`;
    }
    it("a dirty seed event on staging gets replay advice, not an invalid-identity refusal", async () => {
      // Seeded events never receive a Discord mapping, so they stay dirty.
      await seedSource(seedKey);
      const before = await state();
      expect(await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).toMatchObject({
        disposition: { action: "replay", reason: expect.stringMatching(/fresh dispatch/) },
      });
      expect(await state()).toEqual(before);
    });
    it("a clean seed event on staging is stale advice, and a missing one is preserved", async () => {
      await seedSource(seedKey);
      await sql`update events set discord_event_id = 'mapped', synced_revision = sync_revision where event_key = ${seedKey}`;
      expect(await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).toMatchObject({
        disposition: { action: "discard-stale" },
      });
      await sql`delete from events`;
      expect(await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).toMatchObject({
        disposition: { action: "keep", reason: expect.stringMatching(/source is missing/) },
      });
    });
    it.each([
      ["production binding", "https://togetherweown.com", seedKey],
      ["unlisted seed number", STAGING_APP_URL, "seed-calendar-51"],
      ["unlisted seed shape", STAGING_APP_URL, "seed-calendar-5"],
      ["other staging text", STAGING_APP_URL, "seed-other"],
    ])("%s keeps the dead row without a source lookup", async (_label, appUrl, key) => {
      await seedSource(key);
      await sql`update events set title = 'Changed' where event_key = ${key}`;
      const before = await state();
      expect(await previewFailedJobWithSql(sql, failureId, appUrl)).toMatchObject({
        disposition: { action: "keep", reason: "invalid source identity; preserve dead row" },
      });
      expect(await state()).toEqual(before);
    });
  });
  it("unknown ID returns nothing and malformed IDs refuse before opening a transaction", async () => {
    expect(await previewFailedJobWithSql(sql, Number.MAX_SAFE_INTEGER, STAGING_APP_URL)).toBeNull();
    await expect(previewFailedJobWithSql(sql, -1, STAGING_APP_URL)).rejects.toThrow(
      "invalid failure ID",
    );
  });
  it.each(["needsSync", "pendingSync", "hasFailedSync"] as const)(
    "absence of %s fails closed, even for a clean source",
    async (name) => {
      vi.spyOn(eventStores, "pgEventStore").mockImplementationOnce(
        (tx) => ({ ...realEventStore(tx), [name]: undefined }) as never,
      );
      const before = await state();
      await expect(previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).rejects.toThrow(
        "incomplete reconciliation store",
      );
      expect(await state()).toEqual(before);
    },
  );
  it("the database refuses any accidental mutation by the source checker", async () => {
    vi.spyOn(eventStores, "pgEventStore").mockImplementationOnce((tx) => ({
      ...realEventStore(tx),
      hasFailedSync: async () => {
        await tx`delete from queue_failed_jobs where id = ${failureId}`;
        return false;
      },
    }));
    const before = await state();
    await expect(previewFailedJobWithSql(sql, failureId, STAGING_APP_URL)).rejects.toMatchObject({
      code: "25006",
    });
    expect(await state()).toEqual(before);
  });
  it("every preview SELECT bypasses Hyperdrive read caching without exposing the marker", async () => {
    const queries: string[] = [];
    const monitored = postgres(process.env.DATABASE_URL!, {
      max: 1,
      prepare: false,
      fetch_types: false,
      connect_timeout: 5,
      connection: { search_path: fixture.schemaName },
      debug: (_connection, query) => queries.push(query),
    });
    try {
      const before = await state();
      const preview = await previewFailedJobWithSql(monitored, failureId, STAGING_APP_URL);
      const sourceReads = queries.filter((query) => /^select\b/i.test(query.trim()));
      expect(sourceReads).toHaveLength(5);
      for (const query of sourceReads) expect(query).toContain("clock_timestamp()");
      expect(preview!.disposition.action).toBe("discard-stale");
      expect(JSON.stringify(preview)).not.toContain("preview_read_at");
      expect(await state()).toEqual(before);
    } finally {
      await monitored.end({ timeout: 1 });
    }
  });
  it("concurrent source change cannot mix clean and refused revisions within one preview", async () => {
    vi.spyOn(eventStores, "pgEventStore").mockImplementationOnce((tx) => {
      const store = realEventStore(tx);
      return {
        ...store,
        needsSync: async (identity) => {
          const dirty = await store.needsSync(identity);
          const attempt = await pending();
          await realEventStore(sql).failSync(attempt.idempotencyKey);
          return dirty;
        },
      };
    });
    const first = await previewFailedJobWithSql(sql, failureId, STAGING_APP_URL);
    expect(first!.disposition.action).toBe("discard-stale");
    // A preview conveys no write authority. A later invocation freshly sees
    // the committed refusal rather than reusing the old clean snapshot.
    await expectPreview("keep", /definitive refusal/);
  });
});
