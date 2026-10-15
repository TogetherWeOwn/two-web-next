import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono new form ships no JavaScript beyond the
// deferred dirty-guard island, so the Kit form carries no hydration bundle
// that the CSP (script-src 'self') would block.
//
// Same guard posture as every other Kit admin page: the shared layout guard
// owns the guest bounce, the non-moderator 403 and the outage 503, and the
// hook's member-read boundary owns classification and the audit. The load
// awaits parent() first so a guard rejection propagates before any work —
// there is no database read on this route (the Hono GET /admin/featured/new
// handler renders the empty form with no store access), so there is nothing
// else to fail. Exactly one setHeaders call on the success path: SvelteKit
// throws `header_already_set` on a double-set.
//
// POST /admin/featured stays Hono-owned: the manifest lists only this GET,
// so the ported form keeps submitting to the unchanged Hono create handler
// (parseFeaturedForm + createFeatured, 422 re-render / 303 redirect) during
// mixed mode. The guarded /admin/featured-contents/create legacy redirect
// stays Hono-owned too.
export const csr = false;

export const load: PageServerLoad = async ({ parent, setHeaders }) => {
  // Layout and page loads can run concurrently; authorize before anything else.
  await parent();
  setHeaders({ "cache-control": "private, no-store" });
  return {};
};
