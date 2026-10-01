import type { Context } from "hono";
import type { Env } from "./env";

// Staging-only first-party page-view counts (TOG-11885 experiment).
// One server-side Workers Analytics Engine data point per HTML GET — no
// beacon, no CSP change, no cookies. The write rides the existing
// security/robots middleware slot in src/index.tsx (no new ALL /*
// registration; test/member-exposure.test.ts pins that multiplicity).
//
// Data-point schema (ordered arrays; WAE reads them positionally):
//   blobs:   [route template, country, referrer host]
//   doubles:  [status, bot flag (0/1)]
// No IP, user agent, user id or session is ever written. The bot flag and
// referrer host are derived transiently from headers and only the derived
// values leave the request.
const DATASET_BLOBS = 3;

// Conservative bot tokens matched against the transient User-Agent value.
// The UA string itself is never stored — only the 0/1 outcome.
const BOT_PATTERN = /bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver/i;

// Cloudflare exposes the request country as a 2-letter code on raw.cf.
// Anything else (local dev, tests, "XX"/"T1" passthrough aside) is unknown.
export function countryOf(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return "unknown";
}

// Only the referrer host is stored — never the full URL, which can carry
// query-string PII. Missing or unparseable becomes "" (direct).
export function referrerHostOf(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

export function botFlagOf(userAgent: string | null | undefined): number {
  return userAgent && BOT_PATTERN.test(userAgent) ? 1 : 0;
}

// Route template ("/", "/events", "/e/:key", ...) for grouping. From the
// early middleware slot Hono reports the matched handler's template; unmatched
// paths (404s) surface the middleware's own "/*" glob, and asset or error
// paths may surface other non-route values — anything that is not a concrete
// route template groups as "404". Never throws: routePath access can fail
// outside a matched route.
function routeTemplateOf(c: Context<{ Bindings: Env }>, status: number): string {
  if (status === 404) return "404";
  try {
    const template = (c.req as { routePath?: unknown }).routePath;
    if (typeof template === "string" && template && template !== "/*") return template;
  } catch {
    // Fall through to the 404 grouping below.
  }
  return "404";
}

// Fire-and-forget page-view write. Synchronous with no await:
// writeDataPoint enqueues in the runtime and returns immediately (<2 ms).
// Never throws and never alters the response — analytics must not break pages.
export function recordPageView(c: Context<{ Bindings: Env }>): void {
  try {
    if (c.req.method !== "GET") return;
    const res = c.res;
    if (!res) return;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return;
    const dataset = c.env.PAGE_VIEWS;
    if (!dataset || typeof dataset.writeDataPoint !== "function") return;
    const raw = c.req.raw as Request & { cf?: { country?: unknown } };
    const blobs: (string | null)[] = [
      routeTemplateOf(c, res.status),
      countryOf(raw.cf?.country),
      referrerHostOf(c.req.header("referer") ?? c.req.header("referrer")),
    ];
    if (blobs.length !== DATASET_BLOBS) return;
    dataset.writeDataPoint({
      blobs,
      doubles: [res.status, botFlagOf(c.req.header("user-agent"))],
    });
  } catch {
    // Analytics is best-effort; a failed write is never a failed request.
  }
}
