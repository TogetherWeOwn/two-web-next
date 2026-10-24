// Kit admin dashboard widget outage classification. The dashboard load
// (web/src/routes/admin/+page.server.ts) is a thin SvelteKit binding around
// this: cloudflare:workers + SvelteKit imports stay out of the root test
// process, so the decision lives here where unit tests can drive it.
//
// Framework-free by construction, like src/admin/kit-guard.ts: it classifies
// already-settled widget outcomes, performs zero reads, and never touches
// cookies, the session, or the audit. The member-read boundary around
// resolve() still owns classification and the audit; this only tells the
// load which HTTP posture the Hono dashboard keeps.
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../db/errors";

export type DashboardWidgetOutage = { outage: true };
export type DashboardWidgetValues<F, Z> = {
  outage: false;
  funnel: F | undefined;
  zeroSearches: Z | undefined;
};

/**
 * Decide the dashboard posture from the settled widget reads. A classified
 * database outage in either widget answers the shared 503 (the Hono guard's
 * memberReadBoundary turns the funnel's rethrown outage into the
 * databaseUnavailable envelope; SvelteKit would otherwise render its 500
 * error page for the uncaught rejection). Any other rejection resolves to
 * undefined, which the page shows as unavailable for this load, exactly like
 * the widgets' own undefined resolves. Missing analytics never fail the page.
 */
export function resolveDashboardWidgets<F, Z>(
  funnel: PromiseSettledResult<F | undefined>,
  zeroSearches: PromiseSettledResult<Z | undefined>,
): DashboardWidgetOutage | DashboardWidgetValues<F, Z> {
  for (const settled of [funnel, zeroSearches]) {
    if (
      settled.status === "rejected" &&
      isDatabaseUnavailable(settled.reason) &&
      !isDatabaseQueryCancellation(settled.reason)
    ) {
      return { outage: true };
    }
  }
  return {
    outage: false,
    funnel: funnel.status === "fulfilled" ? funnel.value : undefined,
    zeroSearches: zeroSearches.status === "fulfilled" ? zeroSearches.value : undefined,
  };
}
