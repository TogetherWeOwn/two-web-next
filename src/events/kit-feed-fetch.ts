import { Context } from "hono";
import { getPath } from "hono/utils/url";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { safeRequestId } from "../http/request-log";
import { readContextSession } from "../session-hono";
import { feedHandlers } from "./routes-feeds";

export type FeedRead =
  | { kind: "rss" }
  | { kind: "calendar" }
  | { kind: "event-calendar"; key: string };

/**
 * Route-level candidate for an already matched feed read. The caller supplies
 * the decoded detail key (without .ics) and the dispatch request ID. Route
 * selection, ingress checks, logging and global headers belong to the caller.
 * Each shared handler runs its own events-read admission. The detail handler
 * resolves and may renew the session only after it finds a draft.
 */
export async function fetchKitFeed(
  request: Request,
  env: Env,
  feed: FeedRead,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);

  const read =
    feed.kind === "event-calendar"
      ? feedHandlers.eventCalendar(c, () => feed.key, readContextSession)
      : feedHandlers[feed.kind](c);
  const response = await read.catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    return internalErrorHandler(error, c);
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}
