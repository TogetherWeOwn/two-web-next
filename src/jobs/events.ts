import type postgres from "postgres";
import { and, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "../db/admin-schema";
import { materializeMissingInstances } from "../admin/store";
import { SYNC_EVENT } from "./constants";
import type { EventStore, EventUpsert, StaleEventKeysPage, SyncAttempt, TxClient } from "./types";

type AttemptRow = {
  idempotency_key: string;
  revision: string | number;
  mirrored_at: Date;
  state: SyncAttempt["state"];
  request_attempts: number;
  next_attempt_at: Date | null;
  discord_event_id?: string | null;
} & (
  | { action: "event.upsert"; payload: EventUpsert }
  | { action: "event.cancel"; payload: { eventKey: string } }
);

function attemptFrom(row: AttemptRow): SyncAttempt {
  const base = {
    idempotencyKey: row.idempotency_key,
    eventKey: row.payload.eventKey,
    revision: Number(row.revision),
    mirroredAt: row.mirrored_at,
    state: row.state,
    requestAttempts: row.request_attempts,
    nextAttemptAt: row.next_attempt_at,
    // Absent on pre-mirror rows (hermetic doubles leave it undefined, which
    // the consumer treats as mirrored to preserve the bot path).
    ...("discord_event_id" in row ? { discordEventId: row.discord_event_id ?? null } : {}),
  };
  if (row.action === "event.cancel")
    return { ...base, action: "event.cancel", payload: row.payload };
  return {
    ...base,
    action: "event.upsert",
    payload: {
      ...row.payload,
      startsAt: new Date(row.payload.startsAt).toISOString(),
      endsAt: row.payload.endsAt === null ? null : new Date(row.payload.endsAt).toISOString(),
    },
  };
}

/** Durable request snapshot; first claims recheck eligibility, attempted retries are immutable.
 * Evidence-only verifier support: every source SELECT executed through this
 * store reports its statement name, row count and `clock_timestamp()` marker
 * (null when the SELECT legitimately returns no rows). The callback is
 * optional; when absent nothing is reported and behavior is unchanged. */
export type SourceReadStatement =
  | "queue_failed_jobs_by_id"
  | "events_by_key_exists"
  | "stale_keys"
  | "pending_sync"
  | "failed_sync";
export type SourceReadReport = {
  statement: SourceReadStatement;
  rowCount: number;
  readAt: unknown;
};
function markerOf(row: { preview_read_at?: unknown } | undefined): unknown {
  return row?.preview_read_at ?? null;
}
export function pgEventStore(
  sql: ReturnType<typeof postgres> | TxClient,
  {
    bypassReadCache = false,
    onSourceRead,
  }: { bypassReadCache?: boolean; onSourceRead?: (report: SourceReadReport) => void } = {},
): EventStore {
  // Operational previews cannot combine a fresh timestamp with cached source reads.
  // https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
  const readMarker = () => (bypassReadCache ? sql`, clock_timestamp() as preview_read_at` : sql``);
  // Revision dirtiness survives a rejected send and deletion of the last RSVP.
  // The missing-mapping/RSVP predicate remains a migration backstop.
  // Attempted requests recover independently of first-request eligibility:
  // closure or later refusal cannot resolve an ambiguous immutable request.
  // Reconciliation owns the due-time check using its scheduler clock.
  // The stale predicate is identical in every branch below: initiating-
  // eligible dirty revisions plus attempted pending recovery candidates.
  // The single-key branch keeps its current semantics; the page branch adds
  // a deterministic `ORDER BY event_key` + `LIMIT` with a same-statement
  // window count (windows see pre-LIMIT rows) for the deferred remainder.
  const staleKeys = async (
    eventKey: string | null,
    limit?: number,
  ): Promise<string[] | StaleEventKeysPage> => {
    if (eventKey === null && typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      const page = await sql`select event_key, count(*) over() as total${readMarker()} from events
        where (${eventKey}::text is null or event_key = ${eventKey}) and (
          exists (select 1 from event_sync_attempts pending
            where pending.event_id = events.id and pending.state = 'pending'
              and pending.request_attempts > 0 and pending.request_attempts < ${SYNC_EVENT.tries}
              and pending.next_attempt_at is not null)
          or (status in ('published', 'cancelled')
            and not exists (select 1 from event_sync_attempts rejected
              where rejected.event_id = events.id and rejected.revision = events.sync_revision and rejected.state = 'failed')
            and (sync_revision > synced_revision or
              (status = 'published' and (discord_event_id is null or exists (
                select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
              ))))))
        order by event_key asc limit ${Math.floor(limit)}`;
      onSourceRead?.({
        statement: "stale_keys",
        rowCount: page.length,
        readAt: markerOf(page[0] as { preview_read_at?: unknown } | undefined),
      });
      const keys = page.map((row: { event_key: string }) => row.event_key);
      // An empty page means nothing matched (a positive LIMIT returns rows
      // whenever matches exist), so the remainder is exactly zero.
      const total = page.length === 0 ? 0 : Number((page[0] as { total: string | number }).total);
      return { keys, deferred: Math.max(0, total - keys.length) };
    }
    const rows = await sql`select event_key${readMarker()} from events
      where (${eventKey}::text is null or event_key = ${eventKey}) and (
        exists (select 1 from event_sync_attempts pending
          where pending.event_id = events.id and pending.state = 'pending'
            and pending.request_attempts > 0 and pending.request_attempts < ${SYNC_EVENT.tries}
            and pending.next_attempt_at is not null)
        or (status in ('published', 'cancelled')
          and not exists (select 1 from event_sync_attempts rejected
            where rejected.event_id = events.id and rejected.revision = events.sync_revision and rejected.state = 'failed')
          and (sync_revision > synced_revision or
            (status = 'published' and (discord_event_id is null or exists (
              select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
            ))))))
      order by event_key asc`;
    onSourceRead?.({
      statement: "stale_keys",
      rowCount: rows.length,
      readAt: markerOf(rows[0] as { preview_read_at?: unknown } | undefined),
    });
    return rows.map((row: { event_key: string }) => row.event_key);
  };
  return {
    async prepareSync(eventKey, idempotencyKey, mirroredAt) {
      const [cached] =
        await sql`select a.*, e.discord_event_id from event_sync_attempts a join events e on e.id = a.event_id
        where a.idempotency_key = ${idempotencyKey}::uuid and e.event_key = ${eventKey}`;
      if (cached) return attemptFrom(cached);
      // One atomic snapshot of status/payload/revision. A partial unique index
      // permits only one pending request per event, even beyond the lock TTL.
      // DO NOTHING conflicts retry; they must not acknowledge an unseen row
      // from another transaction's READ COMMITTED snapshot.
      const [created] = await sql`insert into event_sync_attempts
        (idempotency_key, event_id, revision, action, payload, mirrored_at, next_attempt_at)
        select ${idempotencyKey}::uuid, id, sync_revision,
          case when status = 'cancelled' then 'event.cancel' else 'event.upsert' end,
          case when status = 'cancelled' then jsonb_build_object('eventKey', event_key)
          else jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
            'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description) end,
          ${mirroredAt}, ${mirroredAt}
        from events where event_key = ${eventKey} and status in ('published', 'cancelled')
        and not exists (select 1 from event_sync_attempts rejected
        where rejected.event_id = events.id and rejected.revision = events.sync_revision and rejected.state = 'failed')
      and (sync_revision > synced_revision or
          (status = 'published' and (discord_event_id is null or exists (
            select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
          ))))
        on conflict do nothing returning *, (select discord_event_id from events where id = event_id) as discord_event_id`;
      if (created) return attemptFrom(created);
      // Clean rows need no further bot call even if redundant jobs were queued
      // while an older attempt was finishing. Dirty conflicts wait, never ACK.
      // A single-key eligibility check always answers an array, never a page.
      const eligibility = await staleKeys(eventKey);
      const eligible = Array.isArray(eligibility) ? eligibility : eligibility.keys;
      return eligible.length ? { waiting: true } : null;
    },
    async completeSync(attempt, discordEventId) {
      // Settlement and revision acknowledgement commit together. Only the read
      // revision is clean; later event edits/cancellations remain in the outbox.
      // Null keeps the stored discord_event_id: a never-mirrored cancel resolves
      // its revision and stamps RSVPs locally without a bot revision.
      await sql`with settled as (
        update event_sync_attempts set state = 'succeeded'
        where idempotency_key = ${attempt.idempotencyKey}::uuid and state = 'pending'
        returning event_id, revision, mirrored_at
      ), mirrored as (
        update events set discord_event_id = coalesce(${discordEventId}, discord_event_id),
          synced_revision = greatest(synced_revision, settled.revision)
        from settled where events.id = settled.event_id returning events.id, settled.mirrored_at
      ) update rsvps set synced_to_discord_at = mirrored.mirrored_at
        from mirrored where rsvps.event_id = mirrored.id and rsvps.updated_at <= mirrored.mirrored_at`;
    },
    async claimSync(attempt, now) {
      // Lock the current event with the attempt so close/edit and a first claim
      // serialize. Preparation can also cache a dirty READ COMMITTED snapshot
      // while its INSERT waits behind another request's settlement. Recheck the
      // full first-request predicate, not just status/revision, before any I/O.
      // An ineligible unattempted snapshot retires without consuming a request
      // or acknowledging the event. Attempted replay keeps its payload/key.
      const [row] = await sql`with candidate as (
        select a.idempotency_key, e.discord_event_id, a.request_attempts = 0 and not (
          e.status in ('published', 'cancelled') and e.sync_revision = a.revision
          and not exists (select 1 from event_sync_attempts rejected
            where rejected.event_id = e.id and rejected.revision = e.sync_revision and rejected.state = 'failed')
          and (e.sync_revision > e.synced_revision or
            (e.status = 'published' and (e.discord_event_id is null or exists (
              select 1 from rsvps where rsvps.event_id = e.id and synced_to_discord_at is null
            ))))) as obsolete
        from event_sync_attempts a join events e on e.id = a.event_id
        where a.idempotency_key = ${attempt.idempotencyKey}::uuid and a.state = 'pending'
          and a.request_attempts < ${SYNC_EVENT.tries} and a.next_attempt_at <= ${now}
        for update of a, e
      ) update event_sync_attempts a
        set state = case when candidate.obsolete then 'obsolete' else a.state end,
          request_attempts = a.request_attempts + case when candidate.obsolete then 0 else 1 end,
          next_attempt_at = null
        from candidate where a.idempotency_key = candidate.idempotency_key
        returning a.*, candidate.discord_event_id`;
      return row ? attemptFrom(row) : null;
    },
    async deferSync(attempt, nextAttemptAt) {
      // The claim count fences a late result from an earlier claimed request.
      await sql`update event_sync_attempts set next_attempt_at = ${nextAttemptAt}
        where idempotency_key = ${attempt.idempotencyKey}::uuid and state = 'pending'
          and request_attempts = ${attempt.requestAttempts}`;
    },
    async failSync(idempotencyKey) {
      await sql`update event_sync_attempts set state = 'failed'
        where idempotency_key = ${idempotencyKey}::uuid and state = 'pending'`;
    },
    needsSync: async (eventKey) => {
      // A single-key eligibility check always answers an array, never a page.
      const eligibility = await staleKeys(eventKey);
      return (Array.isArray(eligibility) ? eligibility : eligibility.keys).length > 0;
    },
    async hasFailedSync(eventKey) {
      const rows = await sql`select 1${readMarker()} from event_sync_attempts rejected
        join events e on e.id = rejected.event_id
        where e.event_key = ${eventKey}
          and rejected.revision = e.sync_revision
          and rejected.state = 'failed' limit 1`;
      onSourceRead?.({
        statement: "failed_sync",
        rowCount: rows.length,
        readAt: markerOf(rows[0] as { preview_read_at?: unknown } | undefined),
      });
      return rows.length > 0;
    },
    async pendingSync(eventKey) {
      const [row] =
        await sql`select a.*, e.discord_event_id${readMarker()} from event_sync_attempts a join events e on e.id = a.event_id
        where e.event_key = ${eventKey} and a.state = 'pending'`;
      onSourceRead?.({
        statement: "pending_sync",
        rowCount: row ? 1 : 0,
        readAt: markerOf(row as { preview_read_at?: unknown } | undefined),
      });
      return row ? attemptFrom(row) : null;
    },
    async closeFinished(now) {
      const rows = await sql`update events set status = 'past', updated_at = ${now}
        where status = 'published' and ends_at <= ${now} returning id`;
      return rows.length;
    },
    async materializeSeries() {
      // Reconciliation owns the transaction/advisory lock. Do not begin a
      // nested transaction on its reserved postgres.js client.
      // pg-proxy avoids postgres-js Drizzle's global timestamp/JSON parser
      // mutation: snapshot/ledger queries on this client still need native types.
      const db = drizzle(
        async (query, params, _method, typings) => ({
          // Drizzle already JSON-encodes these parameters; native postgres.js
          // must receive the decoded value to avoid a JSON string audit payload.
          rows: await (sql as postgres.Sql)
            .unsafe(
              query,
              params.map((value, index) =>
                typings?.[index] === "json" && typeof value === "string"
                  ? JSON.parse(value)
                  : value,
              ) as never[],
            )
            .values(),
        }),
        { schema },
      );
      // Single-flight excludes other schedulers, not moderator edits. Acquire
      // the same parent row lock as updateEvent before reading occurrence times;
      // a waiting READ COMMITTED select returns the newly committed parent.
      const parents = await db
        .select()
        .from(schema.events)
        .where(
          and(
            isNotNull(schema.events.recurrenceFrequency),
            inArray(schema.events.status, ["draft", "published"]),
          ),
        )
        .orderBy(schema.events.id)
        .for("update");
      let created = 0;
      // The writer consumes returned rows only, not postgres-js result metadata.
      const writer = db as unknown as Parameters<typeof materializeMissingInstances>[0];
      for (const parent of parents) created += await materializeMissingInstances(writer, parent);
      return created;
    },
    staleEventKeys: (limit?: number) => staleKeys(null, limit),
  };
}
