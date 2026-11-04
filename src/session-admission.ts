import type { Context } from "hono";
import { generateCookie } from "hono/cookie";
import { parseSigned } from "hono/utils/cookie";
import type { Env } from "./env";
import { securityHeadersFor } from "./headers";
import { qaRunContext, qaRunCookieTtl, qaRunNamespaceMatches } from "./qa-run-auth";
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

// One response fence for both renderers. Buffer only an active qualification:
// a streamed/member render or post-release await must not deliver authority
// after E. Ordinary responses, including streaming, keep their exact behavior.
export function qaRunResponseFor(env: SessionAdmissionEnv) {
  return async (request: Request, render: () => Promise<Response>): Promise<Response> => {
    if (!qaRunConfigured(env)) return render();
    const binding = env.QA_RUN_AUTH;
    const context = await qaRunContext(binding, request.url, env.APP_URL);
    // Invalid/expired requests retain the routes' guest/status/refusal behavior;
    // every auth consumer independently refuses them before store admission.
    if (!context) return render();
    const refused = () =>
      new Response("Not Found", {
        status: 404,
        headers: {
          ...Object.fromEntries(
            securityHeadersFor({ path: new URL(request.url).pathname, method: request.method }),
          ),
          "cache-control": "no-store, private",
          "content-type": "text/plain; charset=UTF-8",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    if (request.signal.aborted) return refused();
    let response: Response;
    let body: ArrayBuffer;
    try {
      response = await render();
      body = await response.arrayBuffer();
    } catch {
      // A failed/cancelled stream must not escape to a renderer error handler
      // that can merge the old auth headers back into its error response.
      return refused();
    }
    const current = await qaRunContext(env.QA_RUN_AUTH, request.url, env.APP_URL);
    if (!current || binding !== env.QA_RUN_AUTH || request.signal.aborted) return refused();
    const ttl = qaRunCookieTtl(current);
    if (ttl === null) return refused();
    const headers = new Headers(response.headers);
    const cookies = headers.getSetCookie();
    headers.delete("set-cookie");
    headers.delete("content-length");
    headers.set("cache-control", "no-store, private");
    for (const cookie of cookies) {
      headers.append(
        "set-cookie",
        cookie.replace(
          /(;\s*max-age=)(\d+)/i,
          (_match, prefix, age) => prefix + Math.min(Number(age), ttl),
        ),
      );
    }
    return new Response(response.body === null ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
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
