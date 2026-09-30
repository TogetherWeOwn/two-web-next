// Journey return state (TOG-10356). Ports the legacy session keys from
// tests/Feature/Auth/ReturnToPageTest.php and AlreadyMemberReinviteTest.php
// onto signed cookies — the only session this worker has is the one being
// minted, so the Laravel `login_next` / `url.intended` / `join_result` keys
// travel as short-lived, signed, HttpOnly cookies instead.
//
// Contract (ReturnToPageTest):
// - A safe `?next=` on the sign-in link rides the OAuth round trip; a hostile
//   value (absolute, protocol-relative, backslash, scheme, whitespace) leaves
//   no trace.
// - A gate that bounces a guest records where they were headed; the callback
//   returns them there when no explicit next exists (login_next > url.intended
//   > default landing).
// - Every terminal path — success, denial, failure — clears both cookies, so
//   a stale value can never surprise a later sign-in.
// - Both values pass safeNext again at consume time: a forged cookie never
//   verifies, and even a signed-but-hostile value cannot redirect off-app.
//
// join_result is the one-shot confirmation flash: set when the join callback
// signs the member in, consumed (deleted) on the first of /, /join, /profile
// that renders it — like the legacy session flash.
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Env } from "./env";
import { safeNext } from "./join/service";

export const LOGIN_NEXT_COOKIE = "__Host-two_login_next";
export const LOGIN_INTENDED_COOKIE = "__Host-two_login_intended";
export const JOIN_RESULT_COOKIE = "__Host-two_join_result";
// Same ten-minute window as the OAuth state cookie it accompanies.
const JOURNEY_TTL_SECONDS = 600;

// `any` env so callers carrying middleware Variables (profiles' viewer, the
// admin guard's actor/access) can pass their Context unchanged; hono's own
// cookie helpers take the untyped Context too.
type Ctx = Context<any>;

const cookieOpts = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
const deleteOpts = { path: "/", secure: true };

/**
 * Explicit `?next=` on the sign-in link. A safe value rides OAuth; anything
 * else leaves no trace (legacy: hostile writes never reach login_next).
 */
export async function rememberLoginNext(c: Ctx, raw: string | undefined): Promise<void> {
  const next = safeNext(raw);
  if (next) {
    await setSignedCookie(c, LOGIN_NEXT_COOKIE, next, c.env.SESSION_SECRET, {
      ...cookieOpts,
      maxAge: JOURNEY_TTL_SECONDS,
    });
  }
}

/**
 * Auth-gate bounce for a guest: record the page they asked for, then send
 * them into the ordinary Discord OAuth flow (legacy url.intended). GET/HEAD
 * only — a bounced write goes back to the page, never into a re-submit.
 */
export async function bounceToLogin(c: Ctx): Promise<Response> {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const url = new URL(c.req.url);
    await setSignedCookie(c, LOGIN_INTENDED_COOKIE, url.pathname + url.search, c.env.SESSION_SECRET, {
      ...cookieOpts,
      maxAge: JOURNEY_TTL_SECONDS,
    });
  }
  return c.redirect("/auth/discord", 302);
}

/**
 * Consume the return journey on the OAuth callback. Always deletes both
 * cookies — success, denial and failure paths all clear the state — and
 * answers the resolved destination: explicit next, then the recorded
 * intended page, else null for the caller's default landing.
 */
export async function consumeLoginReturn(c: Ctx): Promise<string | null> {
  const [rawNext, rawIntended] = await Promise.all([
    getSignedCookie(c, c.env.SESSION_SECRET, LOGIN_NEXT_COOKIE),
    getSignedCookie(c, c.env.SESSION_SECRET, LOGIN_INTENDED_COOKIE),
  ]);
  deleteCookie(c, LOGIN_NEXT_COOKIE, deleteOpts);
  deleteCookie(c, LOGIN_INTENDED_COOKIE, deleteOpts);
  return (
    safeNext(typeof rawNext === "string" ? rawNext : null) ??
    safeNext(typeof rawIntended === "string" ? rawIntended : null)
  );
}

/** The join outcomes that carry a confirmation banner (legacy join_result). */
export type JoinResult = "added" | "already_member";

/** Flash the one-shot join confirmation onto the callback's redirect response. */
export async function recordJoinResult(c: Ctx, result: JoinResult): Promise<void> {
  await setSignedCookie(c, JOIN_RESULT_COOKIE, result, c.env.SESSION_SECRET, {
    ...cookieOpts,
    maxAge: JOURNEY_TTL_SECONDS,
  });
}

/**
 * Read-and-delete the join confirmation: the banner renders exactly once,
 * like the legacy flash data. A forged or unexpected value is dropped.
 */
export async function takeJoinResult(c: Ctx): Promise<JoinResult | null> {
  const value = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_RESULT_COOKIE);
  if (value !== "added" && value !== "already_member") return null;
  deleteCookie(c, JOIN_RESULT_COOKIE, deleteOpts);
  return value;
}
