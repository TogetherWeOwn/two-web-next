// W9 calendar feeds: pure builders ported byte-for-byte from two-web's
// EventIcs / EventRss / EventSubscribe / EventGoogleCalendar. No query, no auth, no HTTP.
import type { events } from "../db/admin-schema";
import { stripTrailingSlash } from "../seo";
import { rssXml as xml } from "./rss-xml";

type EventRow = typeof events.$inferSelect;

export const SITE_NAME = "Together We Own";

const pad = (n: number) => String(n).padStart(2, "0");

/** PHP `Ymd\THis\Z` for a UTC instant. */
export function icsInstant(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** PHP `DATE_RSS` (`D, d M Y H:i:s O`) in UTC, i.e. `+0000`. */
export function rssDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** RFC 5545 §3.3.11 escaping: backslash, semicolon, comma, newlines. */
function text(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
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

/** SEQUENCE is a nonnegative signed 32-bit INTEGER (§3.3.8, §3.8.7.4). */
function icsSequence(sequence: bigint): string {
  // Preserve the stored/imported bigint; never clamp, wrap or reset its ordering.
  // Exhausted revisions fail the export until an explicit identity migration.
  if (sequence < 0n || sequence > 2147483647n) throw new IcsSequenceRangeError();
  return sequence.toString();
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
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${text(e.description)}`);
  if (e.location) lines.push(`LOCATION:${text(e.location)}`);
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

function calendar(inner: string[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TogetherWeOwn//Events//EN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(`${SITE_NAME} Events`)}`,
    `X-WR-CALDESC:${text(`Upcoming events from ${SITE_NAME}`)}`,
    ...inner,
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export const eventIcs = (e: EventRow, appUrl: string): string => calendar(vevent(e, appUrl));

export const eventsIcsCollection = (rows: EventRow[], appUrl: string): string =>
  calendar(rows.flatMap((e) => vevent(e, appUrl)));

export function eventsRss(rows: EventRow[], appUrl: string, lastBuild: Date): string {
  const base = feedBase(appUrl);
  const items = rows
    .map((e) => {
      const url = xml(pageUrl(e, appUrl));
      return (
        `<item><title>${xml(e.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid>` +
        `<pubDate>${rssDate(e.startsAt)}</pubDate>` +
        (e.description ? `<description>${xml(e.description)}</description>` : "") +
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

export const feedUrl = (appUrl: string) => `${feedBase(appUrl)}/events.ics`;
export const rssUrl = (appUrl: string) => `${feedBase(appUrl)}/events.rss`;
export const webcalUrl = (appUrl: string) => feedUrl(appUrl).replace(/^https?:\/\//, "webcal://");

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
