import { exceptionClass } from "../alerts";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken, type SessionStore } from "../sessions";
import { safeRequestId } from "./request-log";

export const AUTH_STATUS_COOKIE = "__Host-two_session_status";
export const AUTH_STATUS_HEADERS = {
  "cache-control": "no-store, private",
  vary: "Cookie",
} as const;

/** A signed status hash probes its lineage only. Session admission stays separate. */
export async function readAuthStatus(
  readCookie: (name: typeof AUTH_STATUS_COOKIE | typeof SESSION_COOKIE) => Promise<unknown>,
  storeFor: () => Promise<Pick<SessionStore, "isActive" | "get">>,
  requestId: unknown,
): Promise<{ authenticated: boolean; status: 200 | 503 }> {
  try {
    const key = await readCookie(AUTH_STATUS_COOKIE);
    const token = await readCookie(SESSION_COOKIE);
    if (typeof key === "string" && /^[a-f0-9]{64}$/.test(key)) {
      return { authenticated: await (await storeFor()).isActive(key), status: 200 };
    }
    // Pre-rollout clients without a usable probe cookie get a read-only bearer lookup.
    return {
      authenticated: isValidSessionToken(token)
        ? !!(await (await storeFor()).get(await hashToken(token)))
        : false,
      status: 200,
    };
  } catch (err) {
    // Clients ignore this non-success response rather than marking the session signed out.
    console.warn("auth status store unavailable", {
      exception: exceptionClass(err),
      request_id: safeRequestId(requestId),
    });
    return { authenticated: false, status: 503 };
  }
}
