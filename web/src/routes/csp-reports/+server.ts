import type { RequestEvent } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { fetchKitCspReports } from "../../../../src/kit-csp-reports-fetch";

export function POST({ request }: Pick<RequestEvent, "request">) {
  return fetchKitCspReports(request, env) ?? new Response(null, { status: 404 });
}

export const prerender = false;
export const trailingSlash = "ignore";
