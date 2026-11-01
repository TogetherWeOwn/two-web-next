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

/**
 * Sign-in/join return destination (`?next=`): normalized archive + attendee
 * context only, never the raw request query. Auth refuses a decoded next
 * over its byte cap, so a destination that would cross `maxBytes` (a long
 * Unicode archive search percent-encodes to several bytes per character)
 * drops the archive context whole — never truncated mid-search — and keeps
 * the attendee page; the bare event path is the final fallback.
 */
export function authReturnHref(
  eventKey: string,
  archive: ArchiveContext | null | undefined,
  attendeePage: number,
  maxBytes: number,
): string {
  const fits = (href: string) => new TextEncoder().encode(href).byteLength <= maxBytes;
  const withArchive = archiveEventHref(eventKey, archive, attendeePage);
  if (fits(withArchive)) return withArchive;
  const pageOnly = archiveEventHref(eventKey, null, attendeePage);
  return fits(pageOnly) ? pageOnly : attendeePageHref(eventKey, 1);
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
