// Admin store (W11). All moderator writes go through here — never a direct
// row write from a route. Ports:
// - EventService::create/update/publish/cancel (transitionTo: cancelled is
//   terminal; cancelled keeps its write-back because Discord was told).
// - FeaturedContent CRUD + delete (safe: nothing downstream refers to it).
// - spatie LogsActivity dirty-only audit on both resources (M7).
// - AccessRecorder one-row-per-request access log (M5).
//
// Pause/reopen and capacity edits share the RSVP service's event-row FOR UPDATE
// lock. Validation, edits and FIFO promotions commit together; routes dispatch
// write-back only after commit, with promoted answers' mirror stamps reset.

import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { EVENT_PAGE_SIZE, parseEventListQuery, type EventListParams } from "./event-list";
import { parseFeaturedListQuery } from "./table-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { nonSensitiveRead } from "../member-reads";
import {
  activityLog,
  events,
  featuredContents,
  memberDataAccessLogs,
  rsvps,
} from "../db/admin-schema";
import { occurrences, type RecurrenceInput } from "./recurrence";
import type { EventFormInput, EventStatus, FeaturedFormInput } from "./validation";
import { isMirrored, newEventKey, nextStatus, ValidationError } from "./validation";
import {
  CAPACITY_BELOW_GOING,
  goingCount,
  lockWaitlist,
  promoteWaitlist,
} from "../events/waitlist";

export type Actor = { id: string; username: string };

export type EventRow = typeof events.$inferSelect;
export type FeaturedRow = typeof featuredContents.$inferSelect;
export type FeaturedEditRow = FeaturedRow & {
  startsAtText: string | null;
  endsAtText: string | null;
};

// Date decoding loses imported microseconds and cannot represent infinity.
// Pin formatting to UTC independently of the connection's TimeZone/DateStyle.
// Keep BC visible so validation cannot mistake an unsupported era for AD.
const featuredEditSelection = {
  ...getTableColumns(featuredContents),
  startsAtText: sql<string | null>`CASE WHEN isfinite(${featuredContents.startsAt})
    THEN to_char(${featuredContents.startsAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
      || CASE WHEN EXTRACT(YEAR FROM ${featuredContents.startsAt} AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END
    ELSE ${featuredContents.startsAt}::text END`,
  endsAtText: sql<string | null>`CASE WHEN isfinite(${featuredContents.endsAt})
    THEN to_char(${featuredContents.endsAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
      || CASE WHEN EXTRACT(YEAR FROM ${featuredContents.endsAt} AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END
    ELSE ${featuredContents.endsAt}::text END`,
};

function featuredTimestamp(date: Date | null, text: string | null | undefined) {
  return text === undefined ? date : text === null ? null : sql`${text}::timestamptz`;
}

function featuredAuditValues({ startsAtText, endsAtText, ...row }: FeaturedEditRow) {
  return { ...row, startsAt: startsAtText, endsAt: endsAtText };
}

/** What the Discord write-back (W8 queue, W13 cron) must carry when it lands. */
export type WriteBack = { eventKey: string; status: EventStatus } | null;

const AUDIT_EXCLUDE = new Set(["discordEventId", "icsSequence"]);

function dirty<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (AUDIT_EXCLUDE.has(k)) continue;
    const b = before[k];
    const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : (x ?? null));
    if (JSON.stringify(norm(b)) !== JSON.stringify(norm(v)))
      out[k] = { before: norm(b), after: norm(v) };
  }
  return out;
}

async function audit(
  db: Pick<Db, "insert">,
  opts: {
    subjectType: string;
    subjectId: string;
    causerId: string | null;
    description: string;
    properties: Record<string, { before: unknown; after: unknown }>;
  },
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

export async function createEvent(
  db: Db,
  actor: Actor,
  input: EventFormInput,
  recurrence: RecurrenceInput | null = null,
): Promise<{ row: EventRow; writeBack: WriteBack }> {
  // Create-as-draft, always: the form never owns the status, and a draft is
  // never mirrored, so the write-back is a no-op by construction. A series is
  // one transaction (no half-series): the parent (index 1) and every
  // occurrence its rule names, all drafts.
  // The key is minted here, never taken from input: EventFormInput carries
  // no key field and parseEventForm refuses forged event_key/eventKey
  // (legacy EventKeyTest immutability).
  const row = await db.transaction(async (tx) => {
    const [parent] = await tx
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
        ...(recurrence
          ? {
              recurrenceFrequency: recurrence.frequency,
              recurrenceCount: recurrence.count,
              recurrenceEndsOn: recurrence.endsOn,
              recurrenceIndex: 1,
            }
          : {}),
      })
      .returning();
    if (!parent) throw new Error("event insert returned no row");
    if (recurrence) await materializeMissingInstances(tx, parent, actor.id);
    await audit(tx, {
      subjectType: "Event",
      subjectId: parent.eventKey,
      causerId: actor.id,
      description: `created event ${parent.title}`,
      properties: dirty({} as Record<string, unknown>, parent),
    });
    return parent;
  });
  return { row, writeBack: null };
}

type Writer = Pick<Db, "select" | "insert" | "update">;

/**
 * Create every occurrence the parent's rule names that has no row yet (index 1
 * is the parent itself, so it starts at 2). Ports
 * EventService::materializeMissingInstances.
 *
 * Idempotent by the (parent, index) pairs already in the table: a re-run
 * creates only what is missing and never touches an existing row, including one
 * a moderator cancelled to skip a week. Children start as drafts even under a
 * published parent, so extending a live series never announces a meeting a
 * moderator has not seen; a draft has no Discord write-back, so there is
 * nothing to enqueue here and the sync pass picks the row up once published.
 *
 * Run inside the caller's transaction so an occurrence and its creation audit
 * commit together. Cron has no moderator causer; create passes the actor id.
 *
 * @returns how many rows were created
 */
export async function materializeMissingInstances(
  db: Writer,
  parent: EventRow,
  causerId: string | null = null,
): Promise<number> {
  if (parent.recurrenceFrequency !== "weekly") return 0;
  const wanted = occurrences(
    parent.startsAt,
    parent.endsAt,
    parent.timezone,
    parent.recurrenceFrequency,
    parent.recurrenceCount,
    parent.recurrenceEndsOn,
  );
  const existing = new Set(
    (
      await db
        .select({ i: events.recurrenceIndex })
        .from(events)
        .where(eq(events.parentEventId, parent.id))
    ).map((r) => r.i),
  );
  let created = 0;
  for (const [index, when] of wanted) {
    if (index === 1 || existing.has(index)) continue;
    const [child] = await db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: parent.title,
        game: parent.game,
        description: parent.description,
        startsAt: when.startsAt,
        endsAt: when.endsAt,
        timezone: parent.timezone,
        location: parent.location,
        capacity: parent.capacity,
        status: "draft",
        createdBy: parent.createdBy,
        parentEventId: parent.id,
        recurrenceIndex: index,
      })
      .returning();
    if (!child) throw new Error("child event insert returned no row");
    await audit(db, {
      subjectType: "Event",
      subjectId: child.eventKey,
      causerId,
      description: `created event ${child.title}`,
      properties: dirty({} as Record<string, unknown>, child),
    });
    created++;
  }
  return created;
}

/**
 * The events:reconcile pass: top up every live series (draft or published
 * parent). A cancelled series stays cancelled and a finished one finished.
 * Serialised by the cron single-flight, so two passes never race the insert.
 */
export async function materializeRecurringSeries(db: Db): Promise<number> {
  const parents = await db
    .select()
    .from(events)
    .where(
      and(isNotNull(events.recurrenceFrequency), inArray(events.status, ["draft", "published"])),
    );
  let created = 0;
  for (const parent of parents)
    created += await db.transaction((tx) => materializeMissingInstances(tx, parent));
  return created;
}

export async function updateEvent(
  db: Db,
  actor: Actor,
  eventKey: string,
  input: EventFormInput,
): Promise<{ row: EventRow; writeBack: WriteBack; childWriteBacks: NonNullable<WriteBack>[] }> {
  return db.transaction(async (tx) => {
    // FOR UPDATE serialises RSVP allocation and concurrent parent edits so the
    // child shift below always sees the committed old times (no double-shift).
    const [locked] = await tx
      .select()
      .from(events)
      .where(eq(events.eventKey, eventKey))
      .for("update");
    if (!locked) throw new NotFoundError("event");
    if (input.capacity !== null) {
      const occupied = await goingCount(tx, locked.id);
      if (input.capacity < occupied) {
        throw new ValidationError({
          capacity: `${CAPACITY_BELOW_GOING} Occupied seats: ${occupied}.`,
        });
      }
    }
    // Closed field list: the key is addressed by, never written through,
    // this update (EventFormInput carries no key; forged keys never parse).
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
        // A moderator edit must invalidate an agent's full-field stale write.
        agentVersion: locked.agentGrantId === null ? locked.agentVersion : locked.agentVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(events.eventKey, eventKey))
      .returning();
    if (!row) throw new Error("event update returned no row");
    await promoteWaitlist(tx, row);
    const changes = dirty(
      locked as Record<string, unknown>,
      row as unknown as Record<string, unknown>,
    );
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
    const childWriteBacks = row.recurrenceFrequency
      ? await shiftFutureChildren(tx, actor, row, locked.startsAt, locked.endsAt)
      : [];
    const status = toEventStatus(row.status);
    return {
      row,
      writeBack: isMirrored(status) ? { eventKey: row.eventKey, status } : null,
      childWriteBacks,
    };
  });
}

/**
 * A parent whose times moved reprograms the future: children not yet started
 * shift by the same absolute delta (seconds, not wall arithmetic: DST-proof),
 * so the series stays weekly around the edit. Started or finished instances
 * keep their times. Returns the write-backs the shifted mirrored children owe.
 */
async function shiftFutureChildren(
  tx: Writer,
  actor: Actor,
  parent: EventRow,
  oldStartsAt: Date,
  oldEndsAt: Date,
): Promise<NonNullable<WriteBack>[]> {
  const startDelta = parent.startsAt.getTime() - oldStartsAt.getTime();
  const endDelta = parent.endsAt.getTime() - oldEndsAt.getTime();
  if (startDelta === 0 && endDelta === 0) return [];
  const children = await tx
    .select()
    .from(events)
    .where(and(eq(events.parentEventId, parent.id), gt(events.startsAt, new Date())))
    .for("update");
  const owed: NonNullable<WriteBack>[] = [];
  for (const child of children) {
    const [moved] = await tx
      .update(events)
      .set({
        startsAt: new Date(child.startsAt.getTime() + startDelta),
        endsAt: new Date(child.endsAt.getTime() + endDelta),
        agentVersion: child.agentGrantId === null ? child.agentVersion : child.agentVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(events.id, child.id))
      .returning();
    if (!moved) throw new Error("child reschedule returned no row");
    const changes = dirty(
      child as Record<string, unknown>,
      moved as unknown as Record<string, unknown>,
    );
    if (Object.keys(changes).length > 0) {
      await tx.insert(activityLog).values({
        logName: "default",
        description: `updated event ${moved.title}`,
        subjectType: "Event",
        subjectId: moved.eventKey,
        causerId: actor.id,
        properties: changes,
      });
    }
    const status = toEventStatus(child.status);
    if (isMirrored(status)) owed.push({ eventKey: child.eventKey, status });
  }
  return owed;
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
    // Share the ingress/RSVP row lock: judge the transition only after an
    // earlier writer commits, so publication cannot resurrect cancellation.
    const [locked] = await tx
      .select()
      .from(events)
      .where(eq(events.eventKey, eventKey))
      .for("update");
    if (!locked) throw new NotFoundError("event");
    const from = toEventStatus(locked.status);
    const target = nextStatus(from, to);
    // Judge persisted dates only after the lock wait. Equality is still legal
    // for publication (legacy's strict isPast boundary); cancellation is exempt.
    if (to === "published" && locked.endsAt.getTime() < Date.now()) {
      throw new ValidationError({
        ends_at: "An event that has already ended cannot be published. Update its dates first.",
      });
    }
    if (from === target) return { row: locked, writeBack: null };
    const [row] = await tx
      .update(events)
      .set({
        status: target,
        agentVersion: locked.agentGrantId === null ? locked.agentVersion : locked.agentVersion + 1,
        updatedAt: new Date(),
      })
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

/** Pause/reopen keeps the event published; only a changed flag needs a sync. */
export async function setRsvpOpen(
  db: Db,
  actor: Actor,
  eventKey: string,
  open: boolean,
  clock: () => Date = () => new Date(),
): Promise<{ row: EventRow; writeBack: WriteBack }> {
  return db.transaction(async (tx) => {
    // Share the RSVP writer's event lock. Check the clock after acquiring it,
    // so a wait that crosses the end cannot reopen an expired event.
    const [locked] = await tx
      .select()
      .from(events)
      .where(eq(events.eventKey, eventKey))
      .for("update");
    if (!locked) throw new NotFoundError("event");
    // A mirror-stamp writer can hold a waiter row past expiry. Finish that
    // promotion-row wait too before judging whether reopening is allowed.
    if (open && !locked.rsvpOpen && locked.status === "published")
      await lockWaitlist(tx, locked.id);
    const now = clock();
    if (locked.status !== "published" || locked.endsAt <= now) {
      throw new ValidationError({
        rsvp_open: "Only published events that have not ended can pause or reopen RSVPs.",
      });
    }
    if (locked.rsvpOpen === open) return { row: locked, writeBack: null };
    const [row] = await tx
      .update(events)
      .set({ rsvpOpen: open, updatedAt: now })
      .where(eq(events.eventKey, eventKey))
      .returning();
    if (!row) throw new Error("event RSVP toggle returned no row");
    // Withdrawals/capacity edits leave the line frozen while paused. Reopening
    // settles those vacancies in FIFO order before the same event sync is queued.
    if (open) await promoteWaitlist(tx, row, clock);
    await tx.insert(activityLog).values({
      logName: "default",
      description: `${open ? "reopened" : "paused"} RSVPs for event ${row.title}`,
      subjectType: "Event",
      subjectId: row.eventKey,
      causerId: actor.id,
      properties: { rsvpOpen: { before: locked.rsvpOpen, after: open } },
    });
    return { row, writeBack: { eventKey: row.eventKey, status: "published" } };
  });
}

export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

/** One admin list row: the event plus its Going-only seat count. */
export type EventListRow = EventRow & { goingCount: number };

/** Fetch one extra row so pagination needs no separate count query. */
export async function listEvents(db: Db, params: EventListParams): Promise<EventListRow[]> {
  const opts = parseEventListQuery(params);
  const conds: (SQL | undefined)[] = [];
  if (opts.q) conds.push(ilike(events.title, `%${escapeLikeTerm(opts.q)}%`));
  if (opts.status) conds.push(eq(events.status, opts.status));
  if (opts.rsvp_open !== "") conds.push(eq(events.rsvpOpen, opts.rsvp_open === "1"));
  if (opts.series === "parent")
    conds.push(and(isNull(events.parentEventId), isNotNull(events.recurrenceFrequency)));
  if (opts.series === "child") conds.push(isNotNull(events.parentEventId));
  if (opts.series === "standalone")
    conds.push(and(isNull(events.parentEventId), isNull(events.recurrenceFrequency)));
  if (opts.fill === "unlimited") conds.push(isNull(events.capacity));
  if (opts.fill === "full" || opts.fill === "has_seats") {
    // Only Going occupies a seat: Maybe and Waitlist never make an event full.
    const going = db
      .select({ count: sql<number>`count(*)` })
      .from(rsvps)
      .where(and(eq(rsvps.eventId, events.id), eq(rsvps.status, "going")));
    conds.push(isNotNull(events.capacity));
    conds.push(
      opts.fill === "full"
        ? sql`(${going}) >= ${events.capacity}`
        : sql`(${going}) < ${events.capacity}`,
    );
  }
  // Pick real column objects, never an identifier interpolated from the URL.
  const column =
    opts.sort === "title" ? events.title : opts.sort === "status" ? events.status : events.startsAt;
  const order = opts.order === "asc" ? asc(column) : desc(column);
  const rows = await nonSensitiveRead("events", () =>
    db
      .select()
      .from(events)
      .where(and(...conds))
      .orderBy(order, asc(events.id))
      .limit(EVENT_PAGE_SIZE + 1)
      .offset((opts.page - 1) * EVENT_PAGE_SIZE),
  );
  if (rows.length === 0) return [];
  // Going-only seat counts for the rendered Fill column (same rule as the
  // fill filter: Maybe/Waitlist/Not going never occupy a seat). One
  // classified aggregate read, like the public withGoing helper — a second
  // non-sensitive statement, not member subjects.
  const counts = await nonSensitiveRead("going-counts", () =>
    db
      .select({ eventId: rsvps.eventId, n: count() })
      .from(rsvps)
      .where(
        and(
          inArray(
            rsvps.eventId,
            rows.map((r) => r.id),
          ),
          eq(rsvps.status, "going"),
        ),
      )
      .groupBy(rsvps.eventId),
  );
  const by = new Map(counts.map((c) => [c.eventId, Number(c.n)]));
  return rows.map((r) => ({ ...r, goingCount: by.get(r.id) ?? 0 }));
}

export async function getEvent(db: Db, eventKey: string): Promise<EventRow | null> {
  const [row] = await nonSensitiveRead("events", () =>
    db.select().from(events).where(eq(events.eventKey, eventKey)),
  );
  return row ?? null;
}

// There is deliberately no deleteEvent: a published event was announced, and
// the audit trail of a cancellation is the record that it was (legacy
// EventsTable: "no delete anywhere on this resource").

export async function createFeatured(
  db: Db,
  actor: Actor,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(featuredContents)
      .values({
        title: input.title,
        body: input.body,
        url: input.url,
        imageUrl: input.imageUrl,
        imageAlt: input.imageAlt,
        isPublished: input.isPublished,
        position: input.position,
        startsAt: featuredTimestamp(input.startsAtUtc, input.startsAtUtcText),
        endsAt: featuredTimestamp(input.endsAtUtc, input.endsAtUtcText),
        createdBy: actor.id,
      })
      .returning(featuredEditSelection);
    if (!row) throw new Error("featured insert returned no row");
    await audit(tx, {
      subjectType: "FeaturedContent",
      subjectId: String(row.id),
      causerId: actor.id,
      description: `created featured content ${row.title}`,
      properties: dirty({} as Record<string, unknown>, featuredAuditValues(row)),
    });
    return row;
  });
}

export async function updateFeatured(
  db: Db,
  actor: Actor,
  id: number,
  input: FeaturedFormInput,
): Promise<FeaturedRow> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select(featuredEditSelection)
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
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
        startsAt: featuredTimestamp(input.startsAtUtc, input.startsAtUtcText),
        endsAt: featuredTimestamp(input.endsAtUtc, input.endsAtUtcText),
        updatedAt: new Date(),
      })
      .where(eq(featuredContents.id, id))
      .returning(featuredEditSelection);
    if (!row) throw new Error("featured update returned no row");
    const changes = dirty(featuredAuditValues(locked), featuredAuditValues(row));
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
    const [locked] = await tx
      .select()
      .from(featuredContents)
      .where(eq(featuredContents.id, id))
      .for("update");
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

export async function listFeatured(
  db: Db,
  opts: { published?: boolean; q?: string; sort?: string; order?: string },
): Promise<FeaturedRow[]> {
  const query = parseFeaturedListQuery({ q: opts.q, sort: opts.sort, order: opts.order });
  const conds: SQL[] = [];
  if (opts.published !== undefined) conds.push(eq(featuredContents.isPublished, opts.published));
  if (query.q) conds.push(ilike(featuredContents.title, `%${escapeLikeTerm(query.q)}%`));
  const column =
    query.sort === "updated_at" ? featuredContents.updatedAt : featuredContents.position;
  const order = query.order === "desc" ? desc(column) : asc(column);
  return nonSensitiveRead("featured", () =>
    db
      .select()
      .from(featuredContents)
      .where(and(...conds))
      .orderBy(order, asc(featuredContents.id)),
  );
}

/** Imported source IDs are independent of native IDs; never fall back to a native match. */
export async function getFeaturedIdByLegacyId(db: Db, legacyId: string): Promise<number | null> {
  const [row] = await nonSensitiveRead("featured", () =>
    db
      .select({ id: featuredContents.id })
      .from(featuredContents)
      .where(eq(featuredContents.legacyId, legacyId)),
  );
  return row?.id ?? null;
}

export async function getFeatured(db: Db, id: number): Promise<FeaturedEditRow | null> {
  const [row] = await nonSensitiveRead("featured", () =>
    db.select(featuredEditSelection).from(featuredContents).where(eq(featuredContents.id, id)),
  );
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
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS member_data_access_logs_subject_user_ids_gin ON member_data_access_logs USING gin (subject_user_ids jsonb_path_ops)`,
    ),
  );
}
