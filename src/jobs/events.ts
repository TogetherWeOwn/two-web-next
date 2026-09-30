import type postgres from "postgres";
import type { EventStore, EventUpsert, SyncAttempt, TxClient } from "./types";

type AttemptRow = { idempotency_key: string; revision: string | number; mirrored_at: Date; state: SyncAttempt["state"] }
  & ({ action: "event.upsert"; payload: EventUpsert } | { action: "event.cancel"; payload: { eventKey: string } });

function attemptFrom(row: AttemptRow): SyncAttempt {
  const base = {
    idempotencyKey: row.idempotency_key, eventKey: row.payload.eventKey,
    revision: Number(row.revision), mirroredAt: row.mirrored_at, state: row.state,
  };
  if (row.action === "event.cancel") return { ...base, action: "event.cancel", payload: row.payload };
  return { ...base, action: "event.upsert", payload: {
    ...row.payload,
    startsAt: new Date(row.payload.startsAt).toISOString(),
    endsAt: row.payload.endsAt === null ? null : new Date(row.payload.endsAt).toISOString(),
  } };
}

/** Current-row snapshot at the first bot attempt; durable and immutable thereafter. */
export function pgEventStore(sql: ReturnType<typeof postgres> | TxClient): EventStore {
  // Revision dirtiness survives a rejected send and deletion of the last RSVP.
  // The missing-mapping/RSVP predicate remains a migration backstop.
  const staleKeys = async (eventKey: string | null) => {
    const rows = await sql`select event_key from events
      where status in ('published', 'cancelled') and (${eventKey}::text is null or event_key = ${eventKey})
      and (sync_revision > synced_revision or
        (status = 'published' and (discord_event_id is null or exists (
          select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
        ))))`;
    return rows.map((row: { event_key: string }) => row.event_key);
  };
  return {
    async prepareSync(eventKey, idempotencyKey, mirroredAt) {
      const [cached] = await sql`select a.* from event_sync_attempts a join events e on e.id = a.event_id
        where a.idempotency_key = ${idempotencyKey}::uuid and e.event_key = ${eventKey}`;
      if (cached) return attemptFrom(cached);
      // One atomic snapshot of status/payload/revision. A partial unique index
      // permits only one pending request per event, even beyond the lock TTL.
      // DO NOTHING conflicts retry; they must not acknowledge an unseen row
      // from another transaction's READ COMMITTED snapshot.
      const [created] = await sql`insert into event_sync_attempts
        (idempotency_key, event_id, revision, action, payload, mirrored_at)
        select ${idempotencyKey}::uuid, id, sync_revision,
          case when status = 'cancelled' then 'event.cancel' else 'event.upsert' end,
          case when status = 'cancelled' then jsonb_build_object('eventKey', event_key)
          else jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
            'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description) end,
          ${mirroredAt}
        from events where event_key = ${eventKey} and status in ('published', 'cancelled')
        and (sync_revision > synced_revision or
          (status = 'published' and (discord_event_id is null or exists (
            select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
          ))))
        on conflict do nothing returning *`;
      if (created) return attemptFrom(created);
      // Clean rows need no further bot call even if redundant jobs were queued
      // while an older attempt was finishing. Dirty conflicts wait, never ACK.
      return (await staleKeys(eventKey)).length ? { waiting: true } : null;
    },
    async completeSync(attempt, discordEventId) {
      // Settlement and revision acknowledgement commit together. Only the read
      // revision is clean; later event edits/cancellations remain in the outbox.
      await sql`with settled as (
        update event_sync_attempts set state = 'succeeded'
        where idempotency_key = ${attempt.idempotencyKey}::uuid and state = 'pending'
        returning event_id, revision, mirrored_at
      ), mirrored as (
        update events set discord_event_id = ${discordEventId},
          synced_revision = greatest(synced_revision, settled.revision)
        from settled where events.id = settled.event_id returning events.id, settled.mirrored_at
      ) update rsvps set synced_to_discord_at = mirrored.mirrored_at
        from mirrored where rsvps.event_id = mirrored.id and rsvps.updated_at <= mirrored.mirrored_at`;
    },
    async failSync(idempotencyKey) {
      await sql`update event_sync_attempts set state = 'failed'
        where idempotency_key = ${idempotencyKey}::uuid and state = 'pending'`;
    },
    needsSync: async (eventKey) => (await staleKeys(eventKey)).length > 0,
    async pendingSyncKey(eventKey) {
      const [row] = await sql`select a.idempotency_key from event_sync_attempts a join events e on e.id = a.event_id
        where e.event_key = ${eventKey} and a.state = 'pending'`;
      return row?.idempotency_key ?? null;
    },
    async closeFinished(now) {
      const rows = await sql`update events set status = 'past', updated_at = ${now}
        where status = 'published' and ends_at <= ${now} returning id`;
      return rows.length;
    },
    staleEventKeys: () => staleKeys(null),
  };
}
