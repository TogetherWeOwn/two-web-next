import { safeRequestId } from "../../../src/request-log";
import type { LayoutServerLoad } from "./$types";

// Forward only the dispatch's validated support reference and verified display
// bit. No session, signed destination, cookie or DB read belongs in layout data.
// The hook keeps data requests and fragments notice-free and consumes only the
// released document that actually rendered the notice.
export const load: LayoutServerLoad = ({ locals }) => {
  return {
    requestId: safeRequestId(locals.requestId),
    restoredWrite: locals.restoredWrite === true,
  };
};
