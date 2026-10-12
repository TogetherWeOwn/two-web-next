// B1 read-only WebMCP pilot: feature-flagged `document.modelContext` tools.
//
// Flag-gated, off by default: unset (or anything but "true"/"1") leaves every
// page byte-identical. When enabled, the four pilot pages (homepage, events
// list, event detail, join) carry one deferred island that registers exactly
// the read-only tools T1–T4 against the session-free `/api/public/*` surface.
// The middleware reads no session, no cookie and no database, so it adds no
// session-dependent markup of its own: every viewer gets the same island,
// hence the same four tools and no extras. No polyfill and
// no CDN script: without the browser API the island returns before any fetch.
import type { Context, Next } from "hono";

type Ctx = Context<any>;

export const WEBMCP_PILOT_SCRIPT = '<script src="/islands/model-context.js" defer></script>';

export function webmcpPilotEnabled(env: { WEBMCP_PILOT_ENABLED?: string }): boolean {
  return env.WEBMCP_PILOT_ENABLED === "true" || env.WEBMCP_PILOT_ENABLED === "1";
}

/**
 * Pilot pages mirror the four read-only tools: `/` (community snapshot),
 * `/events` incl. `/events/past` (event search), `/e/:key` (event detail),
 * `/join` (join handoff). Everything else — admin, auth, APIs, leaves —
 * carries no island.
 */
export function isWebmcpPilotPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/events" ||
    path.startsWith("/events/") ||
    path.startsWith("/e/") ||
    path === "/join"
  );
}

/** Post-processing injector with the same document gate as the freeze banner. */
export async function webmcpPilot(c: Ctx, next: Next): Promise<void> {
  await next();
  if (
    c.req.method !== "GET" ||
    c.res.status !== 200 ||
    !c.res.headers.get("content-type")?.includes("text/html")
  )
    return;
  if (!webmcpPilotEnabled(c.env)) return;
  if (!isWebmcpPilotPath(c.req.path)) return;
  const html = await c.res.clone().text();
  if (!html.includes("</body>")) return;
  c.res = new Response(html.replace("</body>", `${WEBMCP_PILOT_SCRIPT}</body>`), {
    status: c.res.status,
    headers: c.res.headers,
  });
}
