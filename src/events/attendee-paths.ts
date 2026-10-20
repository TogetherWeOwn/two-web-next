// Native attendee-page URL builders, shared across renderers.
//
// The Hono form action, the detail-page refresh link, the POST redirect and
// the refusal return link all rebuild the same rooted destinations from a
// routed event key plus a page number. Page 1 stays bare so first-page links
// reset the section; later pages carry ?attendees=<n>. Keys from route input
// are encoded, while the page stays a validated integer so malformed or
// unsafe values can never escape the local destination.
//
// Framework-free: this module imports nothing, so the refusal core and the
// Svelte/Kit renderers can share it without pulling in the reads layer.
export function attendeePageHref(eventKey: string, page: number): string {
  return page <= 1 ? `/e/${eventKey}` : `/e/${eventKey}?attendees=${page}`;
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
