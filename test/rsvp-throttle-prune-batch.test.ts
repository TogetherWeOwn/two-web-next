// Acceptance contract: RSVP throttle maintenance must clean expired
// web_throttle_hits in bounded batches and must never wait on an unrelated
// locked expired row.
//
// Each RSVP write runs the global prune while holding member/event locks, so
// an unbounded prune that blocks on a locked row couples unrelated members'
// writes and prolongs event-lock ownership. These tests pin the repair:
//
// - one cleanup deletes at most the established 1000-row batch
//   (PRUNE_DELETE_BATCH_SIZE in src/jobs/constants.ts), preserving every
//   fresh row, and repeated writes eventually drain the overflow;
// - an independent PUT and DELETE each complete while an unrelated expired
//   row is locked by another transaction, without waiting for that lock;
// - the safety ordering the prune was moved for still holds: expiry is
//   judged after the write's lock waits, a refused write spends no budget,
//   and an accepted write is charged exactly once.
//
// Lock schedules use holder-acquisition latches (the holder signals before
// the writer starts), and the "completes without waiting" assertions race the
// write against a bounded 15s timeout instead of judging by sleeps. Live
// against agent-testdb (skipped without DATABASE_URL, like test/rsvp.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventKey } from "../src/admin/validation";
import { events, rsvps } from "../src/db/admin-schema";
import { withdrawRsvp, writeRsvp } from "../src/events/rsvp";
import { eq } from "drizzle-orm";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// The repository's established bounded-cleanup batch.
const BATCH = 1000;
// Generous bound for "completes without waiting": a skipped locked row means
// the write only does its own work, so seconds of slack are plenty; a write
// that waits on the held lock never settles until the test releases it.
const NO_WAIT_MS = 15_000;

describe("rsvp throttle prune batch test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rsvp throttle prune batch (agent-testdb)", () => {
  // Pool width: a held lock transaction, the writer's transaction and the
  // test's own count queries each need their own connection.
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 6 });
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const seedEvent = async (over: Partial<typeof events.$inferInsert> = {}) => {
    const [row] = await fixture.db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: "Batch prune night",
        startsAt: new Date("2099-01-01T20:00:00Z"),
        endsAt: new Date("2099-01-01T22:00:00Z"),
        status: "published",
        ...over,
      })
      .returning();
    return row!;
  };

  // Expired = older than the five-minute retention window; fresh = inside it.
  const seedExpired = async (bucket: string, n: number) => {
    await fixture.client`insert into web_throttle_hits (bucket, at)
      select ${bucket}, clock_timestamp() - interval '10 minutes'
      from generate_series(1, ${n})`;
  };
  const seedFresh = async (bucket: string, n: number) => {
    await fixture.client`insert into web_throttle_hits (bucket, at)
      select ${bucket}, clock_timestamp() from generate_series(1, ${n})`;
  };
  const countBucket = async (bucket: string): Promise<number> => {
    const [r] =
      (await fixture.client`select count(*)::int as n from web_throttle_hits where bucket = ${bucket}`) as unknown as [
        { n: number },
      ];
    return r!.n;
  };

  // Hold FOR UPDATE on every row of `bucket` until release() is called. The
  // returned `acquired` promise resolves once the lock is actually held, so
  // callers never race the holder's first statement.
  const holdBucketRows = (bucket: string) => {
    let release!: () => void;
    let signalAcquired!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const acquired = new Promise<void>((r) => (signalAcquired = r));
    const holder = fixture.client.begin(async (tx) => {
      await tx`select id from web_throttle_hits where bucket = ${bucket} for update`;
      signalAcquired();
      await held;
    });
    return { acquired, release, holder };
  };

  // Race a promise against a bounded timeout: the failure message names the
  // contract, so a pre-fix run fails here instead of hanging the suite.
  const within = async <T>(pending: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  it("one write deletes at most one bounded batch of expired rows and keeps every fresh row", async () => {
    const ev = await seedEvent();
    await seedExpired("batch-expired", BATCH + 1);
    await seedFresh("batch-fresh", 3);

    const first = await writeRsvp(fixture.db, ev.eventKey, "batch-drain-0", "maybe");
    expect(first.ok).toBe(true);
    // Capped: with BATCH+1 eligible rows, at least one must survive the first
    // cleanup; uncapped cleanup would leave none.
    const afterFirst = await countBucket("batch-expired");
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    // And it made progress within the cap: BATCH+1 seeded, at most BATCH gone.
    expect(afterFirst).toBeLessThanOrEqual(BATCH + 1);
    expect(BATCH + 1 - afterFirst).toBeGreaterThan(0);
    expect(BATCH + 1 - afterFirst).toBeLessThanOrEqual(BATCH);
    // Fresh rows are never cleanup targets.
    expect(await countBucket("batch-fresh")).toBe(3);

    // Repeated writes eventually drain the overflow (a fresh member per call
    // keeps the per-member budget out of the way).
    for (let i = 1; i <= 20 && (await countBucket("batch-expired")) > 0; i++) {
      const next = await writeRsvp(fixture.db, ev.eventKey, `batch-drain-${i}`, "maybe");
      expect(next.ok).toBe(true);
    }
    expect(await countBucket("batch-expired")).toBe(0);
    expect(await countBucket("batch-fresh")).toBe(3);
  });

  it("a PUT completes without waiting for an unrelated locked expired row, and a later write drains it", async () => {
    const ev = await seedEvent();
    await seedExpired("unrelated-locked-put", 2);
    await seedFresh("bystander-fresh-put", 1);
    const lock = holdBucketRows("unrelated-locked-put");
    await lock.acquired;

    const pending = writeRsvp(fixture.db, ev.eventKey, "independent-put", "maybe");
    try {
      const result = await within(
        pending,
        NO_WAIT_MS,
        "independent PUT while an unrelated expired-row lock was held",
      );
      expect(result.ok).toBe(true);
      // The locked rows were skipped, not deleted from under the holder.
      expect(await countBucket("unrelated-locked-put")).toBe(2);
      expect(await countBucket("bystander-fresh-put")).toBe(1);
      // The accepted write still charged the member exactly once.
      expect(await countBucket("rsvp-write:independent-put")).toBe(1);
    } finally {
      lock.release();
      await lock.holder;
      await pending.catch(() => undefined);
    }

    // Once unlocked, the next write's cleanup drains the skipped rows.
    const later = await writeRsvp(fixture.db, ev.eventKey, "later-put", "maybe");
    expect(later.ok).toBe(true);
    expect(await countBucket("unrelated-locked-put")).toBe(0);
    expect(await countBucket("bystander-fresh-put")).toBe(1);
  }, 60_000);

  it("a DELETE completes without waiting for an unrelated locked expired row", async () => {
    const ev = await seedEvent();
    const member = "independent-delete";
    const put = await writeRsvp(fixture.db, ev.eventKey, member, "maybe");
    expect(put.ok).toBe(true);

    await seedExpired("unrelated-locked-delete", 2);
    const lock = holdBucketRows("unrelated-locked-delete");
    await lock.acquired;

    const pending = withdrawRsvp(fixture.db, ev.eventKey, member);
    try {
      const result = await within(
        pending,
        NO_WAIT_MS,
        "independent DELETE while an unrelated expired-row lock was held",
      );
      expect(result).toMatchObject({ limited: false, deleted: true });
      expect(await countBucket("unrelated-locked-delete")).toBe(2);
      const remaining = await fixture.db.select().from(rsvps).where(eq(rsvps.eventId, ev.id));
      expect(remaining).toHaveLength(0);
      // PUT + DELETE charged the shared budget exactly twice.
      expect(await countBucket(`rsvp-write:${member}`)).toBe(2);
    } finally {
      lock.release();
      await lock.holder;
      await pending.catch(() => undefined);
    }
  }, 60_000);

  // Control: the ordering guarantees the prune placement protects must
  // survive the repair. The member advisory lock is writeRsvp's first
  // statement, so holding it deterministically queues the write; the event
  // ends during that wait and the write must then refuse without spending.
  it("control: expiry is still judged after the lock wait and a refused write spends nothing", async () => {
    const ev = await seedEvent();
    const member = "expiry-control";
    const put = await writeRsvp(fixture.db, ev.eventKey, member, "going");
    expect(put.ok).toBe(true);
    await fixture.client`delete from web_throttle_hits where bucket = ${`rsvp-write:${member}`}`;
    await fixture.client`update events set ends_at = clock_timestamp() + interval '3 seconds' where id = ${ev.id}`;

    let release!: () => void;
    let signalAcquired!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const acquired = new Promise<void>((r) => (signalAcquired = r));
    const holder = fixture.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"rsvp-write:" + member}))`;
      signalAcquired();
      await held;
    });
    await acquired;

    const pending = writeRsvp(fixture.db, ev.eventKey, member, "maybe");
    try {
      // Let the event end while the write is queued behind the member lock.
      await fixture.client`select pg_sleep(greatest(0, extract(epoch from (ends_at - clock_timestamp())) + 0.2)) from events where id = ${ev.id}`;
    } finally {
      release();
      await holder;
    }
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "closed", why: "past" });
    const [row] = await fixture.db.select().from(rsvps).where(eq(rsvps.eventId, ev.id));
    expect(row!.status).toBe("going");
    expect(await countBucket(`rsvp-write:${member}`)).toBe(0);
  }, 30_000);
});
