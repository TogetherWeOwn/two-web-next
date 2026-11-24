import { env } from "cloudflare:workers";
import { fetchKitFeed } from "../../../../src/events/kit-feed-fetch";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const trailingSlash = "ignore";

export const GET: RequestHandler = async ({ request, locals }) => {
  return (
    (await fetchKitFeed(request, env, { kind: "calendar" }, locals.requestId)) ??
    new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
  );
};
