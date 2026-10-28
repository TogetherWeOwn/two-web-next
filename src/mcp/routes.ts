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
import { alertRequestError } from "../alerts";
import { requestBodyLimit } from "../body-limit";
import type { Env } from "../env";
import { MCP_TRANSPORT_ERROR_CODE } from "../errors";
import { safeRequestId } from "../request-log";
import { admissionRetryAfter } from "../public-data/routes";
import { createPublicMcpServer, MCP_REQUEST_ID_MAX_BYTES } from "./server";

type Ctx = Context<{ Bindings: Env }>;

/**
 * JSON-RPC batches (an array at the top level) would let one admitted POST
 * run hundreds of DB-backed tool calls for a single budget hit. The
 * 2025-06-18 protocol removed batching, so refuse arrays with -32600/400.
 * String IDs must also fit the response-envelope allowance before dispatch;
 * oversized IDs are refused with id:null rather than echoed.
 * Takes the already-materialized body text: the caller reads the stream once
 * and reuses it for the handler, so there is exactly one materialization and
 * no clone().text().
 */
function refuseMcpMessageText(text: string, c: Ctx): Response | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let message: string;
  let next: string;
  if (Array.isArray(parsed)) {
    message = "Invalid Request: batched requests are not supported.";
    next = "Send one request per POST and retry.";
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    "id" in parsed &&
    typeof parsed.id === "string" &&
    new TextEncoder().encode(JSON.stringify(parsed.id)).length > MCP_REQUEST_ID_MAX_BYTES
  ) {
    // JSON-RPC echoes IDs. Count UTF-8 bytes AFTER JSON escaping, including
    // quotes, before dispatch so an ID cannot consume the response budget.
    message = "Invalid Request: request ID exceeds the 512-byte JSON limit.";
    next = "Use a shorter request ID and retry.";
  } else {
    return null;
  }
  return c.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: MCP_TRANSPORT_ERROR_CODE,
        message,
        data: { next, request_id: c.get("requestId") },
      },
    },
    400,
  );
}

/**
 * Over-budget MCP POSTs answer a JSON-RPC error, not the REST envelope: the
 * transport speaks one shape whatever the failure. Same shared budget and the
 * same validated Retry-After as the REST 429; the id is null because the
 * refusal happens before any id is trusted.
 */
async function mcpRefused(c: Ctx): Promise<Response | null> {
  const retryAfterSeconds = await admissionRetryAfter(c);
  if (retryAfterSeconds === null) return null;
  return c.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: MCP_TRANSPORT_ERROR_CODE,
        message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
        data: {
          next: "Wait for Retry-After, then retry.",
          request_id: c.get("requestId"),
        },
      },
    },
    429,
    {
      "retry-after": String(retryAfterSeconds),
      "cache-control": "no-store, private",
    },
  );
}

/**
 * One stateless handler per request: the tool factory closes over this
 * request's env and database handle, so no cross-request state can leak
 * through a shared server. The factory still builds an isolated McpServer
 * per call, exactly as the Agents SDK requires for concurrent requests.
 */
async function serveMcp(c: Ctx): Promise<Response> {
  // The database resolves inside the factory so OPTIONS preflights never
  // open one; event tools report unavailable when it resolves to null.
  // No onerror hook: the SDK calls it for ordinary client protocol
  // rejections (bad body, bad MCP-Protocol-Version, missing _meta) as well
  // as server faults, and every other route keeps 4xx silent. Alerting
  // there would let anonymous callers page ops via the tail /mcp alert
  // route. Factory failures (dbFor/createPublicMcpServer throwing) are the
  // only server faults that bypass app.onError here, so alert on those
  // directly; tool errors already alert inside the tools.
  const requestId = safeRequestId(c.get("requestId"));
  const handler = createMcpHandler(
    async () => {
      try {
        return createPublicMcpServer({ env: c.env, db: await dbFor(c), requestId });
      } catch (err) {
        alertRequestError(err, { method: "POST", route: "/mcp", requestId });
        throw err;
      }
    },
    {
      route: "/mcp",
    },
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
    // The shared public-read budget first, before any body parse or database
    // read. A 429 keeps the shared Retry-After with the JSON-RPC error shape,
    // even for batch-shaped bodies.
    const refused = await mcpRefused(c);
    if (refused) return refused;
    // Single body materialization: read once, refuse batches on the cached
    // text, then replay it for the handler with no second network read and
    // no clone().text().
    let text: string;
    try {
      text = await c.req.raw.text();
    } catch {
      return serveMcp(c);
    }
    const invalid = refuseMcpMessageText(text, c);
    if (invalid) return invalid;
    c.req.raw = new Request(c.req.raw, { body: text, duplex: "half" } as RequestInit);
    return serveMcp(c);
  });
}
