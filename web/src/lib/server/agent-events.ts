import type { RequestEvent } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { Hono } from "hono";
import { registerAgentEventsRoute } from "../../../../src/agent-events/route";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/error-responses";

const routes = [
  { method: "POST", path: "/api/agent-events", enabled: true, reads: "public" },
] as const;

const ingress = new Hono<{ Bindings: Env }>();
ingress.use("*", async (c, next) => {
  c.set("requestId", c.executionCtx.props.requestId);
  await next();
});
ingress.onError((err, c) => internalErrorHandler(err, c));
registerAgentEventsRoute(ingress);

export function kitAgentEventsFamily() {
  return { flag: env.KIT_ROUTE_AGENT_EVENTS, routes };
}

// The hook owns exact routing, host trust and response decoration.
export function respondToAgentEvents({
  request,
  locals,
}: Pick<RequestEvent, "request" | "locals">) {
  return ingress.fetch(request, env, {
    waitUntil,
    passThroughOnException() {},
    props: { requestId: locals.requestId },
  });
}
