import { asc, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteFeatured, getFeatured, NotFoundError, updateFeatured, type Actor } from "../src/admin/store";
import type { FeaturedFormInput } from "../src/admin/validation";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const url = process.env.DATABASE_URL;
const firstActor: Actor = { id: "featured-first", username: "First moderator" };
const secondActor: Actor = { id: "featured-second", username: "Second moderator" };
const initialUpdatedAt = new Date("2026-01-01T00:00:00.123Z");
const form: FeaturedFormInput = {
  title: "Original title", body: "Unchanged body", url: "https://example.test/featured",
  imageUrl: "https://example.test/image.png", imageAlt: "An unchanged image",
  isPublished: true, position: 3,
  startsAtUtc: new Date("2026-10-01T12:00:00.123Z"),
  endsAtUtc: new Date("2026-10-02T12:00:00.456Z"),
};

// The fixture validates the target before connecting and runs canonical
// migrations in a disposable schema. Two writers + a lock observer need three
// connections; the observer releases the holder only after Postgres proves the
// competing statement is waiting. No timing sleeps or mocked row locks.
describe.skipIf(!url)("featured write serialization (owned Postgres schema)", () => {
  let fixture: MemberDataFixture;
  let id: number;

  beforeAll(async () => { fixture = await createMemberDataFixture(url!, { max: 3 }); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    const [row] = await fixture.db.insert(featuredContents).values({
      title: form.title, body: form.body, url: form.url,
      imageUrl: form.imageUrl, imageAlt: form.imageAlt,
      isPublished: form.isPublished, position: form.position,
      startsAt: form.startsAtUtc, endsAt: form.endsAtUtc,
      legacyId: "90001", createdBy: "original-creator", updatedAt: initialUpdatedAt,
    }).returning();
    id = row!.id;
    // Retain sub-millisecond database precision through a full-form save too.
    await fixture.client`update featured_contents
      set created_at = '2026-01-01T00:00:00.123456Z'::timestamptz where id = ${id}`;
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await fixture?.dispose(); });

  const audits = () => fixture.db.select().from(activityLog).orderBy(asc(activityLog.id));
  const metadata = async () => {
    const [row] = await fixture.client`select legacy_id, created_by,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as created_at,
      to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as starts_at,
      to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as ends_at
      from featured_contents where id = ${id}`;
    return row;
  };

  async function waitForBlocked(holder: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await fixture.client`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and ${holder} = any(pg_blocking_pids(pid))`;
      if (rows.length) return;
    }
    throw new Error("featured contender did not reach the held row lock");
  }

  async function overlap<T>(first: (tx: Db) => Promise<unknown>, second: () => Promise<T>): Promise<T> {
    let pending: Promise<{ value: T } | { error: unknown }> | undefined;
    try {
      await fixture.db.transaction(async (tx) => {
        const [holder] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        // A nested store transaction is a savepoint on this real connection.
        // Hold its successful mutation + audit uncommitted while writer 2 starts.
        await first(tx as unknown as Db);
        pending = second().then((value) => ({ value }), (error: unknown) => ({ error }));
        await waitForBlocked(holder!.pid);
      });
    } finally {
      // Rollback/commit releases the lock even if the barrier assertion fails.
      await pending;
    }
    const outcome = await pending!;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  it("successive updates audit committed predecessor values, not the stale snapshot", async () => {
    const row = await overlap(
      (tx) => updateFeatured(tx, firstActor, id, { ...form, title: "First title" }),
      () => updateFeatured(fixture.db, secondActor, id, { ...form, title: "Second title" }),
    );
    expect(row.title).toBe("Second title");
    const logs = await audits();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      subjectType: "FeaturedContent", subjectId: String(id), causerId: firstActor.id,
      description: "updated featured content First title",
      properties: { title: { before: form.title, after: "First title" } },
    });
    expect(logs[1]).toMatchObject({
      subjectType: "FeaturedContent", subjectId: String(id), causerId: secondActor.id,
      description: "updated featured content Second title",
      properties: { title: { before: "First title", after: "Second title" } },
    });
  });

  it("a successive position edit preserves the title and does not re-audit it", async () => {
    const before = await metadata();
    const row = await overlap(
      (tx) => updateFeatured(tx, firstActor, id, { ...form, title: "Shared title" }),
      () => updateFeatured(fixture.db, secondActor, id, { ...form, title: "Shared title", position: 7 }),
    );
    expect(row).toMatchObject({
      title: "Shared title", position: 7, body: form.body, url: form.url,
      imageUrl: form.imageUrl, imageAlt: form.imageAlt, isPublished: true,
      startsAt: form.startsAtUtc, endsAt: form.endsAtUtc,
    });
    expect(await metadata()).toEqual(before);
    const logs = await audits();
    expect(logs).toHaveLength(2);
    expect(logs[1]!.properties).toMatchObject({ position: { before: 3, after: 7 } });
    expect(logs[1]!.properties).not.toHaveProperty("title");
  });

  it("overlapping deletes have one success and one not-found, with exactly one audit", async () => {
    await expect(overlap(
      (tx) => deleteFeatured(tx, firstActor, id),
      () => deleteFeatured(fixture.db, secondActor, id),
    )).rejects.toMatchObject({ what: "featured content", message: "featured content not found" });
    expect(await getFeatured(fixture.db, id)).toBeNull();
    const logs = await audits();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      subjectType: "FeaturedContent", subjectId: String(id), causerId: firstActor.id,
      description: `deleted featured content ${form.title}`,
      properties: { title: { before: form.title, after: null } },
    });
  });

  it("a delete waiting behind an update audits the committed title", async () => {
    await overlap(
      (tx) => updateFeatured(tx, firstActor, id, { ...form, title: "Before deletion" }),
      () => deleteFeatured(fixture.db, secondActor, id),
    );
    expect(await getFeatured(fixture.db, id)).toBeNull();
    const logs = await audits();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({
      causerId: secondActor.id, description: "deleted featured content Before deletion",
      properties: { title: { before: "Before deletion", after: null } },
    });
  });

  it("an update waiting behind a delete follows the existing not-found contract", async () => {
    await expect(overlap(
      (tx) => deleteFeatured(tx, firstActor, id),
      () => updateFeatured(fixture.db, secondActor, id, { ...form, title: "Too late" }),
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(await getFeatured(fixture.db, id)).toBeNull();
    expect(await audits()).toHaveLength(1);
  });

  it("keeps same-clock no-op saves audit-free and retains timestamp-only save audits", async () => {
    const before = await getFeatured(fixture.db, id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initialUpdatedAt);
    expect(await updateFeatured(fixture.db, firstActor, id, form)).toEqual(before);
    expect(await audits()).toHaveLength(0);
    const next = new Date(initialUpdatedAt.getTime() + 1000);
    vi.setSystemTime(next);
    expect(await updateFeatured(fixture.db, firstActor, id, form)).toEqual({ ...before, updatedAt: next });
    expect((await audits()).map((log) => log.properties)).toEqual([
      { updatedAt: { before: initialUpdatedAt.toISOString(), after: next.toISOString() } },
    ]);
  });

  it.each(["update", "delete"] as const)("rolls back %s if the audit insert fails", async (operation) => {
    const before = await getFeatured(fixture.db, id);
    const beforeMetadata = await metadata();
    await fixture.client`alter table activity_log add constraint featured_reject_audit
      check (causer_id <> 'featured-second')`;
    try {
      const write = operation === "update"
        ? updateFeatured(fixture.db, secondActor, id, { ...form, title: "Must roll back" })
        : deleteFeatured(fixture.db, secondActor, id);
      await expect(write).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(await getFeatured(fixture.db, id)).toEqual(before);
      expect(await metadata()).toEqual(beforeMetadata);
      expect(await audits()).toHaveLength(0);
      // The rollback also releases the lock for the next successful writer.
      await updateFeatured(fixture.db, firstActor, id, { ...form, title: "After rollback" });
      expect(await audits()).toHaveLength(1);
    } finally {
      await fixture.client`alter table activity_log drop constraint featured_reject_audit`;
    }
  });

  it("keeps sequential update/delete success and missing-row semantics", async () => {
    const before = await metadata();
    await updateFeatured(fixture.db, firstActor, id, { ...form, title: "Single writer", position: 9 });
    expect(await metadata()).toEqual(before);
    await deleteFeatured(fixture.db, firstActor, id);
    await expect(deleteFeatured(fixture.db, firstActor, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateFeatured(fixture.db, firstActor, id, form)).rejects.toBeInstanceOf(NotFoundError);
    expect(await audits()).toHaveLength(2);
  });
});
