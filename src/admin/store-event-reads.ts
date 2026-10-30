// Event-read leaves of the admin store (W11). Pure move out of `./store`:
// the admin list read plus its Going-only seat counts, and the single-event
// read. `./store` re-exports every name below, so all existing importers keep
// working untouched.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  EVENT_PAGE_SIZE,
  eventStartsBounds,
  parseEventListQuery,
  type EventListParams,
} from "./event-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { nonSensitiveRead } from "../member-reads";
import { events, rsvps } from "../db/admin-schema";
import type { EventRow } from "./store-event-writes";
import { boundInventoryRead } from "./store-shared";

/** One admin list row: the event plus its Going-only seat count. */
export type EventListRow = EventRow & { goingCount: number };

/**
 * Fetch one extra row so pagination needs no separate count query.
 *
 * Both inventory statements run in one transaction behind the shared
 * transaction-local lock/statement bound, so a stalled table cancels
 * server-side and the caller refuses only after the transaction settles.
 */
export async function listEvents(db: Db, params: EventListParams): Promise<EventListRow[]> {
  const opts = parseEventListQuery(params);
  // A refused date window shows no rows rather than an unrestricted inventory
  // that could pass for the requested interval; nothing to read or classify.
  if (opts.startsWindow?.error) return [];
  return db.transaction(async (tx) => {
    await nonSensitiveRead("timeouts", () => boundInventoryRead(tx));
    const conds: (SQL | undefined)[] = [];
    if (opts.q) {
      // One literal case-insensitive match against title OR the stored game,
      // composed inside the same ANDed predicates as before. Null games never
      // match the game arm, so title-only rows behave exactly as they did.
      const pattern = `%${escapeLikeTerm(opts.q)}%`;
      conds.push(or(ilike(events.title, pattern), ilike(events.game, pattern)));
    }
    if (opts.status === "past")
      // Same definition as the public archive (src/events/reads.ts listPast):
      // stored-past rows plus published rows whose endsAt is before now.
      // Every other status keeps the literal stored-status match, and the
      // predicate stays inside the same ANDed single read so search, paging
      // and the Kit list inherit it unchanged. Rows keep their true stored
      // status label; no transition or migration writes here.
      conds.push(
        or(
          eq(events.status, "past"),
          and(eq(events.status, "published"), lt(events.endsAt, new Date())),
        ),
      );
    else if (opts.status) conds.push(eq(events.status, opts.status));
    // Half-open UTC start window [from, before), ANDed with the whole status
    // predicate (including both Past branches) before sorting and paging.
    const bounds = eventStartsBounds(opts.startsWindow);
    if (bounds?.from) conds.push(gte(events.startsAt, bounds.from));
    if (bounds?.before) conds.push(lt(events.startsAt, bounds.before));
    if (opts.rsvp_open !== "") conds.push(eq(events.rsvpOpen, opts.rsvp_open === "1"));
    if (opts.series === "parent")
      conds.push(and(isNull(events.parentEventId), isNotNull(events.recurrenceFrequency)));
    if (opts.series === "child") conds.push(isNotNull(events.parentEventId));
    if (opts.series === "standalone")
      conds.push(and(isNull(events.parentEventId), isNull(events.recurrenceFrequency)));
    if (opts.fill === "unlimited") conds.push(isNull(events.capacity));
    if (opts.fill === "full" || opts.fill === "has_seats") {
      // Only Going occupies a seat: Maybe and Waitlist never make an event full.
      const going = tx
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
      opts.sort === "title"
        ? events.title
        : opts.sort === "status"
          ? events.status
          : events.startsAt;
    const order = opts.order === "asc" ? asc(column) : desc(column);
    const rows = await nonSensitiveRead("events", () =>
      tx
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
      tx
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
  });
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
