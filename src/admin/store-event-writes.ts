// Event-write leaves of the admin store (W11). Pure move out of `./store`:
// every moderator event mutation behind the shared event-row FOR UPDATE lock
// (create/update/publish/cancel, pause/reopen, capacity floor, recurrence
// materialization). `./store` re-exports every name below, so all existing
// importers keep working untouched.

import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/index";
import { activityLog, events } from "../db/admin-schema";
import { occurrences, type RecurrenceInput } from "./recurrence";
import type { EventFormInput, EventStatus } from "./validation";
import {
  isKnownTimezone,
  isMirrored,
  newEventKey,
  nextStatus,
  parseEventForm,
  utcToWall,
  ValidationError,
} from "./validation";
import {
  CAPACITY_BELOW_GOING,
  goingCount,
  lockWaitlist,
  promoteWaitlist,
} from "../events/waitlist";
import { retireAnonEventCaches } from "../events/anon-cache";
import { retireHomeGuestCache } from "../home-cache";
import { audit, dirty, NotFoundError, type Actor } from "./store-shared";

export type EventRow = typeof events.$inferSelect;

/** What the Discord write-back (W8 queue, W13 cron) must carry when it lands. */
export type WriteBack = { eventKey: string; status: EventStatus } | null;

function toEventStatus(raw: string): EventStatus {
  if (raw === "draft" || raw === "published" || raw === "cancelled" || raw === "past") return raw;
  throw new Error(`unknown event status: ${raw}`);
}

const LOCATION_REQUIRED = "Add a location before publishing.";

function isBlankLocation(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
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
  // Committed: a new event can appear on the calendar once published, so the
  // anonymous entries retire here too (N6), never on a throw above.
  retireAnonEventCaches();
  await retireHomeGuestCache();
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
  const result: { row: EventRow; writeBack: WriteBack; childWriteBacks: NonNullable<WriteBack>[] } =
    await db.transaction(async (tx) => {
      // FOR UPDATE serialises RSVP allocation and concurrent parent edits so the
      // child shift below always sees the committed old times (no double-shift).
      const [locked] = await tx
        .select()
        .from(events)
        .where(eq(events.eventKey, eventKey))
        .for("update");
      if (!locked) throw new NotFoundError("event");
      return commitLockedUpdate(tx, actor, eventKey, locked, input);
    });
  // Committed: the edit is visible to guests on the next fetch (N6).
  retireAnonEventCaches();
  await retireHomeGuestCache();
  return result;
}

export type PatchBase = Pick<
  EventRow,
  "title" | "game" | "description" | "timezone" | "location" | "capacity" | "startsAt" | "endsAt"
>;

/**
 * Pure PATCH admission + merge: omitted fields resolve from `base` (in
 * production the locked row inside the committing transaction, in hermetic
 * tests the fixture row), never from a pre-lock snapshot. Two overlapping
 * disjoint edits therefore preserve both changes: the later writer merges
 * against the earlier writer's committed row, and an omitted fold instant
 * keeps its exact stored UTC instant via the locked carriers.
 */
export function mergePatchInput(base: PatchBase, patch: Record<string, unknown>): EventFormInput {
  const merged = {
    title: base.title,
    game: base.game,
    description: base.description,
    timezone: base.timezone,
    location: base.location,
    capacity: base.capacity,
    ...patch,
  } as Record<string, unknown>;
  // Match parseEventForm's zone default before deriving omitted wall times.
  const tz =
    typeof merged.timezone === "string"
      ? merged.timezone.trim() || "Europe/London"
      : "Europe/London";
  if (!isKnownTimezone(tz)) throw new ValidationError({ timezone: `Unknown timezone: ${tz}.` });
  merged.starts_at ??= utcToWall(base.startsAt, tz);
  merged.ends_at ??= utcToWall(base.endsAt, tz);
  return parseEventForm(merged, {
    startsAtUtc: base.startsAt.toISOString(),
    endsAtUtc: base.endsAt.toISOString(),
  });
}

/**
 * Partial JSON PATCH: omitted fields resolve from the locked row inside the
 * same transaction that commits the update, never from a pre-lock snapshot.
 * Full-form admin semantics are untouched (updateEvent still takes a complete
 * EventFormInput).
 */
export async function patchEvent(
  db: Db,
  actor: Actor,
  eventKey: string,
  patch: Record<string, unknown>,
): Promise<{ row: EventRow; writeBack: WriteBack; childWriteBacks: NonNullable<WriteBack>[] }> {
  const result: { row: EventRow; writeBack: WriteBack; childWriteBacks: NonNullable<WriteBack>[] } =
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(events)
        .where(eq(events.eventKey, eventKey))
        .for("update");
      if (!locked) throw new NotFoundError("event");
      return commitLockedUpdate(tx, actor, eventKey, locked, mergePatchInput(locked, patch));
    });
  // Committed: same retirement point as updateEvent, only after success.
  retireAnonEventCaches();
  await retireHomeGuestCache();
  return result;
}

async function commitLockedUpdate(
  tx: Writer,
  actor: Actor,
  eventKey: string,
  locked: EventRow,
  input: EventFormInput,
): Promise<{ row: EventRow; writeBack: WriteBack; childWriteBacks: NonNullable<WriteBack>[] }> {
  if (input.capacity !== null) {
    const occupied = await goingCount(tx, locked.id);
    if (input.capacity < occupied) {
      throw new ValidationError({
        capacity: `${CAPACITY_BELOW_GOING} Occupied seats: ${occupied}.`,
      });
    }
  }
  // A published row must keep a non-blank location (bot upsert contract):
  // drafts may stay blank, but an edit that would leave a published event
  // without one is refused under the same row lock, so no route can bypass it.
  if (toEventStatus(locked.status) === "published" && isBlankLocation(input.location)) {
    throw new ValidationError({ location: LOCATION_REQUIRED });
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
  const lockedChildren = await tx
    .select()
    .from(events)
    .where(and(eq(events.parentEventId, parent.id), gt(events.startsAt, new Date())))
    .for("update");
  // The query's cutoff predates any lock wait. Judge eligibility once after
  // all child locks are held, for both validation and every reschedule effect.
  const now = Date.now();
  const children = lockedChildren.filter((child) => child.startsAt.getTime() > now);
  // A parent delta must never invert (or zero) a future occurrence the
  // moderator shortened individually: refuse the whole edit with the existing
  // ends_at response before any child write, so the surrounding transaction
  // rolls the parent, audit and waitlist writes back atomically.
  for (const child of children) {
    const proposedStart = child.startsAt.getTime() + startDelta;
    const proposedEnd = child.endsAt.getTime() + endDelta;
    if (proposedEnd <= proposedStart) {
      throw new ValidationError({ ends_at: "The end is after the start." });
    }
  }
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
  const result: { row: EventRow; writeBack: WriteBack } = await db.transaction(async (tx) => {
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
    // Publishing needs a non-blank location (bot upsert + ingress contract):
    // judged here under the row lock so no moderator route can bypass the
    // form. The agent ingress guards its own publish path in dispatch.ts.
    // Drafts may stay blank; cancellation is exempt.
    if (to === "published" && isBlankLocation(locked.location)) {
      throw new ValidationError({ location: LOCATION_REQUIRED });
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
  // Committed: publish/cancel moves the row between guest views (N6).
  retireAnonEventCaches();
  await retireHomeGuestCache();
  return result;
}

/** Pause/reopen keeps the event published; only a changed flag needs a sync. */
export async function setRsvpOpen(
  db: Db,
  actor: Actor,
  eventKey: string,
  open: boolean,
  clock: () => Date = () => new Date(),
): Promise<{ row: EventRow; writeBack: WriteBack }> {
  const result: { row: EventRow; writeBack: WriteBack } = await db.transaction(async (tx) => {
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
  // Committed: pausing/reopening can settle the waitlist line (N6).
  retireAnonEventCaches();
  await retireHomeGuestCache();
  return result;
}
