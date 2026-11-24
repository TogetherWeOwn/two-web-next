import { Context } from "hono";
import { signOut, signOutEverywhere } from "./auth/sign-out";
import type { Env } from "./env";
import { internalErrorHandler } from "./error-responses";
import { safeRequestId } from "./http/request-log";
import { storeForEnv } from "./http/session";

/**
 * Build a response for an admitted sign-out POST. The caller must first verify
 * the host and origin, enforce the action body cap and spend the shared logout
 * throttle budget. The caller also owns global security and request logging.
 */
export function fetchKitSignOut(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response | null> {
  return fetchAdmittedSignOut(request, env, "/logout", signOut, requestId);
}

/**
 * Build a response for an admitted sign-out-everywhere POST. The caller owns
 * the same admission as fetchKitSignOut, including the shared logout throttle.
 */
export function fetchKitSignOutEverywhere(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response | null> {
  return fetchAdmittedSignOut(request, env, "/logout/everywhere", signOutEverywhere, requestId);
}

async function fetchAdmittedSignOut(
  request: Request,
  env: Env,
  pathname: string,
  respond: typeof signOut,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== pathname) return null;

  const c = new Context<{ Bindings: Env }>(request, { env, path: pathname });
  const id = safeRequestId(requestId);
  if (id !== undefined) {
    c.set("requestId", id);
    c.header("x-request-id", id);
  }
  try {
    return await respond(c, () => storeForEnv(env));
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return internalErrorHandler(err, c, pathname);
  }
}
