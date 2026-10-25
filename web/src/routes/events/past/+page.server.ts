import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { listPast } from "../../../../../src/events/reads";
import { loadPastArchivePage, toPublicPastArchiveRow } from "../../../../../src/kit-past-events";
import { MAX_QUERY_LENGTH } from "../../../../../src/events/search-log";
import { EVENTS_SEARCH_TOO_LONG_COPY } from "../../../../../src/islands/contracts";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block. The archive island stays the
// existing /islands/past-events.js, exactly as on the Hono page.
export const csr = false;

// Thin binding over the tested helper (src/kit-past-events.ts): the helper
// owns the reads and the one-setHeaders-per-path cache policy (SvelteKit
// throws `header_already_set` on a double-set; a throw below already set
// private, no-store). This binding owns the 503 mapping and the helper args,
// each pinned by source tests in test/kit-past-events.test.ts — only
// error(503) proves what Kit sends, since SvelteKit ignores the helper's
// status:503 Error property.
export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  // Admission stays outside the outage catch: 422 is not a database failure.
  if ([...(url.searchParams.get("q") ?? "")].length > MAX_QUERY_LENGTH) {
    setHeaders({ "cache-control": "private, no-store" });
    error(422, EVENTS_SEARCH_TOO_LONG_COPY);
  }
  try {
    const data = await loadPastArchivePage({
      env,
      pageParam: url.searchParams.get("page"),
      queryParam: url.searchParams.get("q"),
      setHeaders,
      dbForFn: dbFor,
      listPastFn: listPast,
      // The dispatch's served request id: the 503 page and x-request-id
      // carry this same value, so the alert must name it too
      // (safeRequestId inside the alert drops anything unvalidated).
      requestId: locals.requestId,
    });
    // Projected before returning: Kit serializes load data into __data.json
    // for anonymous clients even with csr=false, so the authorship
    // snowflake and other unrendered row fields never ride the rows (the
    // join precedent: toPublicWidgetSnapshot). The card only reads the
    // projected fields, so the view is unchanged.
    return { ...data, rows: data.rows.map(toPublicPastArchiveRow) };
  } catch {
    error(503, "Events temporarily unavailable");
  }
};
