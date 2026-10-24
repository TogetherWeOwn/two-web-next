// W9 calendar feeds: pure builders ported byte-for-byte from two-web's
// EventIcs / EventRss / EventSubscribe / EventGoogleCalendar. No query, no auth, no HTTP.
import type { events } from "../db/admin-schema";
import { containsControlCharacters } from "../admin/validation-shared";
import { stripTrailingSlash } from "../seo";
import { rssXml as xml } from "./rss-xml";

type EventRow = typeof events.$inferSelect;

export const SITE_NAME = "Together We Own";

/** Feed `?game=` scope bound: 100 Unicode code points, like stored-game validation. */
export const FEED_GAME_SCOPE_MAX_LENGTH = 100;

/**
 * Parse the optional `/events.ics?game=` scope. Blank (missing/empty/whitespace)
 * means the unfiltered collection; a trimmed valid game filters to exactly that
 * game. Overlong values, CR/LF property-injection input and control/invisible
 * characters refuse with undefined so the route answers 400 without a read.
 * Unknown games stay valid here — they filter to an empty scoped calendar, never all games.
 */
export function parseFeedGameScope(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const game = raw.trim();
  if (game === "") return null;
  if ([...game].length > FEED_GAME_SCOPE_MAX_LENGTH) return undefined;
  if (game.includes("\r") || game.includes("\n")) return undefined;
  if (containsControlCharacters(game)) return undefined;
  return game;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** True when `d` formats on the RFC 5545 wire: a finite instant in years 0000-9999. */
export function isWireInstant(d: Date): boolean {
  // getUTCFullYear is NaN exactly when the time is NaN, so the finite
  // check subsumes it: what remains is an integer year to range-check.
  const year = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && year >= 0 && year <= 9999;
}

/** PHP `Ymd\THis\Z` for a UTC instant.
 *
 * RFC 5545 wire form needs exactly four year digits: finite instants in
 * years 0000-9999 format with a zero-padded year, while anything else
 * (non-finite, negative or expanded years) refuses instead of emitting
 * corrupt `NaN` or invalid-width bytes.
 */
export function icsInstant(d: Date): string {
  if (!isWireInstant(d)) throw new IcsTimestampRangeError();
  const year = d.getUTCFullYear();
  return `${String(year).padStart(4, "0")}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** PHP `DATE_RSS` (`D, d M Y H:i:s O`) in UTC, i.e. `+0000`. */
export function rssDate(d: Date): string {
  if (!isWireInstant(d)) throw new RangeError("RSS timestamp is outside the four-digit year range");
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).padStart(4, "0")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** RFC 5545 §3.3.11 escaping: backslash, semicolon, comma, newlines. */
function text(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Feed-host identity: the display name carries the already-public host; the
// address is a fixed non-routable placeholder (RFC 2606 `.invalid`), never a
// real member address.
const FEED_HOST_PLACEHOLDER = "noreply@example.invalid";
const ICS_ORGANIZER_PLACEHOLDER = `mailto:${FEED_HOST_PLACEHOLDER}`;

/** Trimmed public host, or undefined when blank/missing (emit no property). */
function feedHost(e: EventRow): string | undefined {
  const name = e.organizer_name?.trim();
  return name ? name : undefined;
}

/** Quoted CN param-text: RFC 5545 §3.1/§3.2 quoted-string is DQUOTE
 * *QSAFE-CHAR DQUOTE with no backslash escape, so DQUOTE normalizes to an
 * apostrophe and C0-control/DEL runs to one space. Backslash, comma,
 * semicolon, colon, caret and `<>&` stay literal inside the quotes. */
function cnParam(v: string): string {
  return v.replace(/"/g, "'").replace(/[\u0000-\u001F\u007F]+/g, " ");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Fold lines over 75 octets (§3.1) without splitting a UTF-8 character. */
function fold(line: string): string {
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;
  const cut = (start: number, max: number): number => {
    let end = Math.min(start + max, bytes.length);
    if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
    return end;
  };
  let end = cut(0, 75);
  let out = dec.decode(bytes.slice(0, end));
  while (end < bytes.length) {
    const next = cut(end, 74);
    out += `\r\n ${dec.decode(bytes.slice(end, next))}`;
    end = next;
  }
  return out;
}

// APP_URL is an unconstrained binding (see seo.ts): a configured trailing
// slash must never leak a doubled `//` into emitted URLs (TOG-11225).
const feedBase = (appUrl: string) => stripTrailingSlash(appUrl);

const pageUrl = (e: EventRow, appUrl: string) => `${feedBase(appUrl)}/e/${e.eventKey}`;

export class IcsSequenceRangeError extends RangeError {
  constructor() {
    super("Calendar revision is outside the RFC 5545 SEQUENCE range");
  }
}

export class IcsTimestampRangeError extends RangeError {
  constructor() {
    super("Calendar timestamp is outside the RFC 5545 wire range");
  }
}

/** SEQUENCE is a nonnegative signed 32-bit INTEGER (§3.3.8, §3.8.7.4).
 *
 * The stored revision is epoch-derived by design (the events_ics_sequence
 * trigger owns it; legacy two-web parity), so emitting it raw discloses the
 * server clock and trips ZAP 10096 on every feed response. Emit the
 * revision shifted by a fixed base instead: the map is affine, so revision
 * ordering is preserved for post-base revisions; pre-base revisions saturate
 * at 0 rather than leak. The whole valid stored range [0, 2147483647] lands
 * in [0, 447483647] (at most 9 digits), which the scanner's 10-digit unix
 * pattern can never match. One-time effect: emitted SEQUENCE values step down
 * once after deploy (about 1.7B) and never recover: post-deploy emitted
 * values top out at 447483647, so they never re-exceed a pre-deploy cached
 * value (at least 1700000000 for any event revised after 2023-11-14). A
 * client that cached a pre-deploy value and strictly compares SEQUENCE by UID
 * ignores every later update to that UID permanently; the most likely case is
 * a single /e/:key.ics opened as an import rather than a subscription. No
 * ZAP-safe mapping avoids this (every int32 at or above the cached values is
 * a 10-digit run the scanner matches). The feed is METHOD:PUBLISH
 * (full-state replace), no in-repo consumer persists wire SEQUENCE, and the
 * ETag rotates with the new bytes so HTTP caches revalidate.
 */
export const ICS_SEQUENCE_BASE = 1700000000n; // 2023-11-14T22:13:20Z
function icsSequence(sequence: bigint): string {
  // Validate the stored/imported bigint; out-of-range values fail the export
  // until an explicit identity migration (never wrap or reset ordering).
  // Pre-base revisions saturate at 0 by design (see above).
  if (sequence < 0n || sequence > 2147483647n) throw new IcsSequenceRangeError();
  const shifted = sequence - ICS_SEQUENCE_BASE;
  return (shifted < 0n ? 0n : shifted).toString();
}

function vevent(e: EventRow, appUrl: string): string[] {
  const host = new URL(appUrl).host || "localhost";
  const stamp = icsInstant(e.updatedAt);
  const seq = icsSequence(e.icsSequence);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.eventKey}@${host}`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsInstant(e.startsAt)}`,
    `DTEND:${icsInstant(e.endsAt)}`,
    `SUMMARY:${text(e.title)}`,
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : e.status === "draft" ? "TENTATIVE" : "CONFIRMED"}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${text(e.description)}`);
  if (e.location) lines.push(`LOCATION:${text(e.location)}`);
  const organizer = feedHost(e);
  if (organizer) lines.push(`ORGANIZER;CN="${cnParam(organizer)}":${ICS_ORGANIZER_PLACEHOLDER}`);
  lines.push(
    `URL:${pageUrl(e, appUrl)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${text(e.title)}`,
    "END:VALARM",
    "END:VEVENT",
  );
  return lines;
}

function calendar(inner: string[], game: string | null = null): string {
  const name = game === null ? `${SITE_NAME} Events` : `${SITE_NAME} Events — ${game}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TogetherWeOwn//Events//EN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(name)}`,
    `X-WR-CALDESC:${text(`Upcoming events from ${SITE_NAME}`)}`,
    ...inner,
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export const eventIcs = (e: EventRow, appUrl: string): string => calendar(vevent(e, appUrl));

export const eventsIcsCollection = (
  rows: EventRow[],
  appUrl: string,
  game: string | null = null,
): string => {
  // One out-of-range stored revision must not fail the whole export: skip
  // that row and log the count plus the skipped event keys, so the stranded
  // subscriber-visible event can be found and the identity migration started.
  // Only the sequence-range and timestamp-range failures are skippable; any
  // other builder error still throws for the collection.
  let skipped = 0;
  const skippedEventKeys: string[] = [];
  let skippedTimestamps = 0;
  const inner = rows.flatMap((e) => {
    try {
      return vevent(e, appUrl);
    } catch (error) {
      if (error instanceof IcsTimestampRangeError) {
        skippedTimestamps += 1;
        return [];
      }
      if (!(error instanceof IcsSequenceRangeError)) throw error;
      skipped += 1;
      skippedEventKeys.push(e.eventKey);
      return [];
    }
  });
  if (skipped > 0) {
    console.warn("eventsIcsCollection skipped out-of-range SEQUENCE rows.", {
      skipped,
      skippedEventKeys,
    });
  }
  if (skippedTimestamps > 0) {
    // Bounded by reason, not by row: one line carries the count however many
    // rows were poisoned, and no event key, title or description may leak.
    console.warn("eventsIcsCollection skipped rows with non-wire timestamps.", {
      skipped: skippedTimestamps,
    });
  }
  return calendar(inner, game);
};

export function latestWireUpdatedAt(rows: EventRow[]): Date {
  const latest = rows.reduce<Date | undefined>(
    (selected, row) =>
      isWireInstant(row.updatedAt) && (!selected || row.updatedAt > selected)
        ? row.updatedAt
        : selected,
    undefined,
  );
  return latest ?? new Date(0);
}

/** RSS marking for cancelled events: the title prefix plus the one-line
 * description note. The ICS collection signals the same rows with
 * STATUS:CANCELLED; RSS has no status field, so the mark lives in the text. */
export const RSS_CANCELLED_TITLE_PREFIX = "Cancelled: ";
export const RSS_CANCELLED_NOTE = "This event has been cancelled.";

export function eventsRss(rows: EventRow[], appUrl: string, lastBuild: Date): string {
  const base = feedBase(appUrl);
  const renderable = rows.filter((e) => isWireInstant(e.startsAt) && isWireInstant(e.endsAt));
  const skipped = rows.length - renderable.length;
  if (skipped > 0) {
    console.warn("eventsRss skipped rows with non-wire timestamps.", { skipped });
  }
  const items = renderable
    .map((e) => {
      const url = xml(pageUrl(e, appUrl));
      const organizer = feedHost(e);
      const cancelled = e.status === "cancelled";
      const title = cancelled ? `${RSS_CANCELLED_TITLE_PREFIX}${e.title}` : e.title;
      const description = cancelled
        ? e.description
          ? `${e.description} ${RSS_CANCELLED_NOTE}`
          : RSS_CANCELLED_NOTE
        : e.description;
      return (
        `<item><title>${xml(title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid>` +
        `<pubDate>${rssDate(e.startsAt)}</pubDate>` +
        (organizer ? `<author>${xml(`${FEED_HOST_PLACEHOLDER} (${organizer})`)}</author>` : "") +
        (description ? `<description>${xml(description)}</description>` : "") +
        "</item>"
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
    `<title>${xml(`${SITE_NAME} Events`)}</title>` +
    `<link>${xml(`${base}/events`)}</link>` +
    `<atom:link href="${xml(`${base}/events.rss`)}" rel="self" type="application/rss+xml" />` +
    `<description>${xml(`Upcoming events from ${SITE_NAME}`)}</description>` +
    `<lastBuildDate>${rssDate(lastBuild)}</lastBuildDate>${items}</channel></rss>`
  );
}

/**
 * Collection feed URL, optionally scoped to one game. Blank game keeps the
 * exact unfiltered URL; a game appends the single `game` query value so the
 * subscription carries the committed schedule scope and nothing else.
 */
export const feedUrl = (appUrl: string, game?: string | null) => {
  const base = `${feedBase(appUrl)}/events.ics`;
  const scope = (game ?? "").trim();
  if (scope === "") return base;
  return `${base}?${new URLSearchParams({ game: scope })}`;
};
export const rssUrl = (appUrl: string) => `${feedBase(appUrl)}/events.rss`;
export const webcalUrl = (appUrl: string, game?: string | null) =>
  feedUrl(appUrl, game).replace(/^https?:\/\//, "webcal://");

/** RFC3986 query encoding, like PHP_QUERY_RFC3986. */
const q = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function googleCalendarUrl(e: EventRow): string {
  const params: [string, string][] = [
    ["action", "TEMPLATE"],
    ["text", e.title],
    ["dates", `${icsInstant(e.startsAt)}/${icsInstant(e.endsAt)}`],
  ];
  if (e.description) params.push(["details", e.description]);
  if (e.location) params.push(["location", e.location]);
  return `https://calendar.google.com/calendar/render?${params.map(([k, v]) => `${q(k)}=${q(v)}`).join("&")}`;
}

/** Google Maps Universal URL for a venue: api version plus the venue query,
 * nothing else. The venue is untrusted text; RFC3986 encoding keeps quotes,
 * ampersands and markup inside the single query value. Both renderers share
 * this helper so the served hrefs are byte-identical. */
export function directionsUrl(venue: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${q(venue)}`;
}
