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
import { hashToken, isValidSessionToken, type SessionStore } from "../sessions";
import { consumeExpiredWrite } from "../write-recovery";

/** Sign out after host, same-origin, action-body and logout-throttle admission. */
export async function signOut(
  c: Context<{ Bindings: Env }>,
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
      // Preserve browser cookies until revocation succeeds. Driver messages may
      // carry connection details, so log only the class and correlation ID.
      console.error("logout revocation failed", {
        exception: exceptionClass(err),
        request_id: safeRequestId(c.get("requestId")),
      });
      c.header("cache-control", "no-store, private");
      varyAccept(c);
      if (prefersHtmlError(c)) return databaseUnavailable(c);
      if (outageRepresentation(c) === "application/json") return databaseUnavailable(c, true);
      return c.text("Sign-out temporarily unavailable", 503);
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  clearAuthStatus(c);
  await consumeExpiredWrite(c);
  return c.redirect("/", 303);
}
