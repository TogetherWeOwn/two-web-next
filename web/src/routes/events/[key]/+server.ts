import { env } from "cloudflare:workers";
import { fetchKitEventDetailJson } from "../../../../../src/events/kit-detail-json-fetch";
import type { RequestHandler } from "./$types";
import { serveEventWrite } from "#lib/server/event-write.ts";

export const trailingSlash = "ignore";

export const GET: RequestHandler = async ({ request, params, locals }) =>
  (await fetchKitEventDetailJson(request, env, params.key, locals.requestId)) ??
  new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
export const PATCH = serveEventWrite;
