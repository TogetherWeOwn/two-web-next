// One projection for the twelve controls Hono and Kit display and save.
// Keeping it shared prevents a port from minting a full-row baseline while
// silently clearing an undisplayed notes, organizer or joining field.
import type { BaselineContent } from "./event-baseline";
import { isKnownTimezone, utcToWall } from "./validation-wall-time";

export function eventFormValues(row: BaselineContent) {
  // A validation refusal can retain a corrupt stored zone or instant. Keep the
  // bad zone visible for correction, but never format it or invent wall times.
  const knownTimezone = isKnownTimezone(row.timezone);
  return {
    title: row.title,
    game: row.game ?? "",
    description: row.description ?? "",
    accessibility_notes: row.accessibilityNotes ?? "",
    // Wall text in the row's zone — what the moderator typed is what they see.
    starts_at:
      knownTimezone && Number.isFinite(row.startsAt.getTime())
        ? utcToWall(row.startsAt, row.timezone)
        : "",
    ends_at:
      knownTimezone && Number.isFinite(row.endsAt.getTime())
        ? utcToWall(row.endsAt, row.timezone)
        : "",
    timezone: row.timezone,
    location: row.location ?? "",
    organizer_name: row.organizer_name ?? "",
    join_url: row.join_url ?? "",
    join_instructions: row.join_instructions ?? "",
    capacity: row.capacity === null ? "" : String(row.capacity),
  };
}
