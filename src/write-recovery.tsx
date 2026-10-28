import type { Context, Next } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { canonicalEventKey, eventKeyAllowed } from "./events/keys";
import { MAX_RETURN_DESTINATION_BYTES, safeNext } from "./join/service";
import { acceptsJson, isJsonMediaType } from "./media-type";
import { jsonRefusal } from "./json-refusal";
import { AUTH_THROTTLE_PER_MINUTE, throttleGuard } from "./throttle";
import { renderHtmlOutcome } from "./html-outcome";
import { honoRecoveryRenderer } from "./recovery-hono";
import { recoveryOutcome } from "./recovery-outcome";

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
  const key = c.req.path.match(/^\/(?:events|e)\/([^/]+)(?:\/|$)/)?.[1];
  const eventReturn =
    key && eventKeyAllowed(key, c.env.APP_URL) ? `/e/${canonicalEventKey(key) ?? key}` : "/events";
  const fallback =
    adminWriteReturn(c.req.path) ?? (c.req.path.startsWith("/members/") ? "/profile" : eventReturn);
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
  let match = rest.match(/^\/events\/([^/]+)\/(publish|cancel|duplicate|rsvp-pause|rsvp-reopen)$/);
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
  c.header("cache-control", "no-store, private");
  c.header("vary", "Cookie");
  // JSON callers keep 401, with an explicit recovery link, never an OAuth redirect.
  // JSON-only routes pass jsonOnly: a header-less fetch must not follow a 303 to a 200 page.
  // Accept uses exact media-range matching (shared with profile saves); Content-Type
  // is a single media type, so an exact case-insensitive comparison applies.
  if (
    jsonOnly ||
    acceptsJson(c.req.header("accept")) ||
    isJsonMediaType(c.req.header("content-type"))
  ) {
    return jsonRefusal(c, "unauthenticated", 401, { recovery: recoveryUrl(next) });
  }
  // A genuine expired write arms its own pending notice before the 303, so
  // the landing below never mints one on a mere visit (an attacker link
  // cannot pre-arm a false restored banner). JSON callers keep the 401 with
  // no cookie: they handle recovery themselves, never via the banner.
  await setSignedCookie(c, EXPIRED_WRITE_COOKIE, `pending|${next}`, c.env.SESSION_SECRET, OPTIONS);
  return c.redirect(recoveryUrl(next), 303);
}

/** Explicit recovery: carries only a safe GET destination, never a submitted body. */
export async function recoveryLanding(c: Ctx): Promise<Response> {
  const raw = c.req.query("next");
  const next = safeNext(raw) ?? "/profile";
  // Oversized destinations refuse before throttle spend (OAuth-callback
  // parity): the fallback still renders, but no budget is charged and — like
  // every landing visit — no pending notice is minted.
  const oversized =
    typeof raw === "string" &&
    new TextEncoder().encode(raw).byteLength > MAX_RETURN_DESTINATION_BYTES;
  if (!oversized) {
    const limited = await throttleGuard(c, "login-recover", AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
  }
  await setSignedCookie(c, INTENDED_COOKIE, next, c.env.SESSION_SECRET, OPTIONS);
  // No pending| here: only a genuine expired-write bounce arms the notice
  // (expiredWriteBounce above), so a bare link visit can never pre-arm a
  // false restored banner on the visitor's next login. The retry link below
  // carries the destination in its own ?next= query.
  // Same model, status (200) and headers as the direct render: the one-use
  // journey writes above stay Hono-owned and ride the buffered response (the
  // injected renderer only changes who turns the model into bytes).
  return renderHtmlOutcome(
    c,
    recoveryOutcome(
      {
        title: "Your session expired",
        message:
          "Your earlier changes were not saved. Sign in again, then review and submit them when you are ready.",
        retryUrl: `/auth/discord?next=${encodeURIComponent(next)}`,
        retryLabel: "Log in with Discord",
        inviteUrl: "/discord",
      },
      honoRecoveryRenderer,
      { headers: { "cache-control": "no-store, private", vary: "Cookie" } },
    ),
  );
}

/** Every terminal callback clears the pending notice, including denial/failure. */
export async function consumeExpiredWrite(c: Ctx): Promise<string | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, EXPIRED_WRITE_COOKIE);
  deleteCookie(c, EXPIRED_WRITE_COOKIE, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return typeof raw === "string" && raw.startsWith("pending|") ? safeNext(raw.slice(8)) : null;
}

export async function flashExpiredWrite(c: Ctx, next: string | null): Promise<void> {
  if (!next) return;
  await setSignedCookie(c, EXPIRED_WRITE_COOKIE, `restored|${next}`, c.env.SESSION_SECRET, OPTIONS);
}

/**
 * Failed auto-join retry: re-set the consumed pending notice as pending (not
 * restored) for the same destination, with the same signed/httpOnly/Lax/TTL
 * attributes. A pending notice is neither rendered nor consumed by the
 * intermediate join_failed page, so the retry-to-success callback can still
 * consume it and flash the restored banner. The input already passed safeNext
 * in consumeExpiredWrite, so no hostile destination can be smuggled here.
 */
export async function reflashPendingExpiredWrite(c: Ctx, next: string | null): Promise<void> {
  if (!next) return;
  await setSignedCookie(c, EXPIRED_WRITE_COOKIE, `pending|${next}`, c.env.SESSION_SECRET, OPTIONS);
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
  deleteCookie(c, EXPIRED_WRITE_COOKIE, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  c.header("cache-control", "no-store, private");
  c.header("vary", "Cookie");
  // The member just signed in: the banner keeps its copy with no link, so it
  // can never send them back to the expired-session landing (which would
  // re-arm the intended cookie and a fresh pending notice).
  const banner =
    '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';
  c.res = new Response(html.replace(/(<main\b[^>]*>)/, `$1${banner}`), {
    status: c.res.status,
    headers: c.res.headers,
  });
}
