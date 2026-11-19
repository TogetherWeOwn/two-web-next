import { operatorImageHosts } from "../config-warn";
import { LEAF_CRITICAL_CSS_SHA256 } from "../leaf-critical-css";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Only the homepage and content leaves inline the critical CSS bundle.
const INLINE_CRITICAL_CSS_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
]);

export function isInlineCriticalCssPath(path: string): boolean {
  return INLINE_CRITICAL_CSS_PATHS.has(path);
}

// report-to selects a Reporting-Endpoints group with a same-origin path.
// The deprecated Report-To header instead requires an absolute HTTPS URL.
const CSP_REPORT_ENDPOINT = "/csp-reports";
const CSP_REPORT_GROUP = "csp-endpoint";

// Shared Hono and Kit wire policy. HSTS stays at the Cloudflare edge.
export function securityHeadersFor(
  request: { path: string; method: string },
  featuredImageHosts?: string,
): Array<[string, string]> {
  const framed = request.path === "/join" && ["GET", "HEAD"].includes(request.method);
  const images = operatorImageHosts(featuredImageHosts)
    .map((host) => `https://${host}`)
    .join(" ");
  const leafStyle = isInlineCriticalCssPath(request.path)
    ? [`'sha256-${LEAF_CRITICAL_CSS_SHA256}'`]
    : [];
  const csp = [
    ["default-src", "'self'"],
    ["base-uri", "'self'"],
    ["connect-src", "'self'"],
    ["object-src", "'none'"],
    ["img-src", "'self'", images],
    ["frame-src", framed ? "https://discord.com/widget" : "'none'"],
    ["style-src", "'self'", ...leafStyle],
    ["script-src", "'self'"],
    ["font-src", "'self'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["report-to", CSP_REPORT_GROUP],
  ]
    .map((directive) => directive.join(" "))
    .join("; ");
  return [
    ["Cross-Origin-Embedder-Policy", "credentialless"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Origin-Agent-Cluster", "?1"],
    ["Referrer-Policy", SECURITY_HEADERS["Referrer-Policy"]!],
    ["X-Content-Type-Options", SECURITY_HEADERS["X-Content-Type-Options"]!],
    ["X-DNS-Prefetch-Control", "off"],
    ["X-Download-Options", "noopen"],
    ["X-Frame-Options", SECURITY_HEADERS["X-Frame-Options"]!],
    ["X-Permitted-Cross-Domain-Policies", "none"],
    ["X-XSS-Protection", "0"],
    ["Content-Security-Policy", csp],
    ["Permissions-Policy", SECURITY_HEADERS["Permissions-Policy"]!],
    ["Reporting-Endpoints", `${CSP_REPORT_GROUP}="${CSP_REPORT_ENDPOINT}"`],
  ];
}
