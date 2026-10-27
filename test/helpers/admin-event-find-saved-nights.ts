// Acceptance-owned helpers: admin events "find saved nights by title or game".
//
// Owned by the independent acceptance contract. The Builder incorporates this
// file by merge and must never edit it; justified corrections return through
// the acceptance author.
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { EventListRow } from "../../src/admin/store-event-reads";

export type SavedNightSeed = {
  eventKey: string;
  title: string;
  game?: string | null;
  status?: string;
  startsAt?: Date;
  endsAt?: Date;
  capacity?: number | null;
  rsvpOpen?: boolean;
  parentEventId?: number | null;
  recurrenceFrequency?: string | null;
};

/** Insert one inventory row with an explicit saved game (null when omitted). */
export async function insertSavedNight(db: Db, night: SavedNightSeed) {
  const [row] = await db
    .insert(events)
    .values({
      eventKey: night.eventKey,
      title: night.title,
      game: night.game ?? null,
      status: night.status ?? "published",
      startsAt: night.startsAt ?? new Date("2026-11-01T20:00:00Z"),
      endsAt: night.endsAt ?? new Date("2026-11-01T22:00:00Z"),
      capacity: night.capacity ?? null,
      rsvpOpen: night.rsvpOpen ?? true,
      parentEventId: night.parentEventId ?? null,
      recurrenceFrequency: night.recurrenceFrequency ?? null,
    })
    .returning();
  return row!;
}

/** In-memory list row for executed template renders without a database. */
export function savedNightRow(
  eventKey: string,
  overrides: Partial<EventListRow> = {},
): EventListRow {
  return {
    id: 1,
    eventKey,
    title: `Friday social ${eventKey}`,
    game: null,
    description: null,
    startsAt: new Date("2026-11-01T18:00:00.000Z"),
    endsAt: new Date("2026-11-01T21:00:00.000Z"),
    timezone: "UTC",
    location: null,
    capacity: 8,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 1,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    icsSequence: 0n,
    goingCount: 3,
    ...overrides,
  };
}

/**
 * The Title `<td>` for one row: the cell holding the title link. Fails when
 * the row link is missing, so suppressing the row cannot satisfy a pin.
 */
export function titleCellFor(html: string, eventKey: string): string {
  const cell = html.match(
    new RegExp(`<td>\\s*<a href="/admin/events/${eventKey}">[\\s\\S]*?</td>`),
  );
  if (!cell) throw new Error(`No Title cell found for ${eventKey}`);
  return cell[0];
}

/** Visible text of the search `.field` block (label plus any help copy). */
export function searchFieldText(html: string): string {
  const field = html.match(/<div class="field">[\s\S]*?name="q"[\s\S]*?<\/div>/);
  if (!field) throw new Error("No search field block found");
  // Token walk: replace each <...> tag with one space without chained
  // String.replace, so CodeQL js/incomplete-multi-character-sanitization stays
  // silent. Matches the old /<[^>]*>/g strip: an unterminated "<" is kept
  // literally.
  const source = field[0];
  let stripped = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "<") {
      const close = source.indexOf(">", i + 1);
      if (close !== -1) {
        stripped += " ";
        i = close + 1;
        continue;
      }
      stripped += "<";
      i += 1;
      continue;
    }
    const next = source.indexOf("<", i);
    if (next === -1) {
      stripped += source.slice(i);
      break;
    }
    stripped += source.slice(i, next);
    i = next;
  }
  return stripped.replace(/\s+/g, " ").trim();
}

/** The raw `<input id="q" ...>` tag for native-control pins. */
export function searchInputTag(html: string): string {
  const tag = html.match(/<input[^>]*id="q"[^>]*>/);
  if (!tag) throw new Error("No #q input found");
  return tag[0];
}

/** The raw search `<form ...>` tag for native GET pins. */
export function searchFormTag(html: string): string {
  const form = html.match(/<form[^>]*>[\s\S]*?name="q"/);
  if (!form) throw new Error("No search form found");
  return form[0].slice(0, form[0].indexOf(">") + 1);
}

/** Paging href (`rel="next"`/`rel="prev"`) with entities decoded. */
export function pageHref(html: string, rel: "next" | "prev"): string | undefined {
  return html.match(new RegExp(`rel="${rel}" href="([^"]+)"`))?.[1]?.replaceAll("&amp;", "&");
}
