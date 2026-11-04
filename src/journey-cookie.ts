// Qualification notices carry navigation/display data only, never authority.
// OAuth callbacks are separately disabled for every present QA_RUN_AUTH value.
import type { Context } from "hono";
import { generateCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { parseSigned } from "hono/utils/cookie";
import { qaRunContext } from "./qa-run-auth";
import { JOURNEY_TTL_SECONDS } from "./return-journey";
import { qaRunConfigured, uniqueCookie, type SessionAdmissionEnv } from "./session-admission";

const NAMES = new Set([
  "__Host-two_login_next",
  "__Host-two_login_intended",
  "__Host-two_join_result",
  "__Host-two_expired_write",
  "__Host-two_oauth_state",
  "__Host-two_join_state",
  "__Host-two_join_next",
  "__Host-two_join_source",
]);
const PREFIX = "q1n.";
type Ctx = Context<any>;

export async function readJourneyCookie(
  request: Request,
  env: SessionAdmissionEnv,
  name: string,
): Promise<string | null> {
  if (!NAMES.has(name)) return null;
  const raw = uniqueCookie(request, name);
  if (qaRunConfigured(env)) {
    const context = await qaRunContext(env.QA_RUN_AUTH, request.url, env.APP_URL);
    if (!context || !raw?.startsWith(PREFIX) || raw.length > 4096) return null;
    try {
      const data: unknown = JSON.parse(raw.slice(PREFIX.length));
      if (
        !Array.isArray(data) ||
        data.length !== 4 ||
        JSON.stringify(data) !== raw.slice(PREFIX.length)
      )
        return null;
      const [cookieName, q, expiry, value] = data;
      return cookieName === name &&
        q === context.verifier.q &&
        Number.isSafeInteger(expiry) &&
        expiry > context.now &&
        expiry <= context.deadline &&
        typeof value === "string" &&
        new TextEncoder().encode(value).length <= 2048
        ? value
        : null;
    } catch {
      return null;
    }
  }
  if (raw?.startsWith(PREFIX)) return null;
  const header = request.headers.get("cookie");
  if (!header) return null;
  const value = (await parseSigned(header, env.SESSION_SECRET, name))[name];
  return typeof value === "string" && !value.startsWith(PREFIX) ? value : null;
}

export async function getJourneyCookie(
  c: Ctx,
  secret: string,
  name: string,
): Promise<string | false | undefined | null> {
  if (qaRunConfigured(c.env)) return readJourneyCookie(c.req.raw, c.env, name);
  const value = await getSignedCookie(c, secret, name);
  return typeof value === "string" && value.startsWith(PREFIX) ? null : value;
}

export async function setJourneyCookie(
  c: Ctx,
  name: string,
  value: string,
  secret: string,
  options: CookieOptions,
): Promise<void> {
  if (!qaRunConfigured(c.env)) {
    await setSignedCookie(c, name, value, secret, { ...options, maxAge: JOURNEY_TTL_SECONDS });
    return;
  }
  const cookie = await qaRunJourneyCookie(c.req.raw, c.env, name, value, options);
  if (cookie) c.header("set-cookie", cookie, { append: true });
}

export async function qaRunJourneyCookie(
  request: Request,
  env: SessionAdmissionEnv,
  name: string,
  value: string,
  options: CookieOptions,
): Promise<string | null> {
  if (!NAMES.has(name) || new TextEncoder().encode(value).length > 2048) return null;
  const context = await qaRunContext(env.QA_RUN_AUTH, request.url, env.APP_URL);
  if (!context) return null;
  const ttl = Math.max(
    0,
    Math.min(options.maxAge ?? JOURNEY_TTL_SECONDS, Math.floor(context.deadline - context.now)),
  );
  const expiry = Math.min(context.deadline, Math.floor(context.now + ttl));
  return generateCookie(name, PREFIX + JSON.stringify([name, context.verifier.q, expiry, value]), {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: Math.min(JOURNEY_TTL_SECONDS, ttl),
  });
}
