import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { dbFor, type EnvWithAdminDb } from "../../../../src/admin/db";
import { dashboardJoinFunnel, FUNNEL_READ_DEADLINE_MS } from "../../../../src/admin/join-funnel";
import { resolveDashboardWidgets } from "../../../../src/admin/kit-dashboard";
import { JOIN_RETENTION_DAYS } from "../../../../src/admin/reads";
import { databaseUrl } from "../../../../src/db/connection";
import { topZeroResultSearches } from "../../../../src/events/search-log";
import { safeRequestId } from "../../../../src/request-log";
import type { PageServerLoad } from "./$types";

// Same reads and failure posture as the Hono dashboard
// (src/admin/routes.tsx): the two optional analytics widgets start together
// under one deadline and degrade to omitted sections when the database is
// absent or a widget fails — missing analytics never fail the page. A
// classified database outage is the one exception: the funnel rethrows it so
// the shared sanitized 503 handler can answer, and the Hono guard's
// memberReadBoundary turns it into the databaseUnavailable envelope. An
// uncaught load rejection would render SvelteKit's 500 error page instead,
// so the load settles both widgets before deciding and maps the outage to
// the same 503 (resolveDashboardWidgets, src/admin/kit-dashboard.ts).
// Authorization stays in the layout guard; the member-read boundary around
// resolve() owns classification and the audit. No new queries: both widgets
// are the shared bounded helpers, outcomes only, no member subjects.
export const load: PageServerLoad = async ({ parent, request, locals }) => {
  const { actor } = await parent();
  const db = await dbFor({ env });
  // Match dbFor's precedence: an injected ADMIN_DB overrides either URL, so
  // the funnel cache scopes to the same identity the Hono route uses.
  const identity = (env as EnvWithAdminDb).ADMIN_DB || databaseUrl(env) || db;
  if (!db) {
    return {
      actor,
      funnel: undefined,
      zeroSearches: undefined,
      retentionDays: JOIN_RETENTION_DAYS,
    };
  }
  const [funnelSettled, zeroSettled] = await Promise.allSettled([
    dashboardJoinFunnel(db, identity),
    topZeroResultSearches(db, 10, FUNNEL_READ_DEADLINE_MS),
  ]);
  const widgets = resolveDashboardWidgets(funnelSettled, zeroSettled);
  if (widgets.outage) error(503, "Admin temporarily unavailable");
  // One correlated line per degraded widget, same contract as the Hono twin:
  // with a db present, a settled value of undefined is exactly the degraded
  // signal for both helpers. Outages threw above. Request may be absent in
  // unit tests that call load({ parent }); tolerate that. Each id candidate
  // is validated before fallback selection, so an invalid cf-ray never
  // shadows a valid x-request-id or locals id.
  const requestId =
    safeRequestId((request as Request | undefined)?.headers?.get("cf-ray")) ??
    safeRequestId((request as Request | undefined)?.headers?.get("x-request-id")) ??
    safeRequestId((locals as { requestId?: unknown } | undefined)?.requestId);
  if (funnelSettled.status !== "fulfilled" || funnelSettled.value === undefined) {
    console.warn("dashboard widget degraded", { widget: "funnel", request_id: requestId });
  }
  if (zeroSettled.status !== "fulfilled" || zeroSettled.value === undefined) {
    console.warn("dashboard widget degraded", {
      widget: "zero_searches",
      request_id: requestId,
    });
  }
  const { funnel, zeroSearches } = widgets;
  return {
    actor,
    funnel,
    zeroSearches: zeroSearches?.map((r) => ({
      query: r.query,
      searches: r.searches,
      lastSearchedAt: r.lastSearchedAt.toISOString(),
    })),
    retentionDays: JOIN_RETENTION_DAYS,
  };
};
