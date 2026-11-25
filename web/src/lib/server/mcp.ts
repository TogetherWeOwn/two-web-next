import type { RequestHandler } from "@sveltejs/kit";
import { env, waitUntil } from "cloudflare:workers";
import { type ExecutionContext, Hono } from "hono";
import type { Env } from "../../../../src/env";
import { internalErrorHandler } from "../../../../src/errors";
import { safeRequestId } from "../../../../src/http/request-log";
import { registerMcpRoutes } from "../../../../src/mcp/routes";

const routes = [
  { method: "POST", path: "/mcp", enabled: true, reads: "public" },
  { method: "OPTIONS", path: "/mcp", enabled: true, reads: "public" },
] as const;

type McpExecutionContext = ExecutionContext & { requestId: string | undefined };

const mcp = new Hono<{ Bindings: Env }>();
mcp.use("/mcp", async (c, next) => {
  const id = safeRequestId((c.executionCtx as McpExecutionContext).requestId);
  if (id !== undefined) c.set("requestId", id);
  await next();
});
mcp.onError((error, c) => internalErrorHandler(error, c, "/mcp"));
registerMcpRoutes(mcp);

export function kitMcpFamily() {
  return { flag: env.KIT_ROUTE_MCP, routes };
}

export const respondToMcp: RequestHandler = ({ request, locals }) => {
  const ctx: McpExecutionContext = {
    waitUntil,
    passThroughOnException() {},
    // Keep correlation out of props, which the SDK can use as auth context.
    props: {},
    requestId: locals.requestId,
  };
  return mcp.fetch(request, env, ctx);
};
