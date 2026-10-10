import type { Context, Next } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { safeNext } from "./join/service";
import { Recovery } from "./pages";

export const EXPIRED_WRITE_COOKIE = "__Host-two_expired_write";
const INTENDED_COOKIE = "__Host-two_login_intended";
export const WRITE_RECOVERY_TTL_SECONDS = 600;
const OPTIONS = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  maxAge: WRITE_RECOVERY_TTL_SECONDS,
};
type Ctx = Context<any>;

export const recoveryUrl = (next: string) =>
  `/auth/recover?next=${encodeURIComponent(safeNext(next) ?? "/profile")}`;

function writeReturn(c: Ctx): string {
  const fallback =
    adminWriteReturn(c.req.path) ?? (c.req.path.startsWith("/members/") ? "/profile" : "/events");
  try {
    const ref = new URL(c.req.header("referer") ?? "");
    if (ref.origin === new URL(c.env.APP_URL).origin)
      return safeNext(ref.pathname + ref.search) ?? fallback;
  } catch {
    /* No trusted page history: use a GET destination, never the write URL. */
  }
  return fallback;
}

/**
 * Admin POSTs bounce to the GET form page, never the write URL. Action-only
 * endpoints (publish/cancel/RSVP pause/delete) have no GET form, so they fall back to
 * the page holding their buttons; anything unrecognized falls back to the
 * dashboard. Every candidate re-passes safeNext at the use site.
 */
function adminWriteReturn(path: string): string | null {
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;
  const rest = path.slice("/admin".length);
  const candidates: Record<string, string> = {
    "/events": "/admin/events/new",
    "/featured": "/admin/featured/new",
  };
  if (candidates[rest]) return candidates[rest];
  let match = rest.match(/^\/events\/([^/]+)\/(publish|cancel|rsvp-pause|rsvp-reopen)$/);
  if (match) return safeNext(`/admin/events/${match[1]}`) ?? "/admin/events";
  match = rest.match(/^\/events\/([^/]+)$/);
  if (match) return safeNext(`/admin/events/${match[1]}`) ?? "/admin/events";
  match = rest.match(/^\/featured\/([^/]+)\/delete$/);
  if (match) return "/admin/featured";
  match = rest.match(/^\/featured\/([^/]+)$/);
  if (match) return safeNext(`/admin/featured/${match[1]}`) ?? "/admin/featured";
  return "/admin";
}

export async function expiredWriteBounce(c: Ctx, jsonOnly = false): Promise<Response> {
  const next = writeReturn(c);
  // JSON callers keep 401, with an explicit recovery link, never an OAuth redirect.
  // JSON-only routes pass jsonOnly: a header-less fetch must not follow a 303 to a 200 page.
  if (
    jsonOnly ||
    (c.req.header("accept") ?? "").includes("application/json") ||
    (c.req.header("content-type") ?? "").includes("application/json")
  ) {
    return c.json({ error: "Unauthorized", recovery: recoveryUrl(next) }, 401);
  }
  return c.redirect(recoveryUrl(next), 303);
}

/** Explicit recovery: carries only a safe GET destination, never a submitted body. */
export async function recoveryLanding(c: Ctx): Promise<Response> {
  const next = safeNext(c.req.query("next")) ?? "/profile";
  await setSignedCookie(c, INTENDED_COOKIE, next, c.env.SESSION_SECRET, OPTIONS);
  await setSignedCookie(c, EXPIRED_WRITE_COOKIE, `pending|${next}`, c.env.SESSION_SECRET, OPTIONS);
  c.header("cache-control", "no-store, private");
  return c.html(
    <Recovery
      title="Your session expired"
      message="Your earlier changes were not saved. Sign in again, then review and submit them when you are ready."
      retryUrl={`/auth/discord?next=${encodeURIComponent(next)}`}
      retryLabel="Log in with Discord"
      inviteUrl="/discord"
    />,
  );
}

/** Every terminal callback clears the pending notice, including denial/failure. */
export async function consumeExpiredWrite(c: Ctx): Promise<string | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, EXPIRED_WRITE_COOKIE);
  deleteCookie(c, EXPIRED_WRITE_COOKIE, { path: "/", secure: true });
  return typeof raw === "string" && raw.startsWith("pending|") ? safeNext(raw.slice(8)) : null;
}

export async function flashExpiredWrite(c: Ctx, next: string | null): Promise<void> {
  if (!next) return;
  await setSignedCookie(c, EXPIRED_WRITE_COOKIE, `restored|${next}`, c.env.SESSION_SECRET, OPTIONS);
}

/** Consume only an actual visible document, after all inner access/audit guards. */
export async function expiredWriteBanner(c: Ctx, next: Next): Promise<void> {
  await next();
  if (
    c.req.method !== "GET" ||
    c.req.path.startsWith("/auth/") ||
    c.res.status !== 200 ||
    !c.res.headers.get("content-type")?.includes("text/html")
  )
    return;
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, EXPIRED_WRITE_COOKIE);
  const destination =
    typeof raw === "string" && raw.startsWith("restored|") ? safeNext(raw.slice(9)) : null;
  if (!destination) return;
  // Keep the original stream usable while Hono rebuilds headers for deletion.
  const html = await c.res.clone().text();
  if (!html.includes("</body>") || !/<main\b[^>]*>/.test(html)) {
    c.res = new Response(html, { status: c.res.status, headers: c.res.headers });
    return;
  }
  deleteCookie(c, EXPIRED_WRITE_COOKIE, { path: "/", secure: true });
  c.header("cache-control", "no-store, private");
  c.header("vary", "Cookie");
  const banner =
    '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again. <a href="' +
    recoveryUrl(destination) +
    '">Try signing in again</a></div>';
  c.res = new Response(html.replace(/(<main\b[^>]*>)/, `$1${banner}`), {
    status: c.res.status,
    headers: c.res.headers,
  });
}
