import { env } from "cloudflare:workers";
import type { RequestHandler } from "@sveltejs/kit";
import { fetchKitEventWrite } from "../../../../src/events/kit-event-write-fetch";

export const serveEventWrite: RequestHandler = ({ request, locals }) =>
  fetchKitEventWrite(request, env, locals.requestId);
