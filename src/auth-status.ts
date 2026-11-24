import type { Context, Next } from "hono";
import { deleteCookie, generateSignedCookie, getSignedCookie } from "hono/cookie";
import { AUTH_STATUS_COOKIE, AUTH_STATUS_HEADERS, readAuthStatus } from "./http/auth-status";
import { SESSION_TTL_SECONDS, type SessionStore } from "./sessions";

export { AUTH_STATUS_COOKIE };
const OPTIONS = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  maxAge: SESSION_TTL_SECONDS,
};
type Ctx = Context<any>;

/** This signed hash can probe liveness only. It is never accepted as a login token. */
export async function enableAuthStatus(
  c: Ctx,
  store: SessionStore,
  tokenHash: string,
  knownKey?: string | null,
): Promise<void> {
  (await prepareAuthStatus(c, store, tokenHash, knownKey))?.();
}

/**
 * Signs the probe cookie up front and returns a synchronous attach step, for
 * callers that only learn after the handler whether they rendered a document.
 */
export async function prepareAuthStatus(
  c: Ctx,
  store: SessionStore,
  tokenHash: string,
  knownKey?: string | null,
): Promise<(() => void) | null> {
  const key = knownKey === undefined ? await store.statusHash(tokenHash) : knownKey;
  if (!key) return null;
  const cookie = await generateSignedCookie(AUTH_STATUS_COOKIE, key, c.env.SESSION_SECRET, OPTIONS);
  return () => {
    c.header("set-cookie", cookie, { append: true });
    c.set("authStatusEnabled", true);
  };
}

export function clearAuthStatus(c: Ctx): void {
  // Mirror OPTIONS (minus maxAge): a clearing Set-Cookie without
  // HttpOnly/SameSite is flagged by scanners (ZAP 10010/10054).
  deleteCookie(c, AUTH_STATUS_COOKIE, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
}

export async function authStatus(c: Ctx, storeFor: () => Promise<SessionStore>): Promise<Response> {
  for (const [name, value] of Object.entries(AUTH_STATUS_HEADERS)) c.header(name, value);
  const { authenticated, status } = await readAuthStatus(
    (name) => getSignedCookie(c, c.env.SESSION_SECRET, name),
    storeFor,
    c.get("requestId"),
  );
  return c.json({ authenticated }, status);
}

// Hono post-processing runs after inner guards/audit refusal:
// https://hono.dev/docs/guides/middleware#execution-order
export async function authStatusScript(c: Ctx, next: Next): Promise<void> {
  await next();
  if (
    !c.get("authStatusEnabled") ||
    c.req.method !== "GET" ||
    c.res.status !== 200 ||
    !c.res.headers.get("content-type")?.includes("text/html")
  )
    return;
  const html = await c.res.clone().text();
  // Fragments have no document and must never start a second sync controller.
  c.res = new Response(
    html.includes("</body>")
      ? html.replace(
          "</body>",
          '<script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script></body>',
        )
      : html,
    { status: c.res.status, headers: c.res.headers },
  );
}
