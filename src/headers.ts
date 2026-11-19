import type { Context, Next } from "hono";
import { KIT_FALLBACK_INLINE_STYLE, KIT_FALLBACK_STYLE_SHA256 } from "./ember-fallback-style";
import type { Env } from "./env";
import { robotsTagFor } from "./http/robots";
import { securityHeadersFor } from "./http/secure-headers";

export { KIT_FALLBACK_INLINE_STYLE, KIT_FALLBACK_STYLE_SHA256, robotsTagFor };
export { isContentLeafPath, SECURITY_HEADERS, securityHeadersFor } from "./http/secure-headers";

export async function secureHeaders(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  // Read Hono's normalized path and resolve config before dispatch. Apply the
  // policy to the finished response, including guard refusals and mounted apps.
  const headers = securityHeadersFor(c.req, c.env.FEATURED_IMAGE_HOSTS);
  await next();
  for (const [name, value] of headers) c.res.headers.set(name, value);
  c.res.headers.delete("X-Powered-By");
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

// The catastrophic Kit fallback (web/src/error.html) inlines this single
// <style> block: the page must render branded with no stylesheet fetch, so
// the styles cannot move to an external file. When Kit serves the fallback
// from inside resolve() (root-layout render throws, or the root error page
// itself fails), the dispatch decorates it with the production CSP, whose
// style-src 'self' would block the inline block and leave the page on UA
// defaults. The block is allowlisted by hash so style-src keeps no
// 'unsafe-inline' — the same shape as the leaf allowlist, but scoped
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
// replacement keeps the directive order byte-identical; it composes with
// the leaf hash on leaf paths, and is a no-op when the hash is already
// present or style-src is absent.
export function withKitFallbackStyleCsp(csp: string): string {
  if (csp.includes(KIT_FALLBACK_STYLE_SHA256)) return csp;
  return csp.replace("style-src 'self'", `style-src 'self' 'sha256-${KIT_FALLBACK_STYLE_SHA256}'`);
}
