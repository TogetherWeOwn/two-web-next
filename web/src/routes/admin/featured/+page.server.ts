import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../src/admin/db";
import { resolveKitFeaturedList } from "../../../../../src/admin/kit-featured";
import { listFeatured } from "../../../../../src/admin/store-featured";
import type { PageServerLoad } from "./$types";

// Same reads and failure posture as the Hono GET /admin/featured handler
// (src/admin/routes.tsx, admin.featured.index): the shared bounded
// listFeatured read over the moderator's filter/pagination query, sliced to
// one page with a lookahead. A missing database or a classified outage
// answers the same 503 the Hono dbOr503 path serves (resolveKitFeaturedList,
// src/admin/kit-featured.ts); an uncaught load rejection would render
// SvelteKit's 500 error page instead. Authorization stays in the layout
// guard; the hook's member-read boundary owns classification and the audit.
// New/edit links stay on the existing /admin/featured/* paths, which Hono
// serves until the form slice migrates, so every link works during mixed
// mode. No new queries: the list read is the shared store helper.
export const load: PageServerLoad = async ({ setHeaders, url }) => {
  // No parent() read: the page shows no actor chrome (like the Hono
  // FeaturedPage), and the layout guard runs before every child load.
  const db = await dbFor({ env });
  const outcome = await resolveKitFeaturedList(Object.fromEntries(url.searchParams.entries()), {
    db,
    list: listFeatured,
  });
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  setHeaders({ "cache-control": "private, no-store" });
  return {
    rows: outcome.rows,
    query: outcome.query,
    hasNext: outcome.hasNext,
    emptyText: outcome.emptyText,
  };
};
