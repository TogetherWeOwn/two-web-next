// Admin input validation (W11). Ports the legacy Filament form rules
// (EventForm, FeaturedContentForm, EventInput, RecurrenceSchedule) as pure
// functions so they are unit-testable without a database.
//
// Design notes carried over from legacy:
// - The form speaks LOCAL WALL TIME + IANA zone; storage is a UTC instant.
//   "20:00 Europe/London" is 19:00Z in July and 20:00Z in December —
//   resolving without the zone gets one of the two wrong every year.
// - A wall time inside a spring-forward gap never occurred: refused loudly
//   (TOG-6803). A wall time carrying its own zone/offset would silently win
//   over the explicit zone: refused by shape, the parser only accepts naive
//   input (TOG-6804).
// - An autumn-overlap (fold) wall time names two instants. A fresh parse
//   takes the first occurrence; an unchanged edit keeps the exact stored
//   instant via the hidden *_utc carrier (TOG-6805, see routes).

import { isFeaturedImageUrl } from "../image-policy";

export type EventStatus = "draft" | "published" | "cancelled" | "past";

export type EventFormInput = {
  title: string;
  game: string | null;
  description: string | null;
  startsAtUtc: Date;
  endsAtUtc: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
};

export type FeaturedFormInput = {
  title: string;
  body: string | null;
  url: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  isPublished: boolean;
  position: number;
  startsAtUtc: Date | null;
  endsAtUtc: Date | null;
  // Dates serve existing callers; canonical UTC text carries PostgreSQL microseconds.
  startsAtUtcText?: string | null;
  endsAtUtcText?: string | null;
};

/** Field errors keyed by field name, in the form's own terms. */
export type FieldErrors = Record<string, string>;

export class ValidationError extends Error {
  constructor(readonly fields: FieldErrors) {
    super(`invalid input: ${Object.keys(fields).join(", ")}`);
  }
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

// Intl construction dominates repeated wall-time validation. Bound shared
// formatter reuse so request-supplied zones cannot grow isolate memory forever.
const FORMATTER_CACHE_LIMIT = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  const cached = formatters.get(key);
  if (cached) return cached;
  const value = new Intl.DateTimeFormat(locale, options);
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, value);
  return value;
}

/** Whether the string names an IANA zone the runtime knows. */
export function isKnownTimezone(tz: string): boolean {
  try {
    formatter("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type WallParts = { y: number; mo: number; d: number; h: number; mi: number };

function parseWall(raw: string): WallParts | null {
  const m = WALL_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59) return null;
  // Reject impossible calendar dates (e.g. Feb 30) rather than rolling over.
  const probe = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));
  if (probe.getUTCMonth() !== mo! - 1 || probe.getUTCDate() !== d!) return null;
  return { y: y!, mo: mo!, d: d!, h: h!, mi: mi! };
}

const dtf = (tz: string) =>
  formatter("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function wallOfInstant(instantMs: number, formatter: Intl.DateTimeFormat): string {
  const parts: Record<string, string> = {};
  for (const p of formatter.formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // en-GB can emit hour "24" for midnight; normalise to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour!;
  return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function wallString(p: WallParts): string {
  return `${String(p.y).padStart(4, "0")}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * Resolve a naive local wall time in an IANA zone to the UTC instant it names.
 * Throws on unparseable input, unknown zones, and gap times that never
 * occurred. Fold-ambiguous times resolve to the first occurrence.
 */
export function wallToUtc(raw: string, timezone: string): Date {
  const parts = parseWall(raw);
  if (!parts) throw new ValidationError({ wall: `Not a date and time (want YYYY-MM-DD HH:mm): ${raw}` });
  if (!isKnownTimezone(timezone)) throw new ValidationError({ timezone: `Unknown timezone: ${timezone}` });

  // Sample offsets on both sides of a nearby transition. Iteration alone
  // can settle on the SECOND occurrence of a fold (e.g. Europe/London).
  // Keep only candidates that round-trip, then choose the earliest instant.
  // This also handles half-hour DST without assuming a one-hour change.
  const naiveMs = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi);
  // Reuse one real formatter for all samples and round-trips in this parse.
  const formatter = dtf(timezone);
  const candidates = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const sample = naiveMs + delta * 3600_000;
    const rendered = parseWall(wallOfInstant(sample, formatter));
    if (!rendered) continue;
    const renderedAsUtc = Date.UTC(rendered.y, rendered.mo - 1, rendered.d, rendered.h, rendered.mi);
    const candidate = naiveMs - (renderedAsUtc - sample);
    if (wallOfInstant(candidate, formatter) === wallString(parts)) candidates.add(candidate);
  }

  // Gap check (TOG-6803): a time that never occurred has no candidate.
  if (candidates.size === 0) {
    throw new ValidationError({
      wall: `That time never occurred in ${timezone} — clocks skipped forward over it. Pick a time outside the gap.`,
    });
  }
  return new Date(Math.min(...candidates));
}

/** Render a stored UTC instant as wall text in the row's zone (edit form fill). */
export function utcToWall(instant: Date, timezone: string): string {
  return wallOfInstant(instant.getTime(), dtf(timezone));
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulidRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) {
    // Two Crockford chars per byte would be 32 chars; take 16 chars by
    // folding each byte to one 5-bit symbol. Randomness is all that matters
    // here — time-ordering lives in the 10-char time part.
    out += ULID_ALPHABET[b! & 31];
  }
  return out;
}

/** ULID (26-char Crockford base32), matching legacy `Str::ulid()` event keys. */
export function newEventKey(nowMs: number = Date.now()): string {
  let time = nowMs;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + ulidRandom().slice(0, 16);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function fail(fields: FieldErrors): never {
  throw new ValidationError(fields);
}

// Legacy NoControlCharacters: allow tab/LF/CR and genuine emoji ZWJ
// sequences, but refuse other Cc and targeted invisible/bidi format chars.
function containsControlCharacters(value: string): boolean {
  const stripped = value.replace(/[\t\n\r]/g, "");
  if (/\p{Cc}/u.test(stripped)) return true;
  // Match the original text: removing whitespace can manufacture an emoji.
  const withoutEmojiJoiners = value.replace(
    /(?:\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*\u{200D})+\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*/gu,
    "",
  );
  return /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200D}\u{FEFF}]/u.test(withoutEmojiJoiners);
}

/** Parse the event create/edit form. `carriers` holds the hidden *_utc edit-page hints (TOG-6805). */
export function parseEventForm(
  data: Record<string, unknown>,
  carriers?: { startsAtUtc?: string; endsAtUtc?: string },
): EventFormInput {
  const fields: FieldErrors = {};
  const title = str(data.title);
  if (!title) fields.title = "Give the event a title.";
  else if ([...title].length > 100) fields.title = "Keep the title to 100 characters.";
  const game = str(data.game);
  if (game && [...game].length > 100) fields.game = "Keep the game to 100 characters.";
  const description = str(data.description);
  if (description && [...description].length > 1000) fields.description = "Keep the description to 1000 characters.";
  const timezone = str(data.timezone) ?? "Europe/London";
  if (!isKnownTimezone(timezone)) fields.timezone = `Unknown timezone: ${timezone}.`;
  const location = str(data.location);
  if (location && [...location].length > 255) fields.location = "Keep the location to 255 characters.";
  // Check the submitted text, not its trimmed value: trim removes BOM.
  for (const field of ["title", "description", "location"] as const) {
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
  if (data.capacity != null && typeof data.capacity !== "string" && typeof data.capacity !== "number") {
    fields.capacity = capError;
  } else if (capRaw !== null) {
    const value = Number(capRaw);
    if (!/^\d+$/.test(capRaw) || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) fields.capacity = capError;
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
    if (startsAtUtc && endsAtUtc && endsAtUtc <= startsAtUtc) fields.ends_at = "The end is after the start.";
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

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse the featured-content create/edit form (ports FeaturedContentForm rules). */
export function parseFeaturedForm(data: Record<string, unknown>, imageHosts?: string): FeaturedFormInput {
  const fields: FieldErrors = {};
  const title = str(data.title);
  if (!title) fields.title = "Give it a headline.";
  else if (title.length > 255) fields.title = "Keep the headline to 255 characters.";
  const body = str(data.body);
  const url = str(data.url);
  if (url && (url.length > 255 || !isHttpUrl(url))) fields.url = "Link is a full http(s) URL, or empty for no link.";
  const imageUrl = str(data.image_url);
  if (imageUrl && (imageUrl.length > 255 || !isFeaturedImageUrl(imageUrl, imageHosts))) {
    fields.image_url = "Image URL must be HTTPS on an approved public host, without credentials or a custom port (255 characters maximum).";
  }
  const imageAlt = str(data.image_alt);
  // TOG-8707: an image with no description is silent for screen-reader
  // visitors — the URL and its description arrive together or not at all.
  if (imageUrl && !imageAlt) fields.image_alt = "Describe the photo in one plain sentence for screen-reader visitors.";
  if (imageAlt && imageAlt.length > 255) fields.image_alt = "Keep the alt text to 255 characters.";

  let position = 0;
  const posRaw = str(data.position);
  if (posRaw !== null) {
    if (!/^\d+$/.test(posRaw)) fields.position = "Position is 0 or more; lower numbers appear first.";
    else position = Number(posRaw);
  }

  const startsRaw = str(data.starts_at);
  const endsRaw = str(data.ends_at);
  let startsAtUtc: Date | null = null;
  let endsAtUtc: Date | null = null;
  let startsAtUtcText: string | null = null;
  let endsAtUtcText: string | null = null;
  // The show-window is UTC on both sides (legacy labels it "(UTC)").
  for (const [raw, key] of [[startsRaw, "starts_at"], [endsRaw, "ends_at"]] as const) {
    if (raw !== null) {
      if (/\sBC$/i.test(raw)) {
        fields[key] = "BC dates are not supported. Clear or replace this window bound with an AD date.";
        continue;
      }
      // Featured windows support PostgreSQL precision; event wall times still speak minutes.
      const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(raw);
      const wall = match && parseWall(match[1]!);
      const seconds = Number(match?.[2] ?? 0);
      const fraction = (match?.[3] ?? "").padEnd(6, "0");
      if (!wall || wall.y === 0 || seconds > 59) fields[key] = "Not a date and time (want YYYY-MM-DD HH:mm[:ss[.ffffff]], UTC; up to 6 fractional digits).";
      else {
        // Date.UTC maps years 0–99 to 1900–1999; featured years must stay literal.
        const instant = new Date(0);
        instant.setUTCFullYear(wall.y, wall.mo - 1, wall.d);
        instant.setUTCHours(wall.h, wall.mi, seconds, Number(fraction.slice(0, 3)));
        const text = `${instant.toISOString().slice(0, 19)}.${fraction}Z`;
        if (key === "starts_at") { startsAtUtc = instant; startsAtUtcText = text; }
        else { endsAtUtc = instant; endsAtUtcText = text; }
      }
    }
  }
  // Fixed-width UTC strings sort chronologically, even within one Date millisecond.
  if (startsAtUtcText && endsAtUtcText && endsAtUtcText <= startsAtUtcText) fields.ends_at = "The window ends after it starts.";

  if (Object.keys(fields).length > 0) fail(fields);
  return {
    title: title!,
    body,
    url,
    imageUrl,
    imageAlt,
    isPublished: data.is_published === "on" || data.is_published === true || data.is_published === "true",
    position,
    startsAtUtc,
    endsAtUtc,
    startsAtUtcText,
    endsAtUtcText,
  };
}

/** Transition guard (ports EventService::transitionTo): cancelled is terminal. */
export function nextStatus(from: EventStatus, to: "published" | "cancelled"): EventStatus {
  if (from === "cancelled") {
    throw new ValidationError({ status: "A cancelled event stays cancelled — Discord was already told." });
  }
  if (to === "published" && from !== "draft") {
    throw new ValidationError({ status: "Only a draft can be published." });
  }
  if (to === "cancelled" && from !== "draft" && from !== "published") {
    throw new ValidationError({ status: "Only a draft or a published event can be cancelled." });
  }
  return to;
}

/** Whether a row in this status is mirrored to Discord (ports EventStatus::isMirroredInDiscord). */
export function isMirrored(status: EventStatus): boolean {
  return status === "published" || status === "cancelled";
}
