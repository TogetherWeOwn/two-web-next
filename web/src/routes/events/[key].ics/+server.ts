import { env } from "cloudflare:workers";
import { kitEventCalendarKey } from "../../../../../src/events/kit-event-calendar-route";
import { fetchKitFeed } from "../../../../../src/events/kit-feed-fetch";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const trailingSlash = "ignore";

export const GET: RequestHandler = async ({ request, locals }) => {
  const key = kitEventCalendarKey(request);
  if (key === undefined) return new Response(null, { status: 404 });
  return (
    (await fetchKitFeed(request, env, { kind: "event-calendar", key }, locals.requestId)) ??
    new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
  );
};
