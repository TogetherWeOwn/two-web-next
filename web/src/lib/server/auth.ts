import type { RequestEvent } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { registerBrowserAuthRoutes, registerQaAuthRoute } from "../../../../src/auth/routes";
import type { Env } from "../../../../src/env";
import { internalErrorHandler, notFoundHandler } from "../../../../src/error-responses";
import { freezeBanner } from "../../../../src/freeze-banner";
import { safeRequestId } from "../../../../src/http/request-log";
import { authHooks } from "../../../../src/index";
import { registerJoinOAuthRoutes } from "../../../../src/join/route";
import { STAGING_APP_URL } from "../../../../src/qa";
import { renderJoinRecovery } from "../../../../src/recovery-hono";
import { crossOriginRefusal } from "../../../../src/same-origin";
import { expiredWriteBanner } from "../../../../src/write-recovery";

const KIT_AUTH_ROUTES = [
  { method: "GET", path: "/auth/status" },
  { method: "GET", path: "/auth/discord/redirect" },
  { method: "GET", path: "/auth/discord" },
  { method: "GET", path: "/auth/discord/callback" },
  { method: "GET", path: "/join/discord" },
  { method: "GET", path: "/join/callback" },
  { method: "POST", path: "/logout" },
  { method: "POST", path: "/logout/everywhere" },
].map((route) => ({ ...route, enabled: true, reads: "public" }) as const);

const KIT_QA_AUTH_ROUTE = {
  method: "POST",
  path: "/auth/qa/:identity",
  enabled: true,
  reads: "public",
  dynamic: {
    id: "/auth/qa/[identity]",
    // Match the path shape without inspecting the identity or token. The shared
    // handler returns the same 404 for guesses and unknown fixture names.
    matches: (raw: string, decoded: string) => raw === decoded && /^\/auth\/qa\/[^/%]+$/.test(raw),
  },
} as const;

export function kitAuthRoutes(appUrl: string) {
  return appUrl === STAGING_APP_URL ? [...KIT_AUTH_ROUTES, KIT_QA_AUTH_ROUTE] : KIT_AUTH_ROUTES;
}

const auth = new Hono<{ Bindings: Env }>();
auth.use("*", async (c, next) => {
  const id = safeRequestId(c.executionCtx.props.requestId);
  if (id !== undefined) c.set("requestId", id);
  await next();
});
auth.onError((err, c) => internalErrorHandler(err, c));
auth.notFound(notFoundHandler);
registerBrowserAuthRoutes(auth, authHooks);
auth.use("/join/callback", expiredWriteBanner, freezeBanner);
registerJoinOAuthRoutes(auth, authHooks, renderJoinRecovery);
registerQaAuthRoute(auth, authHooks);

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
