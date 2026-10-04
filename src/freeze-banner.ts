// Cutover step 1: member-facing freeze notice from docs/cutover-freeze.md.
//
// Flag-gated, off by default: unset (or anything but "true"/"1") renders
// nothing, leaving HTML byte-identical. When enabled, a <p class="notice">
// carrying the freeze dates and a relative /privacy link is prepended inside
// <main> on GET 200 HTML documents, using the same document anchors as the
// expired-write banner. No scripts, no cookies, no session or database reads.
// The banner is identical for every viewer, so public cache headers are left
// untouched (unlike the per-viewer expired-write banner, which goes
// private/no-store with Vary: Cookie).
import type { Context, Next } from "hono";

type Ctx = Context<any>;

export const FREEZE_BANNER_TESTID = "freeze-banner";

export function freezeBannerEnabled(env: { FREEZE_BANNER_ENABLED?: string }): boolean {
  return env.FREEZE_BANNER_ENABLED === "true" || env.FREEZE_BANNER_ENABLED === "1";
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function freezeBannerHtml(env: {
  FREEZE_BANNER_ENABLED?: string;
  FREEZE_BANNER_DATES?: string;
}): string | null {
  if (!freezeBannerEnabled(env)) return null;
  // The flag alone never renders: without real dates there is no freeze to
  // announce, so flipping the switch early stays invisible too.
  const dates = (env.FREEZE_BANNER_DATES ?? "").trim();
  if (!dates) return null;
  return (
    `<p class="notice" role="status" data-testid="${FREEZE_BANNER_TESTID}">` +
    `Moving to our new site soon — edits frozen ${escapeHtml(dates)}. ` +
    `<a href="/privacy">Privacy page</a> updated to version 2; details in Discord.</p>`
  );
}

/** Post-processing injector with the same document gate as the expired-write banner. */
export async function freezeBanner(c: Ctx, next: Next): Promise<void> {
  await next();
  if (
    c.req.method !== "GET" ||
    c.req.path.startsWith("/auth/") ||
    c.res.status !== 200 ||
    !c.res.headers.get("content-type")?.includes("text/html")
  )
    return;
  const banner = freezeBannerHtml(c.env);
  if (!banner) return;
  const html = await c.res.clone().text();
  if (!html.includes("</body>") || !/<main\b[^>]*>/.test(html)) return;
  c.res = new Response(html.replace(/(<main\b[^>]*>)/, `$1${banner}`), {
    status: c.res.status,
    headers: c.res.headers,
  });
}
