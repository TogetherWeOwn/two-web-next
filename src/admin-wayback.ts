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

const LIFECYCLE_ACTIONS = ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const;

/** Map a refused request path to its admin way back, or null outside /admin. */
export function adminWayBack(path: string): AdminWayBack | null {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (clean !== "/admin" && !clean.startsWith("/admin/")) return null;
  if (clean === "/admin/events") {
    return { href: "/admin/events/new", label: "Back to the new event form" };
  }
  const lifecycle = new RegExp(`^/admin/events/([^/]+)/(${LIFECYCLE_ACTIONS.join("|")})$`).exec(
    clean,
  );
  if (lifecycle) {
    return { href: `/admin/events/${lifecycle[1]}`, label: "Back to the event editor" };
  }
  const eventUpdate = /^\/admin\/events\/([^/]+)$/.exec(clean);
  if (eventUpdate) {
    return { href: `/admin/events/${eventUpdate[1]}`, label: "Back to the event editor" };
  }
  if (clean === "/admin/featured") {
    return { href: "/admin/featured/new", label: "Back to the new featured form" };
  }
  const featuredDelete = /^\/admin\/featured\/([^/]+)\/delete$/.exec(clean);
  if (featuredDelete) {
    // The refused delete changed nothing, so the editor is still the way back.
    return { href: `/admin/featured/${featuredDelete[1]}`, label: "Back to the featured editor" };
  }
  const featuredUpdate = /^\/admin\/featured\/([^/]+)$/.exec(clean);
  if (featuredUpdate) {
    return { href: `/admin/featured/${featuredUpdate[1]}`, label: "Back to the featured editor" };
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
