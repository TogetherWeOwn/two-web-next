import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../src/admin/db";
import { JOIN_RETENTION_DAYS, listJoinAttempts } from "../../../../../src/admin/reads";
import {
  JOIN_ATTEMPT_PAGE_SIZE,
  joinAttemptsUrl,
  parseJoinAttemptsQuery,
} from "../../../../../src/admin/table-list";
import { isDatabaseUnavailable } from "../../../../../src/db/errors";
import { alertRequestError } from "../../../../../src/alerts";
import { JOIN_OUTCOMES } from "../../../../../src/join/service";
import type { PageServerLoad } from "./$types";

// Server-rendered only (csr=false comes from the admin group layout): no
// hydration bundle, so no inline bootstrap script that the CSP (script-src
// 'self') would block. The filter form is a plain GET form and paging is
// plain links, exactly like the Hono viewer.

// Same reads and failure posture as the Hono GET /admin/join-attempts handler
// (src/admin/routes.tsx): the bounded retention-window list with the exact
// Discord/request-id search, newest first, plus a one-row next-page
// lookahead. No DB answers the shared 503; a classified database outage maps
// to the same 503 instead of SvelteKit's 500 error page. Any other rejection
// emits the leak-free error.alert diagnostic first (mirroring the detail
// resolver), then renders that branded 500 shell, which the hook's
// member-read boundary releases only after its audit decision.
// Authorization stays in the layout guard; the member-read boundary around
// resolve() owns classification and the audit. No new queries: the list and
// its lookahead are the one shared keyed read, outcomes only plus the
// retrieved owners as audit subjects.
export const load: PageServerLoad = async ({ url, setHeaders, parent }) => {
  // Layout and page loads run concurrently; wait for moderator admission
  // before opening the database or starting the audited member read.
  await parent();
  const query = parseJoinAttemptsQuery({
    outcome: url.searchParams.get("outcome") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
  });
  const db = await dbFor({ env });
  if (!db) error(503, "Admin temporarily unavailable");
  let fetched;
  try {
    fetched = await listJoinAttempts(db, query);
  } catch (err) {
    if (isDatabaseUnavailable(err)) error(503, "Admin temporarily unavailable");
    alertRequestError(err, { method: "GET", route: "/admin/join-attempts" });
    throw err;
  }
  setHeaders({ "cache-control": "private, no-store" });
  const rows = fetched.slice(0, JOIN_ATTEMPT_PAGE_SIZE).map((row) => ({
    id: row.id,
    outcome: row.outcome,
    source: row.source,
    requestId: row.requestId,
    discordId: row.discordId,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    rows,
    query,
    hasNext: fetched.length > JOIN_ATTEMPT_PAGE_SIZE,
    prevUrl: query.page > 1 ? joinAttemptsUrl(query, query.page - 1) : null,
    nextUrl:
      fetched.length > JOIN_ATTEMPT_PAGE_SIZE ? joinAttemptsUrl(query, query.page + 1) : null,
    outcomes: [...JOIN_OUTCOMES],
    retentionDays: JOIN_RETENTION_DAYS,
  };
};
