import { Context } from "hono";
import { getPath } from "hono/utils/url";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { safeRequestId } from "../http/request-log";
import { readContextSession } from "../http/session-context";
import { readCalendarFeed, readEventCalendar, readRssFeed } from "./routes-feeds";

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

  let response: Response;
  try {
    switch (feed.kind) {
      case "rss":
        response = await readRssFeed(c);
        break;
      case "calendar":
        response = await readCalendarFeed(c);
        break;
      case "event-calendar":
        response = await readEventCalendar(c, () => feed.key, readContextSession);
        break;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    response = await internalErrorHandler(error, c);
  }
  return request.method === "HEAD" ? new Response(null, response) : response;
}
