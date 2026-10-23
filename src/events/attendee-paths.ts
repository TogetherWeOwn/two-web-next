// Native attendee-page URL builders, shared across renderers.
//
// Page 1 stays bare so first-page links reset the section; later pages carry
// ?attendees=<n>. attendeePageHref preserves the existing contract for canonical
// stored event keys and caller-normalized pages. The RSVP action and return
// builders instead accept route-input keys: they encode the key and fall back
// to page 1 for malformed or unsafe page numbers.
//
// Framework-free so the refusal core and Svelte/Kit renderers can share URL
// builders without pulling in the reads layer or server-side input parsing.
import { pastEventsUrl } from "../islands/contracts-past-events";

export function attendeePageHref(eventKey: string, page: number): string {
  return page <= 1 ? `/e/${eventKey}` : `/e/${eventKey}?attendees=${page}`;
}

export interface ArchiveContext {
  page: number;
  q: string;
}

/** Only normalized archive state travels with a detail/roster link, never a return URL. */
export function archiveEventHref(
  eventKey: string,
  archive: ArchiveContext | null | undefined,
  attendeePage = 1,
): string {
  const path = attendeePageHref(eventKey, attendeePage);
  if (!archive) return path;
  const [base, search] = path.split("?");
  const params = new URLSearchParams(search);
  params.set("archivePage", String(archive.page));
  if (archive.q) params.set("archiveQuery", archive.q);
  return `${base}?${params}`;
}

export function archiveReturnHref(archive: ArchiveContext | null | undefined): string | null {
  return archive ? pastEventsUrl(archive.page, archive.q) : null;
}

export function archiveReturnLink(archive: ArchiveContext | null | undefined) {
  const href = archiveReturnHref(archive);
  return href
    ? { href, label: archive?.q ? "← Back to search results" : "← Back to past events" }
    : null;
}

export function rsvpPageReturnPath(eventKey: string, page: number): string {
  const base = `/e/${encodeURIComponent(eventKey)}`;
  return Number.isSafeInteger(page) && page > 1 ? `${base}?attendees=${page}` : base;
}

/** Native RSVP form action: the /rsvp suffix stays BEFORE the page query so
 * the POST route still matches with page context attached. */
export function rsvpActionHref(eventKey: string, page: number): string {
  const base = `/e/${encodeURIComponent(eventKey)}/rsvp`;
  return Number.isSafeInteger(page) && page > 1 ? `${base}?attendees=${page}` : base;
}
