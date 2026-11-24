import { env } from "cloudflare:workers";
import { fetchKitSeo } from "../../../../src/kit-seo-fetch";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const trailingSlash = "ignore";

export const GET: RequestHandler = async ({ request, locals }) =>
  (await fetchKitSeo(request, env, locals.requestId)) ??
  new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
