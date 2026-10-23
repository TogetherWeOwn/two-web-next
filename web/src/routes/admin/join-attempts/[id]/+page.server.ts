import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../../src/admin/db";
import { resolveKitJoinAttemptDetail } from "../../../../../../src/admin/kit-join-attempt-detail";
import { getJoinAttempt } from "../../../../../../src/admin/reads";
import { joinAttemptReturnUrl } from "../../../../../../src/admin/table-list";
import type { PageServerLoad } from "./$types";

// Server-rendered only (csr=false comes from the admin group layout): no
// hydration bundle, so no inline bootstrap script that the CSP (script-src
// 'self') would block. The back navigation is a plain link, exactly like the
// Hono detail page.

// Same reads and failure posture as the Hono GET /admin/join-attempts/:id
// handler (src/admin/routes.tsx): the canonical-ID admission 404s before any
// record lookup, the shared getJoinAttempt retention-window lookup answers
// the row, and a missing row answers the same 404. No DB answers the shared
// 503; a classified database outage maps to the same 503 instead of
// SvelteKit's 500 error page. Any other rejection renders that branded 500
// shell, which the hook's member-read boundary releases only after its audit
// decision, so an audit failure still releases no trace data.
// Authorization stays in the layout guard; the member-read boundary around
// resolve() owns classification and the audit. No new queries, no raw
// provider/token payload: the shared projection carries only the six safe
// columns.
export const csr = false;

export const load: PageServerLoad = async ({ parent, params, setHeaders, url }) => {
  // Layout and page loads run concurrently; wait for moderator admission
  // before opening the database or starting the audited member read.
  await parent();
  const db = await dbFor({ env });
  const outcome = await resolveKitJoinAttemptDetail(params.id, { db, get: getJoinAttempt });
  if (outcome.kind === "unavailable") error(503, "Admin temporarily unavailable");
  if (outcome.kind === "notFound") error(404, "Join attempt not found");
  setHeaders({ "cache-control": "private, no-store" });
  return { view: outcome.view, returnUrl: joinAttemptReturnUrl(url) };
};
