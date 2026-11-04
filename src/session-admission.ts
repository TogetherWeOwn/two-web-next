import type { Context } from "hono";
import { generateCookie } from "hono/cookie";
import { parseSigned } from "hono/utils/cookie";
import type { Env } from "./env";
import { qaRunContext, qaRunNamespaceMatches } from "./qa-run-auth";
import { createQaRunSessionBoundary, type QaRunSessionGrant } from "./qa-run-session";
import { SESSION_COOKIE } from "./session-cookie";
import { isValidSessionToken, SESSION_TTL_SECONDS, type SessionStore } from "./sessions";

export class QaRunSessionRefused extends Error {}

export type SessionAdmissionEnv = Pick<Env, "APP_URL" | "SESSION_SECRET" | "QA_RUN_AUTH">;

export function qaRunConfigured(env: Pick<Env, "QA_RUN_AUTH">): boolean {
  // An empty or malformed present binding is a refusal, never ordinary mode.
  return env.QA_RUN_AUTH !== undefined;
}

export function qaRunRequestFor(request: Request, env: SessionAdmissionEnv) {
  return { binding: env.QA_RUN_AUTH, requestUrl: request.url, appUrl: env.APP_URL };
}

// Qualification cookies are canonical, opaque values. Read exactly one named
// cookie; duplicate, quoted or incorrectly encoded values cannot choose a
// different parser/fallback. Ordinary signed cookies retain Hono's parser.
export function uniqueCookie(request: Request, name: string): string | null {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.slice(0, entry.indexOf("=")) === name);
  if (entries.length !== 1) return null;
  const encoded = entries[0]!.slice(name.length + 1);
  try {
    const value = decodeURIComponent(encoded);
    return encodeURIComponent(value) === encoded ? value : null;
  } catch {
    return null;
  }
}

export async function readSessionToken(
  request: Request,
  env: SessionAdmissionEnv,
): Promise<string | null> {
  const raw = uniqueCookie(request, SESSION_COOKIE);
  if (qaRunConfigured(env)) {
    const context = await qaRunContext(env.QA_RUN_AUTH, request.url, env.APP_URL);
    return context && raw && qaRunNamespaceMatches(raw, "session", context.verifier.q) ? raw : null;
  }
  // Reserved namespaces never reach the legacy verifier, even with a copied
  // signing key or a malformed/duplicate qualification cookie.
  const header = request.headers.get("cookie") ?? "";
  if (!header || /(?:^|;)\s*__Host-two_session=[^;]*q1s(?:\.|%2[eE])/.test(header)) return null;
  const token = (await parseSigned(header, env.SESSION_SECRET, SESSION_COOKIE))[SESSION_COOKIE];
  return isValidSessionToken(token) ? token : null;
}

export function readSessionCookie(
  c: Pick<Context<{ Bindings: Env }>, "req" | "env">,
): Promise<string | null> {
  return readSessionToken(c.req.raw, c.env);
}

export function qaRunSessionsFor(request: Request, env: SessionAdmissionEnv, store: SessionStore) {
  return createQaRunSessionBoundary(store, qaRunRequestFor(request, env));
}

export async function qaRunSessionCookie(
  request: Request,
  env: SessionAdmissionEnv,
  grant: Pick<QaRunSessionGrant, "token">,
): Promise<string | null> {
  const context = await qaRunContext(env.QA_RUN_AUTH, request.url, env.APP_URL);
  if (!context || !qaRunNamespaceMatches(grant.token, "session", context.verifier.q)) return null;
  return generateCookie(SESSION_COOKIE, grant.token, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: Math.min(SESSION_TTL_SECONDS, Math.max(0, Math.floor(context.deadline - context.now))),
  });
}
