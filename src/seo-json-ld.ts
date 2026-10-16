// A1: Organization/WebSite identities + Event JSON-LD improvements.
//
// Shared Hono-side builders (src/) for schema.org JSON-LD. The site graph
// (Organization + WebSite) carries stable @id values so AI consumers can
// join references across pages; event nodes reference the Organization via
// organizer.@id and carry a stable @id plus eventAttendanceMode.
//
// Online-only note: TWO events meet on Discord, so every event node uses
// OnlineEventAttendanceMode with a VirtualLocation. That pairing is factual,
// not a promise of Google rich results — online-only events are not eligible
// for Google's Event rich results, and this markup makes no such claim.
//
// Privacy: no Person, attendee, performer or RSVP data ever lands here.
// Attendee names stay in the visible HTML gated by membership; JSON-LD only
// repeats the public title, dates, venue text, description and canonical URL.

import { canonicalUrl, stripTrailingSlash } from "./seo";

export const ORGANIZATION_ID_SUFFIX = "/#organization";
export const WEBSITE_ID_SUFFIX = "/#website";
export const ONLINE_EVENT_ATTENDANCE_MODE = "https://schema.org/OnlineEventAttendanceMode";

const SITE_NAME = "Together We Own";
const SITE_DESCRIPTION = "Together We Own: a close-knit adult gaming community, founded 1998.";

/** Minimal public fields the Event node repeats from the visible page. */
export interface JsonLdEventInput {
  eventKey: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  // String, not the four-state union: PublicEvent.status arrives as a plain
  // string from Drizzle, and only "cancelled" changes the node.
  status: string;
}

const baseUrl = (appUrl: string): string => stripTrailingSlash(appUrl);

/** Stable Organization @id: {APP_URL}/#organization. */
export function organizationId(appUrl: string): string {
  return `${baseUrl(appUrl)}${ORGANIZATION_ID_SUFFIX}`;
}

/** Stable WebSite @id: {APP_URL}/#website. */
export function websiteId(appUrl: string): string {
  return `${baseUrl(appUrl)}${WEBSITE_ID_SUFFIX}`;
}

export function buildOrganization(appUrl: string): Record<string, unknown> {
  const base = baseUrl(appUrl);
  return {
    "@type": "Organization",
    "@id": organizationId(appUrl),
    name: SITE_NAME,
    url: base,
    logo: `${base}/logo.svg`,
    description: SITE_DESCRIPTION,
  };
}

export function buildWebSite(appUrl: string): Record<string, unknown> {
  const base = baseUrl(appUrl);
  return {
    "@type": "WebSite",
    "@id": websiteId(appUrl),
    url: base,
    name: SITE_NAME,
    publisher: { "@id": organizationId(appUrl) },
  };
}

export function buildSiteGraph(appUrl: string): {
  "@context": string;
  "@graph": Record<string, unknown>[];
} {
  return {
    "@context": "https://schema.org",
    "@graph": [buildOrganization(appUrl), buildWebSite(appUrl)],
  };
}

function eventLocation(location: string | null, base: string): Record<string, unknown> {
  if (location && /^https?:/.test(location)) {
    return { "@type": "VirtualLocation", url: location };
  }
  if (location) {
    return { "@type": "VirtualLocation", url: base, name: location };
  }
  return { "@type": "VirtualLocation", url: base };
}

export function buildEventNode(e: JsonLdEventInput, appUrl: string): Record<string, unknown> {
  const base = baseUrl(appUrl);
  const canonical = canonicalUrl(appUrl, `/e/${e.eventKey}`);
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    "@id": canonical,
    name: e.title,
    startDate: e.startsAt.toISOString(),
    endDate: e.endsAt.toISOString(),
    eventStatus:
      e.status === "cancelled"
        ? "https://schema.org/EventCancelled"
        : "https://schema.org/EventScheduled",
    eventAttendanceMode: ONLINE_EVENT_ATTENDANCE_MODE,
    location: eventLocation(e.location, base),
    ...(e.description ? { description: e.description } : {}),
    url: canonical,
    organizer: { "@id": organizationId(appUrl) },
  };
}

// Escapes the characters that could close the script element or start an HTML
// comment, the breakout class the legacy Blade block stopped with
// JSON_HEX_TAG|HEX_APOS|HEX_AMP|HEX_QUOT. Each replacement is a valid JSON
// string escape, and the function is idempotent: once escaped, nothing matches.
export function escapeJsonLdText(serialized: string): string {
  return serialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function safeJsonLd(value: unknown): string {
  return escapeJsonLdText(JSON.stringify(value));
}

/** Serialized site-identity graph for homepage and event pages. */
export function siteJsonLd(appUrl: string): string {
  return safeJsonLd(buildSiteGraph(appUrl));
}

/** Serialized top-level Event block for /e/{key} pages (detail + gone). */
export function eventJsonLd(e: JsonLdEventInput, appUrl: string): string {
  return safeJsonLd(buildEventNode(e, appUrl));
}
