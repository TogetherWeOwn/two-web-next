import { eventEditUrl } from "../../../../../../../src/admin/event-edit-url";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

// The admin dispatcher admits moderators before resolving this endpoint.
export const GET: RequestHandler = ({ params }) =>
  new Response(null, {
    status: 301,
    headers: { location: eventEditUrl(params.key), "content-type": "text/plain; charset=UTF-8" },
  });
