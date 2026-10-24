// Admin 429 way-back mapping: a refused admin write resolves to the admin GET
// form it came from. Shared by the Hono 429 shell (src/error-responses.tsx)
// and the Kit error boundary (web/src/routes/+error.svelte) so both twins
// offer the identical way back. Pure string matching only: no session, cookie
// or DB reads, so the link stays offerable during the outage it reports.

export interface AdminWayBack {
  /** Admin GET href of the form the refused write came from. */
  href: string;
  /** Link label naming the throttled save. */
  label: string;
}

/**
 * Status-gated way back for the Kit error boundary: a throttled admin write
 * (429) resolves to its form; every other status resolves to nothing, so the
 * shared 429/500 shell never names a refused save it cannot mean. Pure string
 * matching only: no session, cookie or DB reads.
 */
export function adminWayBackForStatus(status: number, path: string): AdminWayBack | null {
  if (status !== 429) return null;
  return adminWayBack(path);
}

/** Map a refused request path to its admin way back, or null outside /admin. */
export function adminWayBack(path: string): AdminWayBack | null {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (clean !== "/admin" && !clean.startsWith("/admin/")) return null;
  if (clean === "/admin/events") {
    return { href: "/admin/events/new", label: "Back to the new event form" };
  }
  // An update and a lifecycle action refuse onto the same editor.
  const event =
    /^\/admin\/events\/([^/]+)(\/publish|\/cancel|\/duplicate|\/rsvp-pause|\/rsvp-reopen)?$/.exec(
      clean,
    );
  if (event) {
    return { href: `/admin/events/${event[1]}`, label: "Back to the event editor" };
  }
  if (clean === "/admin/featured") {
    return { href: "/admin/featured/new", label: "Back to the new featured form" };
  }
  // A refused delete changed nothing, so the editor is still the way back.
  const featured = /^\/admin\/featured\/([^/]+)(\/delete)?$/.exec(clean);
  if (featured) {
    return { href: `/admin/featured/${featured[1]}`, label: "Back to the featured editor" };
  }
  const redispatch = /^\/admin\/queue\/failed\/([^/]+)\/redispatch$/.exec(clean);
  if (redispatch) {
    return {
      href: `/admin/queue/failed/${redispatch[1]}/preview`,
      label: "Back to the queue preview",
    };
  }
  return { href: "/admin", label: "Back to the admin dashboard" };
}
