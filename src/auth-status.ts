import type { Context, Next } from "hono";
import { deleteCookie, generateCookie, generateSignedCookie, getSignedCookie } from "hono/cookie";
import { qaRunContext, qaRunCookieTtl, qaRunNamespaceMatches } from "./qa-run-auth";
import {
  qaRunConfigured,
  qaRunSessionsFor,
  readSessionCookie,
  uniqueCookie,
} from "./session-admission";
import { exceptionClass } from "./alerts";
import { safeRequestId } from "./request-log";
import { hashToken, isValidSessionToken, SESSION_TTL_SECONDS, type SessionStore } from "./sessions";

export const AUTH_STATUS_COOKIE = "__Host-two_session_status";
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
  if (qaRunConfigured(c.env)) {
    const context = await qaRunContext(c.env.QA_RUN_AUTH, c.req.url, c.env.APP_URL);
    if (!context) return null;
    const key = knownKey === undefined ? await store.statusHash(tokenHash) : knownKey;
    if (
      !key ||
      !qaRunNamespaceMatches(key, "status", context.verifier.q) ||
      !(await qaRunSessionsFor(c.req.raw, c.env, store).isActive(key))
    )
      return null;
    return () => {
      // Attachment may follow a buffered render. Never stamp an already-expired
      // probe with the original (longer) preparation-time Max-Age.
      const ttl = qaRunCookieTtl(context);
      if (ttl === null) return;
      c.header(
        "set-cookie",
        generateCookie(AUTH_STATUS_COOKIE, key, {
          ...OPTIONS,
          maxAge: Math.min(SESSION_TTL_SECONDS, ttl),
        }),
        { append: true },
      );
      c.set("authStatusEnabled", true);
    };
  }
  const key = knownKey === undefined ? await store.statusHash(tokenHash) : knownKey;
  if (!key || key.startsWith("q1p.")) return null;
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
  c.header("cache-control", "no-store, private");
  c.header("vary", "Cookie");
  try {
    if (qaRunConfigured(c.env)) {
      const context = await qaRunContext(c.env.QA_RUN_AUTH, c.req.url, c.env.APP_URL);
      if (!context) return c.json({ authenticated: false });
      const key = uniqueCookie(c.req.raw, AUTH_STATUS_COOKIE);
      const token = await readSessionCookie(c);
      if (key && qaRunNamespaceMatches(key, "status", context.verifier.q)) {
        return c.json({
          authenticated: await qaRunSessionsFor(c.req.raw, c.env, await storeFor()).isActive(key),
        });
      }
      return c.json({
        authenticated: token
          ? !!(await qaRunSessionsFor(c.req.raw, c.env, await storeFor()).read(token))
          : false,
      });
    }
    const key = await getSignedCookie(c, c.env.SESSION_SECRET, AUTH_STATUS_COOKIE);
    const token = await readSessionCookie(c);
    if (typeof key === "string" && /^[a-f0-9]{64}$/.test(key)) {
      return c.json({ authenticated: await (await storeFor()).isActive(key) });
    }
    // Pre-rollout clients without a probe cookie remain read-only too.
    const valid = isValidSessionToken(token);
    return c.json({
      authenticated: valid ? !!(await (await storeFor()).get(await hashToken(token))) : false,
    });
  } catch (err) {
    // An outage is not a logout. Clients must ignore non-success responses.
    // One class-only warn joins the 503 for triage.
    console.warn("auth status store unavailable", {
      exception: exceptionClass(err),
      request_id: safeRequestId(c.get("requestId")),
    });
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
