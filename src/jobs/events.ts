import type postgres from "postgres";
import { isMirrored, type EventStatus } from "../admin/validation";
import type { EventStore, TxClient } from "./types";

/** W8 rows, read at consumption time rather than snapshotted into the queue. */
export function pgEventStore(sql: ReturnType<typeof postgres> | TxClient): EventStore {
  return {
    async find(eventKey) {
      const [row] = await sql`select event_key, title, starts_at, ends_at, location, description, status
        from events where event_key = ${eventKey}`;
      if (!row) return null;
      const status = row.status as EventStatus;
      return {
        eventKey: row.event_key,
        status,
        mirrored: isMirrored(status),
        payload: {
          eventKey: row.event_key, name: row.title,
          startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(),
          location: row.location ?? "", description: row.description,
        },
      };
    },
    async recordMirrored(eventKey, discordEventId, mirroredAt) {
      // One statement: persist the bot's mapping and stamp only answers included
      // in this sync. Later writes remain unsynced for the reconcile backstop.
      await sql`with mirrored as (
        update events set discord_event_id = ${discordEventId}
        where event_key = ${eventKey} returning id
      ) update rsvps set synced_to_discord_at = ${mirroredAt}
        where event_id in (select id from mirrored) and updated_at <= ${mirroredAt}`;
    },
    async closeFinished(now) {
      const rows = await sql`update events set status = 'past', updated_at = ${now}
        where status = 'published' and ends_at <= ${now} returning id`;
      return rows.length;
    },
    async staleEventKeys() {
      const rows = await sql`select event_key from events
        where status = 'published' and (discord_event_id is null or exists (
          select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
        ))`;
      return rows.map((row: { event_key: string }) => row.event_key);
    },
  };
}
