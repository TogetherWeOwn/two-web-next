import { Context } from "hono";
import { getPath } from "hono/utils/url";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { safeRequestId } from "../http/request-log";
import { readContextSession } from "../session-hono";
import { eventDetailJson } from "./routes-json";

/**
 * Candidate for an already matched event-detail JSON request. The dispatcher
 * owns route selection, decoded keys, ordered ingress, logging and global
 * headers. The shared handler owns the single events-read admission charge.
 */
export async function fetchKitEventDetailJson(
  request: Request,
  env: Env,
  key: string,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);

  const response = await eventDetailJson(
    c,
    () => key,
    (context) => readContextSession(context, false),
  ).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    return internalErrorHandler(error, c);
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}
