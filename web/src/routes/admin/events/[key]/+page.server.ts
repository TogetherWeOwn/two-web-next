import { error } from "@sveltejs/kit";
import { loadGameSuggestions } from "../../../../../../src/events/game-suggestions";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../../src/admin/db";
import { resolveKitEventEdit } from "../../../../../../src/admin/kit-event-edit";
import { getEvent } from "../../../../../../src/admin/store-event-reads";
import { listRoster } from "../../../../../../src/admin/reads";
import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono edit form ships only progressive islands
// (text-limits + dirty-navigation editor), so the Kit viewer carries no
// hydration bundle that the CSP (script-src 'self') would block.
//
// Same reads and failure posture as the Hono edit form
// (src/admin/routes.tsx, admin.events.edit): the shared getEvent read (a
// missing key 404s), the same eventValues wall fill, and the shared bounded
// listRoster page with the raw roster query in (the resolver re-parses it,
// exactly like the Hono handler passing c.req.query()). Authorization stays
// in the layout guard; the hook's member-read boundary owns classification
// and the audit, so a failed audit refuses the whole render and no roster
// byte escapes. The guard must settle first: SvelteKit starts layout and
// page loads together, so the read below waits on parent() — a guest 302 or
// non-moderator 403 propagates before any database work. Keep the await
// outside the try: only store failures map to 503.
// No database answers the shared 503, and a classified database outage maps
// to the same 503 — an uncaught load rejection would render SvelteKit's 500
// error page instead. Any other failure rethrows, like the Hono boundary's
// 500. Exactly one setHeaders call on the success path: SvelteKit throws
// `header_already_set` on a double-set.
// POST /admin/events/:key, the publish/cancel/RSVP-pause/RSVP-reopen siblings
// and the guarded /admin/events/:key/edit legacy redirect stay Hono-owned:
// the ported edit, status and roster forms keep submitting to the unchanged
// Hono controllers (UTC carriers, future recurrence propagation, 422
// re-render / 303 redirect, postcommit writeback) during mixed mode, and
// there is no event delete anywhere on this resource.
export const csr = false;

export const load: PageServerLoad = async ({ parent, params, url, setHeaders }) => {
  await parent();
  const db = await dbFor({ env });
  // First value wins per key, matching the Hono handler's c.req.query():
  // Object.fromEntries(url.searchParams) would keep the last duplicate.
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in raw)) raw[k] = v;
  const outcome = await resolveKitEventEdit(params.key, raw, {
    appUrl: env.APP_URL,
    db,
    get: getEvent,
    list: listRoster,
  });
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  if (outcome.kind === "notFound") error(404, "Event not found");
  setHeaders({ "cache-control": "private, no-store" });
  const games = await loadGameSuggestions(db);
  return { view: outcome.view, games };
};
