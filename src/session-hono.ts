import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { enableAuthStatus } from "./auth-status";
import type { Env, Session } from "./env";
import { SESSION_COOKIE } from "./session-cookie";
import { hashToken, SESSION_TTL_SECONDS } from "./sessions";
import {
  readSession as readStoredSession,
  type SessionReadMode,
  storeForEnv,
} from "./http/session";

/** Resolve a signed session and attach any renewal to the same response context. */
export async function readContextSession(
  c: Context<{ Bindings: Env }>,
  mode: SessionReadMode = true,
): Promise<Session | null> {
  const signed = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  const stored = await readStoredSession(signed, c.env, () => storeForEnv(c.env), mode);
  if (!stored) return null;
  const { store, row, renewal } = stored;
  const session = {
    id: row.userId,
    username: row.username,
    avatar: row.avatar,
    member: row.member,
    moderator: row.moderator,
  };
  if (!renewal) return session;
  const { replacement, statusKey } = renewal;
  await enableAuthStatus(c, store, await hashToken(replacement), statusKey);
  await setSignedCookie(c, SESSION_COOKIE, replacement, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return session;
}
