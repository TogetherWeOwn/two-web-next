import type postgres from "postgres";
import { occurrences } from "../admin/recurrence";
import { isMirrored, newEventKey } from "../admin/validation";
import type { EventStore, MirroredEvent, TxClient } from "./types";

type Sql = ReturnType<typeof postgres>;

/**
 * Postgres EventStore (TOG-11660). Real row selection for the reconcile pass,
 * behind the `EventStore` interface — orchestration is proved with fakes in
 * `test/jobs.test.ts`, this is the real-SQL half. Raw postgres.js queries only:
 * jobs clients stay drizzle-free (drizzle() installs transparent date/JSON
 * serializers on the client it wraps, which would change native-Date behaviour
 * for every later query on a shared pool — see test/helpers/jobs-db.ts), so
 * series materialisation re-expresses `materializeMissingInstances`
 * (src/admin/store.ts) on raw rows instead of reusing it.
 *
 * No wiring here: `src/jobs/worker.ts` keeps its not-wired stubs until the
 * follow-up lands after PR #68.
 */
export function pgEventStore(sql: TxClient | Sql): EventStore {
  return {
    find: (eventKey) => findEvent(sql, eventKey),
    recordMirrored: (eventKey, discordEventId, mirroredAt) =>
      recordMirrored(sql, eventKey, discordEventId, mirroredAt),
    closeFinished: (now) => closeFinished(sql, now),
    materializeSeries: () => materializeSeries(sql),
    staleEventKeys: () => staleEventKeys(sql),
  };
}

type EventRow = {
  event_key: string;
  title: string;
  starts_at: Date | string;
  ends_at: Date | string;
  timezone: string;
  location: string | null;
  description: string | null;
  status: string;
};

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

async function findEvent(sql: TxClient | Sql, eventKey: string): Promise<MirroredEvent | null> {
  const rows =
    (await sql`select event_key, title, starts_at, ends_at, timezone, location, description, status
    from events where event_key = ${eventKey}`) as EventRow[];
  const row = rows[0];
  if (!row) return null;
  const startsAt = asDate(row.starts_at);
  const endsAt = asDate(row.ends_at);
  return {
    eventKey: row.event_key,
    payload: {
      eventKey: row.event_key,
      name: row.title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      location: row.location ?? "",
      description: row.description,
    },
    mirrored: isMirrored(row.status as "draft" | "published" | "cancelled" | "past"),
  };
}

/**
 * Persist the bot's Discord id and stamp every answer the mirror has caught up
 * with: RSVPs updated at or before `mirroredAt`. Answers edited after the
 * mirror ran keep a null stamp so the next pass re-syncs them. Unknown keys
 * match nothing (the subselect yields null) — no throw, the queued event was
 * deleted mid-flight.
 *
 * The events row carries only the Discord id: no `updated_at` touch, no audit
 * row (the admin store's AUDIT_EXCLUDE keeps bot writes out of the trail for
 * the same reason). A replay with the same id changes nothing at all — the
 * guard makes it a true no-op instead of a rewrite.
 */
async function recordMirrored(
  sql: TxClient | Sql,
  eventKey: string,
  discordEventId: string,
  mirroredAt: Date,
): Promise<void> {
  await sql`update events set discord_event_id = ${discordEventId}
    where event_key = ${eventKey} and discord_event_id is distinct from ${discordEventId}`;
  await sql`update rsvps set synced_to_discord_at = ${mirroredAt}
    where event_id = (select id from events where event_key = ${eventKey})
      and updated_at <= ${mirroredAt}`;
}

/**
 * Ports the close half of events:reconcile: published events past `ends_at`
 * become `past`. Drafts were never announced, cancelled keeps its write-back,
 * already-past rows are untouched. Returns rows changed.
 */
async function closeFinished(sql: TxClient | Sql, now: Date): Promise<number> {
  const rows = (await sql`update events set status = 'past', updated_at = ${now}
    where status = 'published' and ends_at <= ${now} returning 1`) as unknown[];
  return rows.length;
}

/**
 * Ports `materializeRecurringSeries` (src/admin/store.ts): top up every live
 * series (draft or published parent). A cancelled series stays cancelled and a
 * finished one finished; a moderator-cancelled instance (a skipped week) is an
 * existing row and is never recreated. Children start as drafts with a null
 * causer creation audit, exactly like the admin path (which the reconcile
 * test pins). Idempotent: a re-run matches only existing indexes. Returns rows
 * created.
 *
 * One deliberate difference from the admin path: no explicit transaction per
 * parent. The adapter also runs on the reconcile flight's reserved transaction
 * client, where postgres.js rejects `begin`. The pass is cron-single-flighted,
 * so no two passes race; a crash between a child insert and its audit leaves a
 * row the next run skips (its index exists) without that audit.
 */
async function materializeSeries(sql: TxClient | Sql): Promise<number> {
  type ParentRow = {
    id: number;
    event_key: string;
    title: string;
    game: string | null;
    description: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    timezone: string;
    location: string | null;
    capacity: number | null;
    created_by: string | null;
    recurrence_frequency: string | null;
    recurrence_count: number | null;
    recurrence_ends_on: Date | string | null;
  };
  const parents = (await sql`select id, event_key, title, game, description, starts_at, ends_at,
      timezone, location, capacity, created_by, recurrence_frequency, recurrence_count, recurrence_ends_on
    from events where recurrence_frequency is not null and status in ('draft', 'published')`) as ParentRow[];
  let created = 0;
  for (const parent of parents) {
    if (parent.recurrence_frequency !== "weekly") continue;
    const wanted = occurrences(
      asDate(parent.starts_at),
      asDate(parent.ends_at),
      parent.timezone,
      parent.recurrence_frequency,
      parent.recurrence_count,
      parent.recurrence_ends_on ? asDate(parent.recurrence_ends_on) : null,
    );
    const existing = (await sql`select recurrence_index from events
      where parent_event_id = ${parent.id}`) as { recurrence_index: number | null }[];
    const have = new Set(existing.map((r) => r.recurrence_index));
    for (const [index, when] of wanted) {
      if (index === 1 || have.has(index)) continue;
      const eventKey = newEventKey();
      const childRows = (await sql`insert into events
          (event_key, title, game, description, starts_at, ends_at, timezone, location, capacity,
            status, created_by, parent_event_id, recurrence_index)
        values (${eventKey}, ${parent.title}, ${parent.game}, ${parent.description}, ${when.startsAt}, ${when.endsAt},
          ${parent.timezone}, ${parent.location}, ${parent.capacity}, 'draft', ${parent.created_by}, ${parent.id}, ${index})
        returning *`) as Record<string, unknown>[];
      const child = childRows[0];
      if (!child) throw new Error("child event insert returned no row");
      await sql`insert into activity_log (log_name, description, subject_type, subject_id, causer_id, properties)
        values ('default', ${`created event ${parent.title}`}, 'Event', ${eventKey}, null, ${childAuditProperties(child)})`;
      created++;
    }
  }
  return created;
}

/** `dirty({}, child)` shape (src/admin/store.ts), minus the audit-excluded bot columns. */
function childAuditProperties(
  child: Record<string, unknown>,
): Record<string, { before: null; after: unknown }> {
  const after = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
  const cell = (v: unknown) => ({ before: null as null, after: after(v) });
  return {
    id: cell(child.id),
    eventKey: cell(child.event_key),
    title: cell(child.title),
    game: cell(child.game),
    description: cell(child.description),
    startsAt: cell(child.starts_at),
    endsAt: cell(child.ends_at),
    timezone: cell(child.timezone),
    location: cell(child.location),
    capacity: cell(child.capacity),
    status: cell(child.status),
    discordSyncFailedAt: cell(child.discord_sync_failed_at),
    discordSyncFailureCode: cell(child.discord_sync_failure_code),
    createdBy: cell(child.created_by),
    rsvpOpen: cell(child.rsvp_open),
    recurrenceFrequency: cell(child.recurrence_frequency),
    recurrenceCount: cell(child.recurrence_count),
    recurrenceEndsOn: cell(child.recurrence_ends_on),
    parentEventId: cell(child.parent_event_id),
    recurrenceIndex: cell(child.recurrence_index),
    createdAt: cell(child.created_at),
    updatedAt: cell(child.updated_at),
  };
}

/**
 * The sync half's input: published rows the mirror has not caught up with —
 * no Discord id yet, or at least one answer still unsynced. Fully mirrored
 * rows (id set, every RSVP stamped) stay quiet; drafts and cancelled rows are
 * never selected (their write-back travels the immediate dispatch path, and
 * drafts were never announced).
 */
async function staleEventKeys(sql: TxClient | Sql): Promise<string[]> {
  const rows = (await sql`select event_key from events
    where status = 'published'
      and (discord_event_id is null
        or exists (select 1 from rsvps where rsvps.event_id = events.id and rsvps.synced_to_discord_at is null))
    order by id`) as { event_key: string }[];
  return rows.map((r) => r.event_key);
}
