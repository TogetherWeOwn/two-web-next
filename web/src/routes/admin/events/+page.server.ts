import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../src/admin/db";
import { eventListParams, parseEventListQuery } from "../../../../../src/admin/event-list";
import { buildEventListView } from "../../../../../src/admin/kit-events";
import { listEvents } from "../../../../../src/admin/store-event-reads";
import { isDatabaseUnavailable } from "../../../../../src/db/errors";
import { alertRequestError } from "../../../../../src/alerts";
import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono events list ships no JavaScript (plain GET
// search/sort forms, no island), so the Kit viewer carries no hydration bundle
// that the CSP (script-src 'self') would block.
//
// Same reads and failure posture as the Hono events list
// (src/admin/routes.tsx, admin.events.index): the shared bounded listEvents
// helper (EVENT_PAGE_SIZE + 1 rows, no count query, Going-only seat counts),
// raw query params in (the helper re-parses them, exactly like the Hono
// handler passing c.req.query()), and the normalized query out for the
// search form and paging links. Authorization stays in the layout guard; the
// member-read boundary around resolve() owns classification and the audit.
// The guard must settle first: SvelteKit starts layout and page loads
// together, so the read below waits on parent() — a guest 302 or
// non-moderator 403 propagates before any database work. Keep the await
// outside the try: only store failures map to 503.
// No database answers the shared 503, and a classified database outage maps
// to the same 503 — an uncaught load rejection would render SvelteKit's 500
// error page instead. Any other failure emits the leak-free error.alert
// diagnostic first (mirroring the event-edit resolver legs), then rethrows,
// like the Hono boundary's 500. Exactly one setHeaders call on the success
// path: SvelteKit throws `header_already_set` on a double-set, so the error
// paths set none.
// POST /admin/events, /new and /:key stay Hono-owned: the manifest lists only
// this GET, so the ported search/sort forms and the row publish/cancel/RSVP
// forms keep submitting to the unchanged Hono handlers during mixed mode.
export const csr = false;

export const load: PageServerLoad = async ({ parent, url, setHeaders }) => {
  await parent();
  const db = await dbFor({ env });
  if (!db) error(503, "Admin temporarily unavailable");
  // First value wins per key (the date bounds keep every repeat so the shared
  // parser can refuse duplicates), identical to the Hono handler.
  const raw = eventListParams(url.searchParams);
  const query = parseEventListQuery(raw);
  let fetched;
  try {
    fetched = await listEvents(db, raw);
  } catch (err) {
    if (isDatabaseUnavailable(err)) error(503, "Admin temporarily unavailable");
    alertRequestError(err, { method: "GET", route: "/admin/events" });
    throw err;
  }
  setHeaders({ "cache-control": "private, no-store" });
  return buildEventListView(query, fetched);
};
