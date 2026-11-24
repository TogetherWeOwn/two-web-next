import { env } from "cloudflare:workers";
import { fetchKitSecurityTxt } from "../../../../../src/kit-security-txt-fetch";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const trailingSlash = "ignore";

export const GET: RequestHandler = ({ request }) =>
  fetchKitSecurityTxt(request, env) ??
  new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
