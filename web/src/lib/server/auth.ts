import type { RequestEvent } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { issueSession } from "../../../../src/auth/issue-session";
import { registerBrowserAuthRoutes } from "../../../../src/auth/routes";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/error-responses";
import { safeRequestId } from "../../../../src/http/request-log";
import { storeForEnv } from "../../../../src/http/session";
import { crossOriginRefusal } from "../../../../src/same-origin";

const auth = new Hono<{ Bindings: Env }>();
auth.use("*", async (c, next) => {
  const id = safeRequestId(c.executionCtx.props.requestId);
  if (id !== undefined) c.set("requestId", id);
  await next();
});
auth.onError((err, c) => internalErrorHandler(err, c));
registerBrowserAuthRoutes(auth, { storeFor: (c) => storeForEnv(c.env), issueSession });

// Kit has admitted the exact route, checked host and origin and assigned an ID.
// The shared endpoints own body limits, throttles, cookies and session effects.
export function respondToAuth({ request, locals }: Pick<RequestEvent, "request" | "locals">) {
  return auth.fetch(request, env, {
    waitUntil,
    passThroughOnException() {},
    props: { requestId: locals.requestId },
  });
}

export function authOriginRefusal(request: Request, requestId: string) {
  const c = new Context<{ Bindings: Env }>(request, {
    env,
    path: new URL(request.url).pathname,
  });
  c.set("requestId", requestId);
  return crossOriginRefusal(c);
}
