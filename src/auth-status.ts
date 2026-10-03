import type { Context, Next } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { hashToken, SESSION_TTL_SECONDS, type SessionStore } from "./sessions";

export const AUTH_STATUS_COOKIE = "__Host-two_session_status";
const SESSION_COOKIE = "__Host-two_session";
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
  const key = knownKey === undefined ? await store.statusHash(tokenHash) : knownKey;
  if (!key) return;
  await setSignedCookie(c, AUTH_STATUS_COOKIE, key, c.env.SESSION_SECRET, OPTIONS);
  c.set("authStatusEnabled", true);
}

export function clearAuthStatus(c: Ctx): void {
  deleteCookie(c, AUTH_STATUS_COOKIE, { path: "/", secure: true });
}

export async function authStatus(c: Ctx, storeFor: () => Promise<SessionStore>): Promise<Response> {
  c.header("cache-control", "no-store, private");
  c.header("vary", "Cookie");
  try {
    const key = await getSignedCookie(c, c.env.SESSION_SECRET, AUTH_STATUS_COOKIE);
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    if (typeof key === "string" && /^[a-f0-9]{64}$/.test(key)) {
      return c.json({ authenticated: await (await storeFor()).isActive(key) });
    }
    // Pre-rollout clients without a probe cookie remain read-only too.
    const valid = typeof token === "string" && token.startsWith("two_");
    return c.json({
      authenticated: valid ? !!(await (await storeFor()).get(await hashToken(token))) : false,
    });
  } catch {
    // An outage is not a logout. Clients must ignore non-success responses.
    return c.json({ authenticated: false }, 503);
  }
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
