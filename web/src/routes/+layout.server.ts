import { safeRequestId } from "../../../src/request-log";
import type { LayoutServerLoad } from "./$types";

// Root layout data: forward the dispatch's validated request id to every page
// and error boundary as page.data.requestId. No session, cookie or DB reads —
// the hook merged the id into locals before resolve, so this load only
// re-validates and forwards it. Error boundaries render it as the Hono-style
// support reference; when no id exists the prop stays undefined and the
// shell omits the block blank-safe.
export const load: LayoutServerLoad = ({ locals }) => {
  return { requestId: safeRequestId(locals.requestId) };
};
