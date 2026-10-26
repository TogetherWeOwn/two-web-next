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
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  EVENT_PAGE_SIZE,
  parseEventListQuery,
  type EventListParams,
  type EventScopeRecovery,
} from "./event-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { canonicalEventKey, eventKeyAllowed } from "../events/keys";
import { nonSensitiveRead } from "../member-reads";
import { events, rsvps } from "../db/admin-schema";
import type { EventRow } from "./store-event-writes";
import { boundInventoryRead } from "./store-shared";

/** One admin list row: the event plus its Going-only seat count. */
export type EventListRow = EventRow & { goingCount: number };

/**
 * Exact-series scope for one inventory read. `ok` names the persisted
 * recurrence (parent key + title for the heading); any other status leaves
 * the page empty with an explicit recovery, never an unscoped list.
 */
export type EventListScope =
  | { status: "ok"; parentKey: string; parentTitle: string }
  | { status: EventScopeRecovery };

/**
 * Fetch one extra row so pagination needs no separate count query.
 *
 * All inventory statements run in one transaction behind the shared
 * transaction-local lock/statement bound, so a stalled table cancels
 * server-side and the caller refuses only after the transaction settles.
 * The exact-series scope resolves from stored recurrence/parent IDs and the
 * stable event key only — never title/game similarity or submitted fields.
 */
export async function listSeriesEvents(
  db: Db,
  params: EventListParams,
  appUrl = "",
): Promise<{ rows: EventListRow[]; scope: EventListScope | null }> {
  const opts = parseEventListQuery(params);
  const requested = opts.series_event;
  // Match editor admission before touching the database, including demo keys
  // only on staging/local bindings. The default keeps seed scopes refused.
  const lookupKey =
    requested !== null && eventKeyAllowed(requested, appUrl)
      ? (canonicalEventKey(requested) ?? requested)
      : null;
  if (requested !== null && lookupKey === null) {
    return { rows: [], scope: { status: "invalid" } };
  }
  return db.transaction(async (tx) => {
    await nonSensitiveRead("timeouts", () => boundInventoryRead(tx));
    let scope: EventListScope | null = null;
    const conds: (SQL | undefined)[] = [];
    if (lookupKey !== null) {
      const [found] = await nonSensitiveRead("events", () =>
        tx
          .select({
            id: events.id,
            eventKey: events.eventKey,
            title: events.title,
            parentEventId: events.parentEventId,
            recurrenceFrequency: events.recurrenceFrequency,
          })
          .from(events)
          .where(eq(events.eventKey, lookupKey))
          .limit(1),
      );
      if (!found) return { rows: [], scope: { status: "not-found" } };
      // A standalone event is not a series: resolving it to All events would
      // mislead, so it recovers explicitly like any other unusable scope.
      if (found.parentEventId === null && found.recurrenceFrequency === null) {
        return { rows: [], scope: { status: "not-in-series" } };
      }
      const parentId = found.parentEventId ?? found.id;
      let parentKey = found.eventKey;
      let parentTitle = found.title;
      if (found.parentEventId !== null) {
        const [parent] = await nonSensitiveRead("events", () =>
          tx
            .select({ eventKey: events.eventKey, title: events.title })
            .from(events)
            .where(eq(events.id, parentId))
            .limit(1),
        );
        if (!parent) return { rows: [], scope: { status: "not-found" } };
        parentKey = parent.eventKey;
        parentTitle = parent.title;
      }
      scope = { status: "ok", parentKey, parentTitle };
      // Parent plus every child across stored statuses: drafts and cancelled
      // siblings stay visible here even though public history omits them.
      conds.push(or(eq(events.id, parentId), eq(events.parentEventId, parentId)));
    }
    if (opts.q) {
      // One literal case-insensitive match against title OR the stored game,
      // composed inside the same ANDed predicates as before. Null games never
      // match the game arm, so title-only rows behave exactly as they did.
      const pattern = `%${escapeLikeTerm(opts.q)}%`;
      conds.push(or(ilike(events.title, pattern), ilike(events.game, pattern)));
    }
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
    if (rows.length === 0) return { rows: [], scope };
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
    return { rows: rows.map((r) => ({ ...r, goingCount: by.get(r.id) ?? 0 })), scope };
  });
}

/** Rows-only inventory read; the scoped twin carries the series metadata. */
export async function listEvents(db: Db, params: EventListParams): Promise<EventListRow[]> {
  return (await listSeriesEvents(db, params)).rows;
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
