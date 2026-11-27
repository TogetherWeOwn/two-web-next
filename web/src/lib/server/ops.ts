import type { RequestEvent } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { registerAlertProbe } from "../../../../src/alert-probe";
import type { Env } from "../../../../src/env";
import { internalErrorHandler, notFoundHandler } from "../../../../src/error-responses";
import { safeRequestId } from "../../../../src/http/request-log";
import { upRoute, versionRoute } from "../../../../src/index";
import { crossOriginRefusal } from "../../../../src/same-origin";

const routes = [
  { method: "POST", path: "/csp-reports" },
  { method: "POST", path: "/__probe/alert" },
  { method: "GET", path: "/up" },
  { method: "GET", path: "/version" },
].map((route) => ({ ...route, enabled: true, reads: "public" }) as const);

function requestContext(requestId?: string) {
  return { waitUntil, passThroughOnException() {}, props: { requestId } };
}

const ops = new Hono<{ Bindings: Env }>();
ops.use("*", async (c, next) => {
  const id = safeRequestId(c.executionCtx.props.requestId);
  if (id !== undefined) c.set("requestId", id);
  await next();
});
ops.notFound(notFoundHandler);
ops.onError((err, c) => internalErrorHandler(err, c));
ops.get("/up", upRoute);
ops.get("/version", versionRoute);
registerAlertProbe(ops);

function opsOriginRefusal(request: Request, requestId: string) {
  const c = new Context<{ Bindings: Env }>(request, {
    env,
    path: new URL(request.url).pathname,
    executionCtx: requestContext(requestId),
  });
  c.set("requestId", requestId);
  return crossOriginRefusal(c);
}

export function kitOpsFamily() {
  return { flag: env.KIT_ROUTE_OPS, routes, crossOriginRefusal: opsOriginRefusal };
}

// The hook admits the exact routes and supplies host, origin and global headers.
export function respondToOps({ request, locals }: Pick<RequestEvent, "request" | "locals">) {
  return ops.fetch(request, env, requestContext(locals.requestId));
}
