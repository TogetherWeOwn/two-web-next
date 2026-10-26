import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../../src/admin/db";
import { resolveKitFeaturedEdit } from "../../../../../../src/admin/kit-featured-edit";
import { getFeatured } from "../../../../../../src/admin/store-featured";
import {
  featuredEditUrl,
  featuredReturnQuery,
  featuredReturnUrl,
} from "../../../../../../src/admin/featured-list-query";
import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono edit form ships no JavaScript beyond the
// deferred dirty-guard island, so the Kit form carries no hydration bundle
// that the CSP (script-src 'self') would block.
//
// Same guard posture as every other Kit admin page: the shared layout guard
// owns the guest bounce, the non-moderator 403 and the outage 503, and the
// hook's member-read boundary owns classification and the audit. The load
// awaits parent() first so a guard rejection propagates before any work.
// The read is the shared getFeatured through resolveKitFeaturedEdit with the
// Hono admission and failure posture (non-canonical/missing IDs 404, missing
// database or classified outage 503); an uncaught load rejection would render
// SvelteKit's 500 error page instead.
//
// POST /admin/featured/:id and POST /admin/featured/:id/delete stay
// Hono-owned: the manifest lists only this GET, so both ported forms keep
// submitting to the unchanged Hono controllers (parseFeaturedForm +
// updateFeatured/deleteFeatured, 422 re-render / 303 redirect) during mixed
// mode. The guarded /admin/featured-contents/:id/edit legacy redirect stays
// Hono-owned too.
export const csr = false;

export const load: PageServerLoad = async ({ parent, params, url, setHeaders }) => {
  // Layout and page loads can run concurrently; authorize before acquiring the database.
  await parent();
  const db = await dbFor({ env });
  const outcome = await resolveKitFeaturedEdit(params.id, {
    db,
    get: getFeatured,
    appUrl: env.APP_URL,
    imageHosts: env.FEATURED_IMAGE_HOSTS,
  });
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  if (outcome.kind === "notFound") error(404, "Featured content not found");
  setHeaders({ "cache-control": "private, no-store" });
  // The framework always supplies url; a missing value (minimal fixtures)
  // means no inventory context, keeping the direct-bookmark fallback.
  const inventory = featuredReturnQuery(url ? url.searchParams : new URLSearchParams());
  return {
    view: outcome.view,
    returnHref: inventory ? featuredReturnUrl(inventory) : null,
    saveHref: featuredEditUrl(outcome.view.id, inventory),
    deleteHref: featuredEditUrl(outcome.view.id, inventory, true),
  };
};
