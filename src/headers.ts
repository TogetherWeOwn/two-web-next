import type { Context, Next } from "hono";
import type { Env } from "./env";

// Response-header parity (TOG-10118 ports two-web TOG-7328 + TOG-8729).
// Two layers, same split as legacy:
//
// - The four static headers live here as constants AND in hono's
//   secureHeaders options in src/index.tsx (byte-identical values to legacy
//   AddSecurityHeaders::HEADERS). X-Frame-Options is DENY, not SAMEORIGIN:
//   nothing frames this site (CISO bar TOG-5469).
// - Content-Security-Policy shape + the report sink belong to the CSP-report
//   slice (TOG-10107, src/csp-reports.ts): secureHeaders emits that policy,
//   and its tests pin the report-uri/report-to directives. This card asserts
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
