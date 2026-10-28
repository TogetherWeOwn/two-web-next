import { env } from "cloudflare:workers";
import { isRestoredBannerEligible, readReturnJourney } from "../../../src/kit-session";
import { safeRequestId } from "../../../src/request-log";
import type { LayoutServerLoad } from "./$types";

// Every page and error boundary inherits the validated support reference.
// Eligible documents also inherit the signed restored-write notice, which
// their shells render first inside <main>. This is a read-only cookie peek:
// no session lookup or database access, and no consumption before the hook
// releases a successful HTML response. Excluded requests keep the reference
// but never read or render a notice.
export const load: LayoutServerLoad = async ({ request, locals }) => {
  const requestId = safeRequestId(locals.requestId);
  if (!isRestoredBannerEligible(request)) return { requestId, restoredWrite: null };
  const journey = await readReturnJourney(request, env.SESSION_SECRET);
  return { requestId, restoredWrite: journey.restoredWrite };
};
