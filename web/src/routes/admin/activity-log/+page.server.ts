import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { loadActivityLogPage } from "../../../../../src/admin/kit-activity-log";
import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono viewer ships no JavaScript (plain GET form,
// no island), so the Kit viewer carries no hydration bundle that the CSP
// (script-src 'self') would block.
export const csr = false;

// Thin binding over the tested helper (src/admin/kit-activity-log.ts): the
// helper owns the bounded subject/causer filters, the newest-first paging and
// the one-setHeaders-per-path cache policy (SvelteKit throws
// `header_already_set` on a double-set; a throw below already set private,
// no-store). This binding owns only the 503 mapping — only error(503) proves
// what Kit sends, since SvelteKit ignores the helper's status:503 property.
// Authorization stays in the layout guard; the member-read boundary around
// resolve() owns classification and the audit. The guard must settle first:
// SvelteKit starts layout and page loads together, so the read below waits
// on parent() — a guest 302 or non-moderator 403 propagates before any
// database work, and no access-log subject is ever declared for a refused
// request. Keep the await outside the try: only helper failures map to 503.
// No new queries: the helper
// calls the shared listActivityLog projection, which never selects
// `properties`, so raw before/after maps cannot render.
export const load: PageServerLoad = async ({ parent, url, locals, setHeaders }) => {
  await parent();
  try {
    return await loadActivityLogPage({
      env,
      subjectParam: url.searchParams.get("subject"),
      causerParam: url.searchParams.get("causer"),
      pageParam: url.searchParams.get("page"),
      setHeaders,
      requestId: locals.requestId,
    });
  } catch {
    error(503, "Admin temporarily unavailable");
  }
};
