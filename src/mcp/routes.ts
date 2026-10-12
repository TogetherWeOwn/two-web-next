// Stateless public read-only MCP at POST /mcp (B2), served by the pinned
// agents/mcp/server createMcpHandler. Exact path only: the handler 404s any
// other pathname, and only POST (tool traffic) and OPTIONS (CORS preflight)
// are registered — GET/PUT/PATCH/DELETE fall through to Hono's 404 or the
// global same-origin guard, which is not relaxed for this slice.
//
// The same-origin exemption for POST /mcp (src/same-origin.ts) is an exact
// method+path entry like the agent-ingress one: remote MCP clients cannot
// send our Origin, so the handler itself enforces the MCP DNS-rebinding
// policy (present browser Origins must be localhost-class; Origin-less
// non-browser clients stay valid) behind the TrustHosts Host pin. Cookies
// are never read here: the tools close over env + the published-only reads,
// never a session, so a cookie cannot change the result.
import { createMcpHandler } from "agents/mcp/server";
import type { Context, Hono } from "hono";
import { dbFor } from "../admin/db";
import { requestBodyLimit } from "../body-limit";
import type { Env } from "../env";
import { admitted } from "../public-data/routes";
import { createPublicMcpServer } from "./server";

type Ctx = Context<{ Bindings: Env }>;

/**
 * One stateless handler per request: the tool factory closes over this
 * request's env and database handle, so no cross-request state can leak
 * through a shared server. The factory still builds an isolated McpServer
 * per call, exactly as the Agents SDK requires for concurrent requests.
 */
async function serveMcp(c: Ctx): Promise<Response> {
  // The database resolves inside the factory so OPTIONS preflights never
  // open one; event tools report unavailable when it resolves to null.
  const handler = createMcpHandler(
    async () => createPublicMcpServer({ env: c.env, db: await dbFor(c) }),
    { route: "/mcp" },
  );
  // Hono types the context minimally, and app.request (tests) carries
  // none at all. The runtime object is the real worker context in
  // production; the handler only inspects it for verified OAuth state
  // (absent here: this endpoint takes no credentials) and never schedules
  // background work, so an absent context is undefined, not a failure.
  let executionCtx: ExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    executionCtx = undefined;
  }
  return handler(c.req.raw, c.env, executionCtx as unknown as ExecutionContext);
}

export function registerMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  // CORS preflight for browser-based clients (MCP Inspector). No body, no
  // admission burn: the handler answers with its CORS headers.
  app.options("/mcp", (c) => serveMcp(c));
  app.post("/mcp", requestBodyLimit("mcp"), async (c) => {
    // The shared public-read budget, before any database read. A 429 keeps
    // the shared Retry-After with the public error envelope.
    const refused = await admitted(c);
    if (refused) return refused;
    return serveMcp(c);
  });
}
