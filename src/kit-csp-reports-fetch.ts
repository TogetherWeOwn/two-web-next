import { Context } from "hono";
import { cspReportsRoute } from "./csp-reports";
import type { Env } from "./env";

// Detached adapter. The dispatcher owns ingress and global response headers.
export function fetchKitCspReports(request: Request, env: Env): Promise<Response> | null {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/csp-reports") return null;

  // Reuse the bounded reader, sampling and isolate log budget with Hono.
  return cspReportsRoute(new Context<{ Bindings: Env }>(request, { env }));
}
