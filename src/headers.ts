import type { Context, Next } from "hono";
import type { Env } from "./env";
import { imageHosts } from "./image-policy";
import { LEAF_CRITICAL_CSS_SHA256 } from "./leaf-critical-css";

// Response-header parity (TOG-10118 ports two-web TOG-7328 + TOG-8729).
// Two layers, same split as legacy:
//
// - The four static headers live here as constants AND in hono's
//   secureHeaders options in src/index.tsx (byte-identical values to legacy
//   AddSecurityHeaders::HEADERS). X-Frame-Options is DENY, not SAMEORIGIN:
//   nothing frames this site (CISO bar TOG-5469).
// - Content-Security-Policy shape + the report sink belong to the CSP-report
//   slice (TOG-10107, src/csp-reports.ts): secureHeaders emits that policy,
//   and its tests pin the report-to directive. This card asserts
//   the static four + the robots tag, never the CSP shape, so the two cards
//   cannot fight over one header.
// - Strict-Transport-Security is explicitly disabled in src/index.tsx
//   (strictTransportSecurity: false — Hono defaults it on). Legacy owns it
//   at nginx (TOG-8729): it is meaningless over plaintext and dangerous
//   from a local dev server, which would pin the developer's whole machine
//   to HTTPS. On Workers the edge owns it (Cloudflare HSTS), never this
//   code.

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Production apex. Anything else serving HTML is staging, a preview, or a
// dev/test host — crawlers must not index it (ports the nginx
// `map $host $robots_tag` staging-noindex half of TOG-8729; the Sitemap-host
// half already lives in src/seo.ts per TOG-7071).
const PRODUCTION_APEX = "togetherweown.com";

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// The noindex decision reads BOTH the configured APP_URL and the host
// actually serving the response (nginx `$host`-map parity):
// - unparseable config → noindex (fail closed to the staging posture);
// - non-apex config (staging/preview/dev) → noindex whatever serves it;
// - apex config → noindex unless the serving host is the apex itself, so a
//   preview or workers.dev alias serving an apex-configured build is never
//   indexed. Unit callers without a serving host keep the config-only verdict.
export function robotsTagFor(appUrl: string, servingHost?: string): string | null {
  const configHost = hostOf(appUrl);
  if (configHost === null) return "noindex, nofollow";
  if (configHost !== PRODUCTION_APEX) return "noindex, nofollow";
  if (servingHost !== undefined && servingHost.toLowerCase() !== PRODUCTION_APEX) {
    return "noindex, nofollow";
  }
  return null;
}

/** Staging/preview/dev builds noindex every machine format (production apex only indexes). */
export function stagingRobots(c: Context<{ Bindings: Env }>): string | null {
  let serving: string | undefined;
  try {
    serving = new URL(c.req.url).hostname;
  } catch {
    serving = undefined;
  }
  return robotsTagFor(c.env.APP_URL, serving);
}

// Staging X-Robots-Tag on HTML responses only. Register on the app root
// (after secureHeaders): mounted sub-apps inherit it because the middleware
// runs on the outer dispatch. Mutates the finished response's headers
// directly — c.header() would not apply this late.
export async function robotsTag(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  await next();
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return;
  let serving: string | undefined;
  try {
    serving = new URL(c.req.url).hostname;
  } catch {
    serving = undefined;
  }
  const tag = robotsTagFor(c.env.APP_URL, serving);
  if (tag) c.res.headers.set("X-Robots-Tag", tag);
}

// The only pages whose shell inlines the stylesheets instead of linking
// them (theme="content" plus the homepage's inlineCriticalCss flag in
// src/page-shell.tsx): the stylesheets must be inlined to remove their
// render-blocking requests on slow mobile audits, and the inlined block is
// allowlisted by hash so style-src keeps no 'unsafe-inline'. "/" reuses the
// exact leaf bundle byte for byte (same LEAF_CRITICAL_CSS hash, no generator
// change); recovery/error shells keep theme="home" without the flag and stay
// on external stylesheets. Any other response carrying the hash would be
// inert, but the allowlist stays scoped to these paths so the documented
// policy for every other route never changes shape.
const INLINE_CRITICAL_CSS_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
]);

export function isContentLeafPath(path: string): boolean {
  return INLINE_CRITICAL_CSS_PATHS.has(path) && path !== "/";
}

export function isInlineCriticalCssPath(path: string): boolean {
  return INLINE_CRITICAL_CSS_PATHS.has(path);
}

// Per-route twin of the static secureHeaders() policy in src/index.tsx: on an
// inline-critical path (/ plus the content leaves), widen the already-emitted
// `style-src 'self'` with the inlined block's hash. Runs inside the existing
// header wrapper after
// secureHeaders (same pattern as robotsTag), so no extra middleware is
// registered. String replacement keeps the directive order byte-identical to
// securityHeadersFor for the same path.
export function leafInlineStyleCsp(c: Context): void {
  if (!isInlineCriticalCssPath(c.req.path)) return;
  const csp = c.res.headers.get("Content-Security-Policy");
  if (!csp || !csp.includes("style-src 'self'")) return;
  c.res.headers.set(
    "Content-Security-Policy",
    csp.replace("style-src 'self'", `style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`),
  );
}

// The catastrophic Kit fallback (web/src/error.html) inlines this single
// <style> block: the page must render branded with no stylesheet fetch, so
// the styles cannot move to an external file. When Kit serves the fallback
// from inside resolve() (root-layout render throws, or the root error page
// itself fails), the dispatch decorates it with the production CSP, whose
// style-src 'self' would block the inline block and leave the page on UA
// defaults. The block is allowlisted by hash so style-src keeps no
// 'unsafe-inline' — the same shape as the leaf allowlist above, but scoped
// to the fallback RESPONSE (any path can fail catastrophically) instead of
// a path list. Pinned byte-identical to the template plus its sha256 by
// test/kit-fallback-style.test.ts; edit the template and the constant together.
export const KIT_FALLBACK_INLINE_STYLE: string =
  "body{max-width:35rem;margin:3rem auto;padding:0 1.5rem;background:#141117;color:#f7f7f7;font:1rem/1.6 system-ui}a{display:inline-block;padding:.5rem;color:#ff9c36}a:focus-visible{outline:3px solid;outline-offset:3px}";
export const KIT_FALLBACK_STYLE_SHA256: string = "1JW9HtOCLEIW+yxXcLF1Dkr9qO+Q+0QIFaPu6XjEpKI=";

// True when the body carries the exact fallback style element. The full
// element (tags included) is the match, so the allowlist below can only
// fire for a document embedding precisely these bytes.
export function isKitFallbackDocument(body: string): boolean {
  return body.includes(`<style>${KIT_FALLBACK_INLINE_STYLE}</style>`);
}

// Widens an emitted style-src 'self' with the fallback block's hash. String
// replacement keeps the directive order byte-identical (the
// leafInlineStyleCsp pattern); composes with the leaf hash on leaf paths,
// and is a no-op when the hash is already present or style-src is absent.
export function withKitFallbackStyleCsp(csp: string): string {
  if (csp.includes(KIT_FALLBACK_STYLE_SHA256)) return csp;
  return csp.replace("style-src 'self'", `style-src 'self' 'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
}

// Framework-neutral twin of the secureHeaders() options in src/index.tsx, for
// hosts that are not Hono (the SvelteKit spike's web/src/hooks.server.ts,
// TOG-12247). Same names, values and order as hono's middleware emits, so a
// page moved out of Hono keeps its headers byte-for-byte.
// test/security-headers-builder.test.ts pins equality with app.request().
const CSP_REPORT_ENDPOINT = "/csp-reports";
const CSP_REPORT_GROUP = "csp-endpoint";

export function securityHeadersFor(
  request: { path: string; method: string },
  featuredImageHosts?: string,
): Array<[string, string]> {
  const framed = request.path === "/join" && ["GET", "HEAD"].includes(request.method);
  const images = imageHosts(featuredImageHosts)
    .map((host) => `https://${host}`)
    .join(" ");
  // Only the inline-critical pages (/ plus about/faq/rules/privacy) emit an
  // inlined <style> block, so only they carry its hash allowlist. Every other
  // path keeps the exact documented policy byte-identical, which the adapter
  // _headers parity and Kit parity tests pin.
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
    // Mirrors the leafInlineStyleCsp rewrite of the secureHeaders output in
    // src/index.tsx, pinned equal by test/security-headers-builder.test.ts.
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
