import type { Env } from "./env";
import { AUTH_STATUS_COOKIE, AUTH_STATUS_HEADERS, readAuthStatus } from "./http/auth-status";
import { storeForEnv } from "./http/session";
import { signedCookiePairs, verifySignedCookie } from "./http/signed-cookie";
import { SESSION_COOKIE } from "./session-cookie";

const STATUS_COOKIE_NAMES: ReadonlySet<string> = new Set([AUTH_STATUS_COOKIE, SESSION_COOKIE]);

/** Build the GET /auth/status response after host, method and public-read admission. */
export async function kitAuthStatusResponse(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response> {
  const header = request.headers.get("cookie");
  const cookies = signedCookiePairs(header, STATUS_COOKIE_NAMES);
  const { authenticated, status } = await readAuthStatus(
    async (name) =>
      header ? verifySignedCookie(cookies.get(name), env.SESSION_SECRET, "hono") : null,
    () => storeForEnv(env),
    requestId,
  );
  return Response.json({ authenticated }, { status, headers: AUTH_STATUS_HEADERS });
}
