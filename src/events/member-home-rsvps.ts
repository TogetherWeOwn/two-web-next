// Member-only home RSVP projection: the viewer's OWN answers for the events
// already shown on the home page, as one keyed member read. Never another
// member's answer, never a roster, never an anonymous caller.
//
// Events are addressed by the canonical event key the home teaser already shows
// (HomeUpcomingRow.eventKey), joined to rsvps through events.id; numeric ids never
// leave the read. The result is per-viewer: render it per request and never put it
// in the shared guest home cache (src/home-cache.ts), which holds viewer-invariant
// data only.
//
// The read must run inside a member-read boundary (memberReadResponse /
// memberReadBoundary) that declares the same viewer. The where-clause pins every
// row to that viewer, so the boundary's subject accounting holds only the
// caller's own key, which the audit filters out as the viewer.
import { and, eq, inArray } from "drizzle-orm";
import { events, rsvps } from "../db/admin-schema";
import type { Db } from "../db/index";
import { keyedMemberRead } from "../member-reads";
import { isRsvpStatus } from "./rsvp";

/** The home page lists a bounded number of events; the projection never exceeds it. */
export const MEMBER_HOME_RSVP_MAX_EVENTS = 50;

// Same snowflake shape the member-read boundary enforces for viewer and subject keys.
const DISCORD_ID = /^\d{10,25}$/;

export type MemberHomeRsvp = { status: string; syncedToDiscordAt: Date | null };

/**
 * Viewer's answers keyed by canonical event key. Events without an answer are absent.
 * An unrecognized viewer id, no event keys, or an unrecognized stored status
 * yields no entry and, for the first two, issues no query.
 */
export async function getMemberHomeRsvps(
  db: Db,
  viewerId: string | null | undefined,
  eventKeys: readonly string[],
): Promise<Map<string, MemberHomeRsvp>> {
  const answers = new Map<string, MemberHomeRsvp>();
  if (typeof viewerId !== "string" || !DISCORD_ID.test(viewerId)) return answers;
  const keys = [
    ...new Set(eventKeys.filter((key) => typeof key === "string" && key.length > 0)),
  ].slice(0, MEMBER_HOME_RSVP_MAX_EVENTS);
  if (keys.length === 0) return answers;
  const rows = await keyedMemberRead(() =>
    db
      .select({
        userId: rsvps.userId,
        eventKey: events.eventKey,
        status: rsvps.status,
        syncedToDiscordAt: rsvps.syncedToDiscordAt,
      })
      .from(rsvps)
      .innerJoin(events, eq(rsvps.eventId, events.id))
      .where(and(eq(rsvps.userId, viewerId), inArray(events.eventKey, keys))),
  );
  const requestedKeys = new Set(keys);
  for (const row of rows) {
    if (row.userId !== viewerId || !requestedKeys.has(row.eventKey) || !isRsvpStatus(row.status))
      continue;
    answers.set(row.eventKey, { status: row.status, syncedToDiscordAt: row.syncedToDiscordAt });
  }
  return answers;
}
