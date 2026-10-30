import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { alertRequestError } from "../../../../../../src/alerts";
import { dbFor } from "../../../../../../src/admin/db";
import { resolveFeaturedReuse } from "../../../../../../src/admin/featured-reuse";
import { getFeatured } from "../../../../../../src/admin/store-featured";
import type { PageServerLoad } from "./$types";

// Server-rendered only, like the Hono form. The load awaits parent() first
// (layout guard owns admission; the hook boundary owns classification), then
// the shared reuse resolver: ordinary traffic reads nothing, one canonical
// source spends one getFeatured read, a classified outage answers 503.
// Exactly one setHeaders call. POST stays Hono-owned.
export const csr = false;

export const load: PageServerLoad = async ({ parent, url, setHeaders }) => {
  await parent();
  let outcome;
  try {
    outcome = await resolveFeaturedReuse(
      url?.searchParams ?? new URLSearchParams(),
      () => dbFor({ env }),
      getFeatured,
    );
  } catch (err) {
    // A code bug must not look like a downstream outage (kit-featured-edit.ts).
    alertRequestError(err, { method: "GET", route: "/admin/featured/new" });
    throw err;
  }
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  setHeaders({ "cache-control": "private, no-store" });
  // The ordinary empty model stays empty; only a reuse visit carries data.
  return outcome.notice === null ? {} : { values: outcome.values, notice: outcome.notice };
};
