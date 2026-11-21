import { parseSigned } from "hono/utils/cookie";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken, type SessionStore } from "../sessions";

const MAX_COOKIE_LENGTH = 8192;

type SocketSession =
  | { kind: "guest" }
  | { kind: "session"; ref: string; validUntil: number }
  | { kind: "refused"; status: 401 | 503 };

/** A missing session may get the public feed; a present but invalid one may not. */
export async function resolveLiveSocketSession(
  cookie: string,
  secret: string | undefined,
  getLive: SessionStore["getLive"],
  now: () => number = Date.now,
): Promise<SocketSession> {
  // Reject ambiguous combined headers and duplicate session names rather than
  // accepting whichever value the shared parser happens to visit first.
  if (cookie.length > MAX_COOKIE_LENGTH || cookie.includes(",")) {
    return { kind: "refused", status: 401 };
  }
  const [session, duplicate] = cookie
    .split(";")
    .filter((pair) => pair.split("=", 1)[0]?.trim() === SESSION_COOKIE);
  if (session === undefined) return { kind: "guest" };
  if (duplicate !== undefined) return { kind: "refused", status: 401 };
  if (!secret) return { kind: "refused", status: 503 };
  try {
    const cookies = await parseSigned(session, secret, SESSION_COOKIE);
    const token = cookies[SESSION_COOKIE];
    if (!isValidSessionToken(token)) return { kind: "refused", status: 401 };
    // Internal lookup key only. Neither the bearer nor any identity or role
    // proof belongs in the result or a hibernating socket attachment.
    const ref = await hashToken(token);
    const live = await getLive(ref);
    if (!live) return { kind: "refused", status: 401 };
    const time = now();
    if (!Number.isFinite(time) || !Number.isFinite(live.validUntil)) {
      return { kind: "refused", status: 503 };
    }
    if (live.validUntil <= time) return { kind: "refused", status: 401 };
    return { kind: "session", ref, validUntil: live.validUntil };
  } catch {
    return { kind: "refused", status: 503 };
  }
}
