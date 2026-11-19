import type { Context, Next } from "hono";
import { KIT_FALLBACK_INLINE_STYLE, KIT_FALLBACK_STYLE_SHA256 } from "./ember-fallback-style";
import type { Env } from "./env";
import { LEAF_CRITICAL_CSS_SHA256 } from "./leaf-critical-css";
import { robotsTagFor } from "./http/robots";
import { isInlineCriticalCssPath } from "./http/secure-headers";

export { KIT_FALLBACK_INLINE_STYLE, KIT_FALLBACK_STYLE_SHA256, robotsTagFor };
export { SECURITY_HEADERS, securityHeadersFor } from "./http/secure-headers";

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

export function isContentLeafPath(path: string): boolean {
  return isInlineCriticalCssPath(path) && path !== "/";
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
// a path list. The token adapter generates the template, constants and hash
// together; test/kit-fallback-style.test.ts independently proves byte equality.

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
