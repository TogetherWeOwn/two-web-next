import type { Context } from "hono";
import { deleteCookie, getSignedCookie } from "hono/cookie";
import { exceptionClass } from "../alerts";
import { AUTH_STATUS_COOKIE, clearAuthStatus } from "../auth-status";
import type { Env } from "../env";
import {
  databaseUnavailable,
  outageRepresentation,
  prefersHtmlError,
  varyAccept,
} from "../error-responses";
import { safeRequestId } from "../http/request-log";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken, REVOKE_ALL_EXCEPT, type SessionStore } from "../sessions";
import { consumeExpiredWrite } from "../write-recovery";

type SignOutContext = Context<{ Bindings: Env }>;

async function clearCookiesAndRedirect(c: SignOutContext): Promise<Response> {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  clearAuthStatus(c);
  await consumeExpiredWrite(c);
  return c.redirect("/", 303);
}

function revocationUnavailable(c: SignOutContext, err: unknown, message: string) {
  // Preserve browser cookies until revocation succeeds. Driver messages may
  // carry connection details, so log only the class and correlation ID.
  console.error(message, {
    exception: exceptionClass(err),
    request_id: safeRequestId(c.get("requestId")),
  });
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  if (prefersHtmlError(c)) return databaseUnavailable(c);
  if (outageRepresentation(c) === "application/json") return databaseUnavailable(c, true);
  return c.text("Sign-out temporarily unavailable", 503);
}

/** Sign out after host, same-origin, action-body and logout-throttle admission. */
export async function signOut(
  c: SignOutContext,
  storeFor: () => Promise<SessionStore>,
): Promise<Response> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  // Absent, unsigned and malformed bearers clear cookies even with storage down.
  if (isValidSessionToken(token)) {
    try {
      const store = await storeFor();
      // Revoke this lineage even if the presented bearer has already rotated.
      await store.revoke(await hashToken(token));
      const statusHash = await getSignedCookie(c, c.env.SESSION_SECRET, AUTH_STATUS_COOKIE);
      if (typeof statusHash === "string" && /^[a-f0-9]{64}$/.test(statusHash)) {
        await store.revokeLineage(statusHash);
      }
    } catch (err) {
      return revocationUnavailable(c, err, "logout revocation failed");
    }
  }
  return clearCookiesAndRedirect(c);
}

/** Sign out everywhere after the same admission as ordinary sign-out. */
export async function signOutEverywhere(
  c: SignOutContext,
  storeFor: () => Promise<SessionStore>,
): Promise<Response> {
  c.header("cache-control", "no-store, private");
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  // An unusable bearer clears the cookies without reaching storage.
  if (isValidSessionToken(token)) {
    try {
      const store = await storeFor();
      const session = await store.get(await hashToken(token));
      // Only a live bearer resolves the acting member. A dead bearer
      // revokes nothing, even when its status cookie names a live lineage.
      if (session) {
        // A single sweep takes the presented token along with its siblings.
        // A failed sweep leaves the bearer available to resolve on retry.
        await store.revokeUserSessions(session.userId, REVOKE_ALL_EXCEPT);
      }
    } catch (err) {
      return revocationUnavailable(c, err, "logout everywhere revocation failed");
    }
  }
  return clearCookiesAndRedirect(c);
}
