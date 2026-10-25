import { createMiddleware } from "hono/factory";
import type { Env } from "./env";
import { jsonRefusal } from "./json-refusal";
import { forbidden, prefersHtmlError, varyAccept } from "./errors";

export const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// Exact method + path exemptions, never whole prefixes or cookie presence.
// Agent ingress authenticates independently; CSP reports cannot carry Origin
// reliably and only feed the bounded, non-persistent violation sink. The MCP
// endpoint serves remote clients that cannot send our Origin, so it enforces
// its own transport guard instead (exact-path route plus the handler's
// Origin validation, behind the TrustHosts Host pin); the rule below is
// unchanged.
export const SAME_ORIGIN_EXEMPTIONS = [
  { method: "POST", path: "/api/agent-events" },
  { method: "POST", path: "/csp-reports" },
  { method: "POST", path: "/mcp" },
] as const;

export const sameOrigin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // Methods compare case-insensitively: fetch normalizes every unsafe verb
  // except PATCH, so a raw lowercase `patch` must be guarded, not bypassed.
  // Mirrors the twin's toUpperCase in src/route-ownership.ts.
  const method = c.req.method.toUpperCase();
  if (
    !UNSAFE_METHODS.some((unsafe) => unsafe === method) ||
    SAME_ORIGIN_EXEMPTIONS.some(
      ({ method: exempt, path }) => exempt === method && path === c.req.path,
    )
  ) {
    return next();
  }

  let expected: string | undefined;
  try {
    const url = new URL(c.env.APP_URL);
    if (url.protocol === "https:" || url.protocol === "http:") expected = url.origin;
  } catch {
    /* Invalid configuration fails closed, never trusts the request host. */
  }

  // An explicit Origin always wins, including "null" or a malformed value.
  // Fetch Metadata is a fallback only when Origin is absent; its same-origin
  // assertion is relative to the request host, which must itself be APP_URL.
  const origin = c.req.header("origin");
  const trusted =
    expected !== undefined &&
    (origin !== undefined
      ? origin === expected
      : c.req.header("sec-fetch-site") === "same-origin" && new URL(c.req.url).origin === expected);
  if (!trusted) {
    c.header("cache-control", "no-store, private");
    varyAccept(c);
    if (prefersHtmlError(c)) return forbidden(c);
    return jsonRefusal(c, "cross_origin", 403);
  }
  return next();
});
