import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../src/admin/db";
import { resolveKitFeaturedList } from "../../../../../src/admin/kit-featured";
import { listFeatured } from "../../../../../src/admin/store-featured";
import {
  featuredListUrl,
  type FeaturedListQuery,
} from "../../../../../src/admin/featured-list-query";
import type { PageServerLoad } from "./$types";
import { featuredEditUrl } from "../../../../../src/admin/featured-list-query";

function sortHeader(query: FeaturedListQuery, sort: FeaturedListQuery["sort"], label: string) {
  const active = query.sort === sort;
  const next = active && query.order === "asc" ? "desc" : "asc";
  return {
    href: featuredListUrl(query, { sort, order: next, page: 1 }),
    ariaSort: active ? (query.order === "asc" ? "ascending" : "descending") : "none",
    ariaLabel: `Sort by ${label.toLowerCase()} ${next === "asc" ? "ascending" : "descending"}`,
    text: label + (active ? (query.order === "asc" ? " ↑" : " ↓") : ""),
  } as const;
}

// Same reads and failure posture as the Hono GET /admin/featured handler
// (src/admin/routes.tsx, admin.featured.index): the shared bounded
// listFeatured read over the moderator's search/pagination query, sliced to
// one page with a lookahead. A missing database or a classified outage
// answers the same 503 the Hono dbOr503 path serves (resolveKitFeaturedList,
// src/admin/kit-featured.ts); an uncaught load rejection would render
// SvelteKit's 500 error page instead. Authorization stays in the layout
// guard; the hook's member-read boundary owns classification and the audit.
// New/edit links stay on the existing /admin/featured/* paths, which Hono
// serves until the form slice migrates, so every link works during mixed
// mode. No new queries: the list read is the shared store helper.
export const load: PageServerLoad = async ({ parent, setHeaders, url }) => {
  // Layout and page loads can run concurrently; authorize before acquiring the database.
  await parent();
  const db = await dbFor({ env });
  // Match Hono's first value for repeated query keys.
  const outcome = await resolveKitFeaturedList(
    Object.fromEntries([...url.searchParams].reverse()),
    {
      db,
      list: listFeatured,
    },
  );
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  setHeaders({ "cache-control": "private, no-store" });
  return {
    rows: outcome.rows,
    editHrefs: Object.fromEntries(
      outcome.rows.map((row) => [row.id, featuredEditUrl(row.id, outcome.query)]),
    ),
    query: outcome.query,
    hasNext: outcome.hasNext,
    emptyText: outcome.emptyText,
    positionHeader: sortHeader(outcome.query, "position", "Position"),
    updatedHeader: sortHeader(outcome.query, "updated_at", "Last changed"),
    previousHref:
      outcome.query.page > 1
        ? featuredListUrl(outcome.query, { page: outcome.query.page - 1 })
        : null,
    nextHref: outcome.hasNext
      ? featuredListUrl(outcome.query, { page: outcome.query.page + 1 })
      : null,
  };
};
