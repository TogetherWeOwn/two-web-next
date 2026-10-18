// Event create/edit form parser (W11). Pure move out of `./validation`,
// ports the legacy Filament EventForm/EventInput rules. `./validation`
// re-exports every public name below, so all existing importers keep working
// untouched.

import {
  containsControlCharacters,
  fail,
  str,
  ValidationError,
  type FieldErrors,
} from "./validation-shared";
import {
  isKnownTimezone,
  parseWall,
  utcToWall,
  wallString,
  wallToUtc,
} from "./validation-wall-time";

export type EventFormInput = {
  // Deliberately no event key: the route key is minted server-side
  // (newEventKey) at create and immutable once written. parseEventForm
  // refuses forged event_key/eventKey input (legacy EventKeyTest).
  title: string;
  game: string | null;
  description: string | null;
  startsAtUtc: Date;
  endsAtUtc: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
};

/** Parse the event create/edit form. `carriers` holds the hidden *_utc edit-page hints (TOG-6805). */
export function parseEventForm(
  data: Record<string, unknown>,
  carriers?: { startsAtUtc?: string; endsAtUtc?: string },
): EventFormInput {
  const fields: FieldErrors = {};
  // The route key is minted server-side and immutable once written (legacy
  // EventKeyTest): a forged key is refused with 422 rather than applied or
  // silently ignored. Both spellings are refused; no caller sends a key.
  if (data.event_key !== undefined || data.eventKey !== undefined) {
    fields.event_key = "The event key is assigned when the event is created and cannot be changed.";
  }
  const title = str(data.title);
  if (!title) fields.title = "Give the event a title.";
  else if ([...title].length > 100) fields.title = "Keep the title to 100 characters.";
  // A supplied non-string must never silently clear saved text: null, blank
  // and omitted stay empty, but objects, arrays, booleans and numbers are
  // refused with the existing field-specific 422 shape.
  for (const field of ["game", "description", "location"] as const) {
    const raw = data[field];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      fields[field] = `The ${field} must be text.`;
    }
  }
  const game = str(data.game);
  if (game && [...game].length > 100) fields.game = "Keep the game to 100 characters.";
  const description = str(data.description);
  if (description && [...description].length > 1000)
    fields.description = "Keep the description to 1000 characters.";
  const timezone = str(data.timezone) ?? "Europe/London";
  if (!isKnownTimezone(timezone)) fields.timezone = `Unknown timezone: ${timezone}.`;
  const location = str(data.location);
  if (location && [...location].length > 255)
    fields.location = "Keep the location to 255 characters.";
  // Check the submitted text, not its trimmed value: trim removes BOM.
  for (const field of ["title", "game", "description", "location"] as const) {
    const raw = data[field];
    if (typeof raw === "string" && containsControlCharacters(raw)) {
      fields[field] = "Remove control or invisible characters.";
    }
  }

  let capacity: number | null = null;
  // Forms carry strings; JSON and stored PATCH defaults carry numbers. A non-string
  // value must not silently erase a cap and bypass the occupied-seat guard.
  const capRaw = typeof data.capacity === "number" ? String(data.capacity) : str(data.capacity);
  const capError = "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.";
  if (
    data.capacity != null &&
    typeof data.capacity !== "string" &&
    typeof data.capacity !== "number"
  ) {
    fields.capacity = capError;
  } else if (capRaw !== null) {
    const value = Number(capRaw);
    if (!/^\d+$/.test(capRaw) || !Number.isInteger(value) || value < 1 || value > 2_147_483_647)
      fields.capacity = capError;
    else capacity = value;
  }

  const startsRaw = str(data.starts_at);
  const endsRaw = str(data.ends_at);
  if (!startsRaw) fields.starts_at = "When does it start?";
  if (!endsRaw) fields.ends_at = "When does it end?";

  let startsAtUtc: Date | null = null;
  let endsAtUtc: Date | null = null;
  if (!fields.timezone) {
    // Untouched fold/gap-ambiguous wall text keeps the exact instant the
    // form rendered (TOG-6805): the carrier rides in the hidden field, and a
    // match on minute precision means "no keystroke", so the stored instant
    // wins over a re-parse that could land on the other side of the fold.
    for (const [raw, carrier, field] of [
      [startsRaw, carriers?.startsAtUtc, "starts_at"],
      [endsRaw, carriers?.endsAtUtc, "ends_at"],
    ] as const) {
      if (!raw) continue;
      try {
        const instant = preservedOrParsed(raw, carrier, timezone);
        if (field === "starts_at") startsAtUtc = instant;
        else endsAtUtc = instant;
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        // The shared parser speaks "wall"; the event form needs the input's name.
        for (const [name, message] of Object.entries(e.fields)) {
          fields[name === "wall" ? field : name] = message;
        }
      }
    }
    if (startsAtUtc && endsAtUtc && endsAtUtc <= startsAtUtc)
      fields.ends_at = "The end is after the start.";
  }
  if (Object.keys(fields).length > 0) fail(fields);
  return {
    title: title!,
    game,
    description,
    startsAtUtc: startsAtUtc!,
    endsAtUtc: endsAtUtc!,
    timezone,
    location,
    capacity,
  };
}

function preservedOrParsed(wall: string, carrier: string | undefined, timezone: string): Date {
  if (carrier) {
    const captured = new Date(carrier);
    if (!Number.isNaN(captured.getTime())) {
      // Minute precision: the picker speaks minutes, so seconds would never
      // match and the carrier would be dead. Seconds survive in the carrier.
      const submitted = parseWall(wall);
      if (submitted && wallString(submitted) === utcToWall(captured, timezone)) return captured;
    }
  }
  return wallToUtc(wall, timezone);
}
