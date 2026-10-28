// A full page of permanently undispatchable stale rows must not starve the
// keys after them. The reconcile loop always skips a pending request with no
// budget left or no deadline, so the stale selection excludes those dirty
// rows from the page instead of counting them toward the limit.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { RECONCILE_REDISPATCH_PAGE_SIZE } from "../src/jobs/constants";
import { pgEventStore } from "../src/jobs/events";
import type { UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

describe.skipIf(!process.env.DATABASE_URL)("reconcile starvation guard (real pg store)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await sql`delete from rsvps`;
    await sql`delete from activity_log`;
    await sql`delete from events`;
  });

  const NOW = new Date("2026-10-01T12:00:00Z");
  const LEASE = "33333333-3333-4333-8333-333333333333";
  const memLock = (): UniqueLock => {
    const held = new Set<string>();
    return {
      acquire: async (k) => (held.has(k) ? null : (held.add(k), LEASE)),
      release: async (k, token) => {
        if (token === LEASE) held.delete(k);
      },
    };
  };

  async function seedPublished(eventKey: string): Promise<number> {
    const [row] = (await sql`insert into events
      (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
        recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
    values (${eventKey}, ${`event ${eventKey}`},
      ${new Date("2026-10-01T10:00:00Z")}, ${new Date("2026-10-01T14:00:00Z")},
      'Europe/London', 'hall', 'published', null, null, null, null, null)
    returning id`) as { id: number }[];
    return row!.id;
  }

  async function seedNullDeadline(eventKey: string, attempts = 1): Promise<void> {
    const id = await seedPublished(eventKey);
    await sql`insert into event_sync_attempts
      (idempotency_key, event_id, revision, action, payload, mirrored_at, state, request_attempts, next_attempt_at)
    select gen_random_uuid(), ${id}, sync_revision, 'event.upsert',
      jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
        'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description),
      ${NOW}, 'pending', ${attempts}, null
    from events where id = ${id}`;
  }

  it("a full page of exhausted keys still reaches the fresh key after them", async () => {
    const total = RECONCILE_REDISPATCH_PAGE_SIZE;
    await sql`insert into events
      (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
        recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
    select 'aaa-' || lpad(g::text, 3, '0'), 'event ' || g,
      timestamptz '2026-10-01 10:00:00+00', timestamptz '2026-10-01 14:00:00+00',
      'Europe/London', 'hall', 'published', null, null, null, null, null
    from generate_series(0, ${total - 1}) as g`;
    await sql`insert into event_sync_attempts
      (idempotency_key, event_id, revision, action, payload, mirrored_at, state, request_attempts, next_attempt_at)
    select gen_random_uuid(), id, sync_revision, 'event.upsert',
      jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
        'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description),
      timestamptz '2026-10-01 12:00:00+00', 'pending', 6, null
    from events where event_key like 'aaa-%'`;
    await seedPublished("zzz-fresh");

    const store = pgEventStore(sql);
    const page = (await store.staleEventKeys(RECONCILE_REDISPATCH_PAGE_SIZE)) as {
      keys: string[];
      deferred: number;
    };
    expect(page.keys).toEqual(["zzz-fresh"]);
    expect(page.deferred).toBe(0);
    expect(await store.staleEventKeys()).toEqual(["zzz-fresh"]);
    expect(await store.needsSync("aaa-000")).toBe(false);
    expect(await store.needsSync("zzz-fresh")).toBe(true);

    for (let pass = 0; pass < 3; pass++) {
      const sent: string[] = [];
      const r = await reconcileEvents({
        events: pgEventStore(sql),
        queue: { send: async (b: unknown) => void sent.push((b as { eventKey: string }).eventKey) },
        lock: memLock(),
        now: () => NOW,
      });
      expect(sent).toEqual(["zzz-fresh"]);
      expect(r).toMatchObject({ closed: 0, materialized: 0, resynced: 1, deferred: 0 });
    }

    await sql`update events set discord_event_id = 'discord-zzz-fresh',
      synced_revision = sync_revision where event_key = 'zzz-fresh'`;
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
  });

  it("a null-deadline pending does not consume a page slot", async () => {
    await seedNullDeadline("aaa-blocked");
    await seedPublished("zzz-fresh");

    const store = pgEventStore(sql);
    const page = (await store.staleEventKeys(1)) as { keys: string[]; deferred: number };
    expect(page.keys).toEqual(["zzz-fresh"]);
    expect(page.deferred).toBe(0);

    const sent: string[] = [];
    const r = await reconcileEvents({
      events: pgEventStore(sql),
      queue: { send: async (b: unknown) => void sent.push((b as { eventKey: string }).eventKey) },
      lock: memLock(),
      now: () => NOW,
    });
    expect(sent).toEqual(["zzz-fresh"]);
    expect(r).toMatchObject({ resynced: 1, deferred: 0 });
  });
});
