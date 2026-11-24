import type { RequestEvent } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { registerBrowserAuthRoutes } from "../../../../src/auth/routes";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/error-responses";
import { safeRequestId } from "../../../../src/http/request-log";
import { authHooks } from "../../../../src/index";
import { crossOriginRefusal } from "../../../../src/same-origin";

export const KIT_AUTH_ROUTES = [
  { method: "GET", path: "/auth/status" },
  { method: "GET", path: "/auth/discord/redirect" },
  { method: "GET", path: "/auth/discord" },
  { method: "GET", path: "/auth/discord/callback" },
  { method: "POST", path: "/logout" },
  { method: "POST", path: "/logout/everywhere" },
].map((route) => ({ ...route, enabled: true, reads: "public" }) as const);

const auth = new Hono<{ Bindings: Env }>();
auth.use("*", async (c, next) => {
  const id = safeRequestId(c.executionCtx.props.requestId);
  if (id !== undefined) c.set("requestId", id);
  await next();
});
auth.onError((err, c) => internalErrorHandler(err, c));
registerBrowserAuthRoutes(auth, authHooks);

function requestContext(requestId?: string) {
  return { waitUntil, passThroughOnException() {}, props: { requestId } };
}

// Kit has admitted the exact route, checked host and origin and assigned an ID.
// The shared endpoints own body limits, throttles, cookies and session effects.
export function respondToAuth({ request, locals }: Pick<RequestEvent, "request" | "locals">) {
  return auth.fetch(request, env, requestContext(locals.requestId));
}

export function authOriginRefusal(request: Request, requestId: string) {
  const c = new Context<{ Bindings: Env }>(request, {
    env,
    path: new URL(request.url).pathname,
    executionCtx: requestContext(requestId),
  });
  c.set("requestId", requestId);
  return crossOriginRefusal(c);
}
