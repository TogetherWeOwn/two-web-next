import type { RequestHandler } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { Context } from "hono";
import { getPath } from "hono/utils/url";
import {
  EVENT_MARKDOWN_PATH,
  EVENTS_MARKDOWN_PATH,
  kitEventMarkdownKey,
} from "../../../../src/ai-friendly/kit-event-markdown-routes";
import { eventMarkdownHandlers } from "../../../../src/ai-friendly/routes";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/errors";
import { safeRequestId } from "../../../../src/http/request-log";

export const trailingSlash = "ignore";

export function eventMarkdown(kind: "collection" | "detail"): RequestHandler {
  return async ({ request, locals }) => {
    const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
    const id = safeRequestId(locals.requestId);
    if (id !== undefined) c.set("requestId", id);

    const read =
      kind === "collection"
        ? eventMarkdownHandlers.collection(c)
        : // The dispatcher's original-path admission guarantees the suffix shape.
          eventMarkdownHandlers.detail(c, () => kitEventMarkdownKey(request) ?? "");
    const response = await read.catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const route = kind === "collection" ? EVENTS_MARKDOWN_PATH : EVENT_MARKDOWN_PATH;
      return internalErrorHandler(error, c, route);
    });
    return request.method === "HEAD" ? new Response(null, response) : response;
  };
}
