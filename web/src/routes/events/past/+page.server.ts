import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { listPast } from "../../../../../src/events/reads";
import { loadPastArchivePage } from "../../../../../src/kit-past-events";

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
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  try {
    return await loadPastArchivePage({
      env,
      pageParam: url.searchParams.get("page"),
      setHeaders,
      dbForFn: dbFor,
      listPastFn: listPast,
    });
  } catch {
    error(503, "Events temporarily unavailable");
  }
};
