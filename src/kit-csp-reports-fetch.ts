import { processCspReport } from "./csp-reports";
import type { Env } from "./env";

// Detached adapter. The dispatcher owns ingress and global response headers.
export function fetchKitCspReports(
  request: Request,
  env: Pick<Env, "CSP_REPORT_SAMPLE_RATE">,
): Promise<Response> | null {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/csp-reports") return null;

  // Reuse the bounded reader, sampling and isolate log budget with Hono.
  return processCspReport(request, env).then(
    () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } }),
  );
}
