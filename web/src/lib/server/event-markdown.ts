import type { RequestHandler } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { Context } from "hono";
import { getPath } from "hono/utils/url";
import {
  EVENT_MARKDOWN_PATH,
  EVENTS_MARKDOWN_PATH,
  KIT_EVENT_MARKDOWN_ROUTES,
  kitEventMarkdownKey,
  legacyEventMarkdownKey,
} from "../../../../src/ai-friendly/kit-event-markdown-routes";
import { eventMarkdownHandlers } from "../../../../src/ai-friendly/routes";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/errors";
import { safeRequestId } from "../../../../src/http/request-log";

export const trailingSlash = "ignore";

async function respondToMarkdown(
  request: Request,
  requestId: unknown,
  keyFor?: () => string,
): Promise<Response> {
  const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);

  const read = keyFor
    ? eventMarkdownHandlers.detail(c, keyFor)
    : eventMarkdownHandlers.collection(c);
  const response = await read.catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    return internalErrorHandler(error, c, keyFor ? EVENT_MARKDOWN_PATH : EVENTS_MARKDOWN_PATH);
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}

export function eventMarkdown(kind: "collection" | "detail"): RequestHandler {
  return ({ request, locals }) =>
    respondToMarkdown(
      request,
      locals.requestId,
      kind === "collection" ? undefined : () => kitEventMarkdownKey(request) ?? "",
    );
}

export function kitEventMarkdownFamily() {
  return {
    flag: env.KIT_ROUTE_EVENT_MARKDOWN,
    routes: KIT_EVENT_MARKDOWN_ROUTES,
    legacySuffix: {
      path: EVENT_MARKDOWN_PATH,
      keyFor: legacyEventMarkdownKey,
      read: (request: Request, key: string, requestId: string) =>
        respondToMarkdown(request, requestId, () => key),
    },
  };
}
