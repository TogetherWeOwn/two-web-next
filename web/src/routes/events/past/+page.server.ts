import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { listPast, normalizePastPage } from "../../../../../src/events/reads";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block. The archive island stays the
// existing /islands/past-events.js, exactly as on the Hono page.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/events/routes.tsx).
// One setHeaders call per path: SvelteKit throws `header_already_set` when the
// same header is set twice, so the cache policy is chosen after the read.
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  let db;
  try {
    db = await dbFor({ env });
  } catch {
    setHeaders({ "cache-control": "private, no-store" });
    error(503, "Events temporarily unavailable");
  }
  if (!db) {
    setHeaders({ "cache-control": "private, no-store" });
    error(503, "Events temporarily unavailable");
  }
  const page = normalizePastPage(Number.parseInt(url.searchParams.get("page") ?? "1", 10));
  try {
    const { rows, hasMore, totalPages } = await listPast(db, page);
    setHeaders({
      "cache-control": "public, max-age=300",
      "x-two-past-cacheable": String(rows.length > 0),
    });
    return { rows, page, hasMore, totalPages, appUrl: env.APP_URL };
  } catch {
    setHeaders({ "cache-control": "private, no-store" });
    error(503, "Events temporarily unavailable");
  }
};
