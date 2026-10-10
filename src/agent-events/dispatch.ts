import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { events } from "../db/admin-schema";
import { CAPACITY_BELOW_GOING, goingCount, promoteWaitlist } from "../events/waitlist";
import { utcToWall, wallToUtc, type EventStatus } from "../admin/validation";
import type { WriteBack } from "../admin/store";
import { observeDiscordEvent, type ObservationEvent } from "../bot/event-read";
import type { Grant, IngressEffects, Op, Outcome, Row, Tx } from "./types";
import { storedEventKey, ulid, validateFields } from "./payload";
import { audit } from "./audit";
import { checkGrant } from "./grants";

const rid = (requestId: string) => ({ request_id: requestId });

export async function execute(
  tx: Tx,
  grant: Grant,
  op: Op,
  doc: Record<string, unknown>,
  key: string,
  dig: string,
  requestId: string,
  effects: IngressEffects,
): Promise<Outcome> {
  const denyOutcome = async (
    status: number,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
    eventKey: string | null = null,
  ): Promise<Outcome> => {
    await audit(tx, grant, op, eventKey, key, dig, requestId, "denied", reason);
    return { status, body: { reason, message, ...extra, ...rid(requestId) } };
  };
  const done = async (
    status: number,
    body: Record<string, unknown>,
    eventKey: string,
    writeBack?: NonNullable<WriteBack>,
  ): Promise<Outcome> => {
    await audit(tx, grant, op, eventKey, key, dig, requestId, "ok", null);
    return { status, body: { ...body, ...rid(requestId) }, eventKey, stored: true, writeBack };
  };

  if (op === "create") {
    // The final admission lock follows the operation/event locks, never precedes
    // an event-row wait (main #215). Only the table name changed here: the
    // shared `events` rows carry the agent ownership columns, not the retired
    // standalone table.
    const refusedCreate = await checkGrant(tx, grant, op, key, dig, requestId, null, true);
    if (refusedCreate) return refusedCreate;
    const [existing] = await tx`SELECT event_key FROM events WHERE agent_grant_id = ${grant.id}`;
    if (existing)
      return denyOutcome(
        409,
        "quota_exceeded",
        "This grant already owns its one proof event. Updates reuse it.",
        { event_key: existing.event_key },
      );
    const v = validateFields(doc.fields);
    if (!v.ok)
      return denyOutcome(422, "validation_failed", "The event fields did not validate.", {
        errors: v.errors,
      });
    const f = v.fields;
    const eventKey = ulid();
    const marker = `agent-proof-${ulid()}`;
    await tx`INSERT INTO events (event_key, agent_grant_id, proof_marker, title, game, description, starts_at, ends_at, timezone, location, capacity)
             VALUES (${eventKey}, ${grant.id}, ${marker}, ${f.title}, ${f.game}, ${f.description}, ${wallToUtc(f.starts_at, f.timezone).toISOString()}, ${wallToUtc(f.ends_at, f.timezone).toISOString()}, ${f.timezone}, ${f.location}, ${f.capacity})`;
    return done(
      201,
      { event_key: eventKey, status: "draft", agent_version: 1, proof_marker: marker },
      eventKey,
    );
  }

  const keyIn = doc.event_key;
  const event = await ownedEvent(tx, grant, keyIn);
  const refused = await checkGrant(
    tx,
    grant,
    op,
    key,
    dig,
    requestId,
    typeof event === "string" ? storedEventKey(keyIn) : event.event_key,
    true,
  );
  if (refused) return refused;
  if (typeof event === "string") {
    return denyOutcome(
      event === "foreign_event" ? 403 : 404,
      event,
      event === "foreign_event"
        ? "That event is not owned by this grant."
        : "This grant owns no such event.",
      {},
      typeof keyIn === "string" ? keyIn : null,
    );
  }
  const ek = event.event_key as string;

  if (op === "read") {
    const [{ n }] =
      (await tx`SELECT count(*)::int AS n FROM events WHERE agent_grant_id = ${grant.id}`) as [
        { n: number },
      ];
    // The bounded window (two-web AgentEventReceiptWindowTest): the latest 50,
    // oldest first. Newest-first then reversed — LIMIT applies before the flip.
    const newest =
      await tx`SELECT operation, result, reason_code, request_id, created_at FROM agent_event_audits WHERE grant_id = ${grant.id} AND event_key = ${ek} ORDER BY id DESC LIMIT 50`;
    const receipts = [...newest].reverse();
    return done(
      200,
      {
        event: proofFields(event),
        local: { status: event.status, synced_to_discord: event.discord_event_id !== null },
        discord: await observeDiscordEvent(event as ObservationEvent, effects.readEvent),
        owned_event_count: n,
        proof_marker_matches: 1,
        receipts: receipts.map((r) => ({
          operation: r.operation,
          result: r.result,
          reason_code: r.reason_code,
          request_id: r.request_id,
          at: new Date(r.created_at).toISOString(),
        })),
      },
      ek,
    );
  }

  if (op === "update") {
    if (!Number.isInteger(doc.version))
      return denyOutcome(
        422,
        "validation_failed",
        "An update needs the integer `version` last seen on a read.",
        {},
        ek,
      );
    if (event.status === "cancelled")
      return denyOutcome(409, "event_not_open", "That event is not open for this move.", {}, ek);
    const v = validateFields(doc.fields);
    if (!v.ok)
      return denyOutcome(
        422,
        "validation_failed",
        "The event fields did not validate.",
        { errors: v.errors },
        ek,
      );
    const f = v.fields;
    // Reuse the shared seat rules on this already-open raw transaction; a
    // postgres TransactionSql has no client options for postgres-js drizzle().
    const orm = drizzle(async (query, params) => ({
      rows: await tx.unsafe(query, params as never).values(),
    }));
    if (f.capacity !== null && f.capacity < (await goingCount(orm, event.id))) {
      return denyOutcome(
        422,
        "validation_failed",
        "The event fields did not validate.",
        { errors: { capacity: [CAPACITY_BELOW_GOING] } },
        ek,
      );
    }
    const startsAt = updatedInstant(f.starts_at, f.timezone, event.starts_at, event.timezone);
    const endsAt = updatedInstant(f.ends_at, f.timezone, event.ends_at, event.timezone);
    if (endsAt <= startsAt) {
      return denyOutcome(
        422,
        "validation_failed",
        "The event fields did not validate.",
        { errors: { ends_at: ["The ends_at field must be a date after starts_at."] } },
        ek,
      );
    }
    const [u] =
      await tx`UPDATE events SET title=${f.title}, game=${f.game}, description=${f.description}, starts_at=${startsAt.toISOString()}, ends_at=${endsAt.toISOString()},
                         timezone=${f.timezone}, location=${f.location}, capacity=${f.capacity}, agent_version = agent_version + 1, updated_at = now()
                         WHERE event_key = ${ek} AND agent_version = ${doc.version as number} RETURNING status, agent_version`;
    if (!u)
      return denyOutcome(
        409,
        "stale_version",
        "The event changed since that version. Re-read and retry.",
        { agent_version: event.agent_version },
        ek,
      );
    const [updated] = await orm.select().from(events).where(eq(events.id, event.id));
    await promoteWaitlist(orm, updated!);
    return done(
      200,
      { event_key: ek, status: u.status, agent_version: u.agent_version },
      ek,
      writeBackFor(ek, u.status),
    );
  }

  // publish / cancel: cancelled stays terminal.
  const ok = op === "publish" ? event.status === "draft" : event.status !== "cancelled";
  if (!ok)
    return denyOutcome(
      409,
      "event_not_open",
      "That event is not in a position to make this move.",
      {},
      ek,
    );
  const next = op === "publish" ? "published" : "cancelled";
  await tx`UPDATE events SET status = ${next}, updated_at = now() WHERE event_key = ${ek}`;
  return done(200, { event_key: ek, status: next }, ek, writeBackFor(ek, next));
}

// An explicit event_key addresses that event; omitted, the grant's single owned event answers.
// Unknown key is 404; known-but-not-mine is 403. Row-locked so the answer is the latest state.
async function ownedEvent(
  tx: Tx,
  grant: Grant,
  key: unknown,
): Promise<Row | "event_not_found" | "foreign_event"> {
  if (key === undefined || key === null) {
    const [owned] = await tx`SELECT * FROM events WHERE agent_grant_id = ${grant.id} FOR UPDATE`;
    return owned ?? "event_not_found";
  }
  const keyIn = storedEventKey(key);
  if (keyIn === null) return "event_not_found";
  const [event] = await tx`SELECT * FROM events WHERE event_key = ${keyIn} FOR UPDATE`;
  if (!event) return "event_not_found";
  return event.agent_grant_id === grant.id ? event : "foreign_event";
}

// Only proof-owned fields cross this boundary.
const proofFields = (e: Row) => ({
  event_key: e.event_key,
  title: e.title,
  game: e.game,
  description: e.description,
  starts_at: utcToWall(new Date(e.starts_at), e.timezone),
  ends_at: utcToWall(new Date(e.ends_at), e.timezone),
  timezone: e.timezone,
  location: e.location,
  capacity: e.capacity,
  status: e.status,
  agent_version: e.agent_version,
  proof_marker: e.proof_marker,
  discord_event_id: e.discord_event_id,
});

// Read speaks minute-precision wall text, not an offset. An unchanged endpoint
// and zone must keep the exact instant, including a migrated second fold.
function updatedInstant(
  wall: string,
  timezone: string,
  stored: Date | string,
  storedTimezone: string,
): Date {
  const previous = new Date(stored);
  return timezone === storedTimezone && wall === utcToWall(previous, timezone)
    ? previous
    : wallToUtc(wall, timezone);
}

function writeBackFor(eventKey: string, status: EventStatus): NonNullable<WriteBack> | undefined {
  return status === "published" || status === "cancelled" ? { eventKey, status } : undefined;
}
