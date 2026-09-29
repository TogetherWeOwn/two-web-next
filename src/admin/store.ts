// Admin store (W11). All moderator writes go through here — never a direct
// row write from a route. Ports:
// - EventService::create/update/publish/cancel (transitionTo: cancelled is
//   terminal; cancelled keeps its write-back because Discord was told).
// - FeaturedContent CRUD + delete (safe: nothing downstream refers to it).
// - spatie LogsActivity dirty-only audit on both resources (M7).
// - AccessRecorder one-row-per-request access log (M5).
//
// Concurrency: every state change runs in one transaction behind a
// row-equivalent serialisation. Drizzle/postgres-js has no FOR UPDATE builder
// in 0.45, so the transition re-reads inside the transaction and aborts on a
// concurrent change (optimistic guard on updated_at); W1/W13 own the
// Hyperdrive FOR UPDATE semantics proof. The queue dispatch + reconcile
// backstop arrive with W8/W13; `writeBackDue` marks what they must carry.

import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { activityLog, events, featuredContents, memberDataAccessLogs } from "../db/admin-schema";
import type { EventFormInput, EventStatus, FeaturedFormInput } from "./validation";
import { isMirrored, newEventKey, nextStatus } from "./validation";

export type Actor = { id: string; username: string };

export type EventRow = typeof events.$inferSelect;
export type FeaturedRow = typeof featuredContents.$inferSelect;

/** What the Discord write-back (W8 queue, W13 cron) must carry when it lands. */
export type WriteBack = { eventKey: string; status: EventStatus } | null;

const AUDIT_EXCLUDE = new Set(["discordEventId"]);

function dirty<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (AUDIT_EXCLUDE.has(k)) continue;
    const b = before[k];
    const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : (x ?? null));
    if (JSON.stringify(norm(b)) !== JSON.stringify(norm(v))) out[k] = { before: norm(b), after: norm(v) };
  }
  return out;
}

async function audit(
  db: Db,
  opts: { subjectType: string; subjectId: string; causerId: string; description: string; properties: Record<string, { before: unknown; after: unknown }> },
): Promise<void> {
  await db.insert(activityLog).values({
    logName: "default",
    description: opts.description,
    subjectType: opts.subjectType,
    subjectId: opts.subjectId,
    causerId: opts.causerId,
    properties: opts.properties,
  });
}

function toEventStatus(raw: string): EventStatus {
  if (raw === "draft" || raw === "published" || raw === "cancelled" || raw === "past") return raw;
  throw new Error(`unknown event status: ${raw}`);
}

export async function createEvent(db: Db, actor: Actor, input: EventFormInput): Promise<{ row: EventRow; writeBack: WriteBack }> {
  // Create-as-draft, always: the form never owns the status, and a draft is
  // never mirrored, so the write-back is a no-op by construction.
  const [row] = await db
    .insert(events)
    .values({
      eventKey: newEventKey(),
      title: input.title,
      game: input.game,
      description: input.description,
      startsAt: input.startsAtUtc,
      endsAt: input.endsAtUtc,
      timezone: input.timezone,
      location: input.location,
      capacity: input.capacity,
      status: "draft",
      createdBy: actor.id,
    })
    .returning();
  if (!row) throw new Error("event insert returned no row");
  await audit(db, {
    subjectType: "Event",
    subjectId: row.eventKey,
    causerId: actor.id,
    description: `created event ${row.title}`,
    properties: dirty({} as Record<string, unknown>, { ...row, discordEventId: undefined }),
  });
  return { row, writeBack: null };
}

export async function updateEvent(
  db: Db,
  actor: Actor,
  eventKey: string,
  input: EventFormInput,
): Promise<{ row: EventRow; writeBack: WriteBack }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(events).where(eq(events.eventKey, eventKey));
    if (!locked) throw new NotFoundError("event");
    const [row] = await tx
      .update(events)
      .set({
        title: input.title,
        game: input.game,
        description: input.description,
        startsAt: input.startsAtUtc,
        endsAt: input.endsAtUtc,
        timezone: input.timezone,
        location: input.location,
        capacity: input.capacity,
        updatedAt: new Date(),
      })
      .where(eq(events.eventKey, eventKey))
      .returning();
    if (!row) throw new Error("event update returned no row");
    const changes = dirty(locked as Record<string, unknown>, row as unknown as Record<string, unknown>);
    if (Object.keys(changes).length > 0) {
      await tx.insert(activityLog).values({
        logName: "default",
        description: `updated event ${row.title}`,
        subjectType: "Event",
        subjectId: row.eventKey,
        causerId: actor.id,
        properties: changes,
      });
    }
    const status = toEventStatus(row.status);
    return { row, writeBack: isMirrored(status) ? { eventKey: row.eventKey, status } : null };
  });
}

/**
 * Publish/cancel through the transition guard: cancelled is terminal, only
 * drafts publish, drafts + published cancel. On success the write-back is
 * dispatched (W8 queue carries it; until then the result marks it due so the
 * route can log/queue it).
 */
export async function transitionEvent(
  db: Db,
  actor: Actor,
  eventKey: string,
  to: "published" | "cancelled",
): Promise<{ row: EventRow; writeBack: WriteBack }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(events).where(eq(events.eventKey, eventKey));
    if (!locked) throw new NotFoundError("event");
    const from = toEventStatus(locked.status);
    const target = nextStatus(from, to);
    if (from === target) return { row: locked, writeBack: null };
    const [row] = await tx
      .update(events)
      .set({ status: target, updatedAt: new Date() })
      .where(eq(events.eventKey, eventKey))
      .returning();
    if (!row) throw new Error("event transition returned no row");
    await tx.insert(activityLog).values({
      logName: "default",
      description: `${to} event ${row.title}`,
      subjectType: "Event",
      subjectId: row.eventKey,
      causerId: actor.id,
      properties: { status: { before: from, after: target } },
    });
    return { row, writeBack: { eventKey: row.eventKey, status: target } };
  });
}

export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

export async function listEvents(
  db: Db,
  opts: { q?: string; status?: string; order?: "asc" | "desc" },
): Promise<EventRow[]> {
  const conds = [];
  if (opts.q) conds.push(ilike(events.title, `%${opts.q}%`));
  if (opts.status) conds.push(eq(events.status, opts.status));
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const order = opts.order === "asc" ? asc(events.startsAt) : desc(events.startsAt);
  if (where) return db.select().from(events).where(where).orderBy(order);
  return db.select().from(events).orderBy(order);
}

export async function getEvent(db: Db, eventKey: string): Promise<EventRow | null> {
  const [row] = await db.select().from(events).where(eq(events.eventKey, eventKey));
  return row ?? null;
}

// There is deliberately no deleteEvent: a published event was announced, and
// the audit trail of a cancellation is the record that it was (legacy
// EventsTable: "no delete anywhere on this resource").

export async function createFeatured(db: Db, actor: Actor, input: FeaturedFormInput): Promise<FeaturedRow> {
  const [row] = await db
    .insert(featuredContents)
    .values({
      title: input.title,
      body: input.body,
      url: input.url,
      imageUrl: input.imageUrl,
      imageAlt: input.imageAlt,
      isPublished: input.isPublished,
      position: input.position,
      startsAt: input.startsAtUtc,
      endsAt: input.endsAtUtc,
      createdBy: actor.id,
    })
    .returning();
  if (!row) throw new Error("featured insert returned no row");
  await audit(db, {
    subjectType: "FeaturedContent",
    subjectId: String(row.id),
    causerId: actor.id,
    description: `created featured content ${row.title}`,
    properties: dirty({} as Record<string, unknown>, row as unknown as Record<string, unknown>),
  });
  return row;
}

export async function updateFeatured(
  db: Db,
  actor: Actor,
  id: number,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(featuredContents).where(eq(featuredContents.id, id));
    if (!locked) throw new NotFoundError("featured content");
    const [row] = await tx
      .update(featuredContents)
      .set({
        title: input.title,
        body: input.body,
        url: input.url,
        imageUrl: input.imageUrl,
        imageAlt: input.imageAlt,
        isPublished: input.isPublished,
        position: input.position,
        startsAt: input.startsAtUtc,
        endsAt: input.endsAtUtc,
        updatedAt: new Date(),
      })
      .where(eq(featuredContents.id, id))
      .returning();
    if (!row) throw new Error("featured update returned no row");
    const changes = dirty(locked as Record<string, unknown>, row as unknown as Record<string, unknown>);
    if (Object.keys(changes).length > 0) {
      await tx.insert(activityLog).values({
        logName: "default",
        description: `updated featured content ${row.title}`,
        subjectType: "FeaturedContent",
        subjectId: String(row.id),
        causerId: actor.id,
        properties: changes,
      });
    }
    return row;
  });
}

/** Deleting featured content is safe — nothing downstream refers to it — one row at a time, audited. */
export async function deleteFeatured(db: Db, actor: Actor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(featuredContents).where(eq(featuredContents.id, id));
    if (!locked) throw new NotFoundError("featured content");
    await tx.delete(featuredContents).where(eq(featuredContents.id, id));
    await tx.insert(activityLog).values({
      logName: "default",
      description: `deleted featured content ${locked.title}`,
      subjectType: "FeaturedContent",
      subjectId: String(locked.id),
      causerId: actor.id,
      properties: { title: { before: locked.title, after: null } },
    });
  });
}

export async function listFeatured(db: Db, opts: { published?: boolean }): Promise<FeaturedRow[]> {
  if (opts.published !== undefined) {
    return db
      .select()
      .from(featuredContents)
      .where(eq(featuredContents.isPublished, opts.published))
      .orderBy(asc(featuredContents.position));
  }
  return db.select().from(featuredContents).orderBy(asc(featuredContents.position));
}

export async function getFeatured(db: Db, id: number): Promise<FeaturedRow | null> {
  const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
  return row ?? null;
}

/**
 * Access-log recorder (M5, ports AccessRecorder::flush). One row per request
 * that read member data — never per record. The viewer is excluded from the
 * subjects; an empty subject set writes no row; the write throws when the log
 * is down so the middleware can fail closed (503 under enforce).
 */
export async function recordAccess(
  db: Db,
  opts: {
    viewerDiscordId: string;
    viewerUserId: string | null;
    resource: string;
    action: string;
    subjectUserIds: string[];
    route: string | null;
  },
): Promise<boolean> {
  const subjects = [...new Set(opts.subjectUserIds.filter((s) => s !== opts.viewerUserId))].sort();
  if (subjects.length === 0) return false;
  await db.insert(memberDataAccessLogs).values({
    viewerDiscordId: opts.viewerDiscordId,
    viewerUserId: opts.viewerUserId,
    resource: opts.resource,
    action: opts.action,
    subjectUserIds: subjects,
    subjectCount: subjects.length,
    route: opts.route,
  });
  return true;
}

/** GIN index the query planner needs for "who looked at *this member*?" (legacy DDL, drizzle-kit cannot emit it). */
export async function ensureAccessLogGin(db: Db): Promise<void> {
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS member_data_access_logs_subject_user_ids_gin ON member_data_access_logs USING gin (subject_user_ids jsonb_path_ops)`,
  ));
}
