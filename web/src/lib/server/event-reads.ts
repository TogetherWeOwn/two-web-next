import type { RequestHandler } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { Context } from "hono";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/errors";
import { safeRequestId } from "../../../../src/http/request-log";
import { PUBLIC_API_PATHS } from "../../../../src/public-data/kit-routes";
import { publicApiHandlers } from "../../../../src/public-data/routes";
import type { Ctx } from "../../../../src/public-data/unknown-path";

export const trailingSlash = "ignore";

function publicRead(
  route: string,
  respond: (c: Ctx, key: string) => Promise<Response>,
): RequestHandler {
  return async ({ request, params, locals }) => {
    const c = new Context<{ Bindings: Env }>(request, { env, path: new URL(request.url).pathname });
    const id = safeRequestId(locals.requestId);
    if (id !== undefined) c.set("requestId", id);
    const response = await respond(c, params.key ?? "").catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return internalErrorHandler(error, c, route);
    });
    return request.method === "HEAD" ? new Response(null, response) : response;
  };
}

export const publicEvents = publicRead(PUBLIC_API_PATHS.events, publicApiHandlers.events);
export const publicEvent = publicRead(PUBLIC_API_PATHS.event, (c, key) =>
  publicApiHandlers.event(c, () => key),
);
export const openApi = publicRead(PUBLIC_API_PATHS.openApi, publicApiHandlers.openApi);
