import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

// The admin dispatcher admits moderators before resolving this endpoint.
export const GET: RequestHandler = () =>
  new Response("", { status: 301, headers: { location: "/admin/events/new" } });
