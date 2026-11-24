import { Context } from "hono";
import { signOut } from "./auth/sign-out";
import type { Env } from "./env";
import { internalErrorHandler } from "./error-responses";
import { safeRequestId } from "./http/request-log";
import { storeForEnv } from "./http/session";

/**
 * Build a response for an admitted sign-out POST. The caller must first verify
 * the host and origin, enforce the action body cap and spend the shared logout
 * throttle budget. The caller also owns global security and request logging.
 */
export async function fetchKitSignOut(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const { pathname } = new URL(request.url);
  if (pathname !== "/logout" && pathname !== "/logout/everywhere") return null;

  const c = new Context<{ Bindings: Env }>(request, { env, path: pathname });
  const id = safeRequestId(requestId);
  if (id !== undefined) {
    c.set("requestId", id);
    c.header("x-request-id", id);
  }
  try {
    return await signOut(
      c,
      () => storeForEnv(env),
      pathname === "/logout" ? "session" : "everywhere",
    );
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return internalErrorHandler(err, c, pathname);
  }
}
