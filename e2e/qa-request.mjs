// Token-bearing staging requests (TOG-13046, CISO condition C2 on TOG-13035).
//
// Playwright puts the full request headers, including `X-TWO-QA-Auth`, into
// two places a caught error cannot reach: the message of a transport-level
// `apiRequestContext.post` failure (socket hang up, timeout, reset), which
// the HTML report stores, and the `APIRequestContext.fetch` call params and
// log lines recorded into every retained trace — for every context created
// during a run, including a standalone `chromium.launch()` context and the
// `request` fixture. Under a hook or test timeout the pending call is
// already in the trace, so scrubbing the thrown error never sees it. The
// staging repo is public and its failure artifacts are downloadable, so the
// token must not pass through Playwright at all: token-bearing requests go
// over Node `fetch`, which Playwright does not instrument, and any error
// that still leaves this module is reason-only. The artifact sweep in
// ci/scrub-qa-token.py stays as defense in depth, not the primary control.

import assert from "node:assert/strict";
import {
  parseRetryAfterSeconds,
  qaLoginThrottleError,
  QA_LOGIN_MAX_ATTEMPTS,
  sleep,
} from "./qa-login-retry.mjs";

const MAX_REASON_LENGTH = 120;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * Safe, bounded reason for a failed request: the Node error code when there is
 * one, else the first message line only (Playwright appends `Call log:` and
 * the headers after it), with the token scrubbed from what is kept.
 *
 * @param {unknown} error
 * @param {string} [token]
 */
export function transportFailureReason(error, token) {
  const scrub = (text) => (token ? text.split(token).join("[redacted]") : text);
  if (error === null || typeof error !== "object") return "request error";
  const { code, message } = /** @type {{ code?: unknown; message?: unknown }} */ (error);
  if (typeof code === "string" && ERROR_CODE.test(code)) return scrub(code);
  if (typeof message === "string") {
    const line = scrub(message.split(/\r?\n/, 1)[0] ?? "")
      .trim()
      .slice(0, MAX_REASON_LENGTH);
    if (line) return line;
  }
  return "request error";
}

/**
 * Run one token-bearing request. A rejection is rethrown as a fresh error with
 * a reason-only message: no `cause`, no call log, no headers. Only the request
 * itself goes in `send`; assertions on its response stay outside so their own
 * messages are untouched.
 *
 * @template T
 * @param {string} label what failed, e.g. `staging QA login as qa-member`
 * @param {string | undefined} token the secret to scrub from the reason
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export async function sendTokenRequest(label, token, send) {
  try {
    return await send();
  } catch (error) {
    throw new Error(`${label} failed: ${transportFailureReason(error, token)}`);
  }
}

/**
 * The minimal response shape token callers rely on.
 *
 * @typedef {object} TokenFetchResponse
 * @property {number} status
 * @property {{ get(name: string): string | null, getSetCookie(): string[] }} headers
 * @property {{ cancel(): Promise<void> } | null} [body]
 */

/**
 * One token-bearing request over Node `fetch` — Playwright never sees the
 * headers, so neither a retained trace nor a report can record them, under
 * a plain failure or a timeout alike. Redirects are not followed, matching
 * the `maxRedirects: 0` the Playwright call used, and a transport failure
 * is rethrown reason-only by sendTokenRequest. This is the only transport
 * allowed to carry the QA token; the scrub keeps watch for anything that
 * bypasses it.
 *
 * @param {string} label what failed, e.g. `staging QA login as qa-member`
 * @param {string | undefined} token the secret to scrub from the reason
 * @param {string} url absolute request URL
 * @param {{ method?: string, headers?: Record<string, string> }} [init]
 * @returns {Promise<TokenFetchResponse>}
 */
export async function fetchTokenRequest(label, token, url, init = {}) {
  return sendTokenRequest(label, token, () => fetch(url, { redirect: "manual", ...init }));
}

/**
 * One cookie of a Playwright storage state.
 *
 * @typedef {object} StorageStateCookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain
 * @property {string} path
 * @property {number} expires unix seconds, -1 for a session cookie
 * @property {boolean} httpOnly
 * @property {boolean} secure
 * @property {"Strict" | "Lax" | "None"} sameSite
 */

/**
 * Parse one `Set-Cookie` header into the storage-state cookie a browser jar
 * would have persisted for `origin`. `Max-Age` wins over `Expires` when both
 * arrive, as in a jar. Returns null for a header with no `name=value` pair.
 *
 * @param {string} header one Set-Cookie header value
 * @param {string} origin the origin the cookie was set from
 * @returns {StorageStateCookie | null}
 */
export function parseSetCookie(header, origin) {
  const [pair, ...attributes] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  /** @type {StorageStateCookie} */
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: new URL(origin).hostname,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  };
  let maxAgeSeconds;
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "domain" && value) cookie.domain = value;
    else if (key === "path" && value) cookie.path = value;
    else if (key === "expires") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expires = Math.floor(parsed / 1000);
    } else if (key === "max-age") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) maxAgeSeconds = parsed;
    } else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") {
      const normalized = value.toLowerCase();
      cookie.sameSite = normalized === "strict" ? "Strict" : normalized === "none" ? "None" : "Lax";
    }
  }
  if (maxAgeSeconds !== undefined) {
    cookie.expires = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  }
  return cookie;
}

/** The signed session cookie POST /auth/qa/:identity sets on a 204. */
export const QA_SESSION_COOKIE = "__Host-two_session";

/**
 * Sign one QA identity in over fetch and return the Playwright storage
 * state holding every cookie the response set. This is the whole login:
 * the token header plus the explicit Origin the same-origin gate needs, the
 * bounded 429 retry on the shared `qa-login` throttle, and the session
 * gates the browser jar used to enforce — the state is only returned when
 * a real Secure HttpOnly `__Host-` session cookie for the origin host
 * arrived. A bad token or unknown identity answers 404, never a redirect.
 *
 * @param {object} options
 * @param {string} options.origin the origin to sign in against
 * @param {string} options.identity "qa-member" | "qa-moderator"
 * @param {string} options.token the QA token, never substituted on failure
 * @param {string} options.header the header the token travels in
 * @returns {Promise<{ cookies: StorageStateCookie[], origins: [] }>}
 */
export async function qaLogin({ origin, identity, token, header }) {
  const label = `staging QA login as ${identity}`;
  let retryAfterSeconds = 60;
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS; attempt++) {
    const response = await fetchTokenRequest(label, token, `${origin}/auth/qa/${identity}`, {
      method: "POST",
      headers: { [header]: token, Origin: origin },
    });
    if (response.status === 429) {
      // Throttled: honor the server's Retry-After across the minute
      // boundary instead of failing the file.
      const retryAfter = response.headers.get("retry-after");
      retryAfterSeconds = parseRetryAfterSeconds(
        retryAfter === null ? undefined : { "retry-after": retryAfter },
      );
      await response.body?.cancel().catch(() => {});
      if (attempt < QA_LOGIN_MAX_ATTEMPTS) await sleep(retryAfterSeconds * 1000);
      continue;
    }
    assert.equal(response.status, 204, label);
    const cookies = response.headers
      .getSetCookie()
      .map((setCookie) => parseSetCookie(setCookie, origin))
      .filter((cookie) => cookie !== null);
    // Persist only a real Set-Cookie session: the Secure HttpOnly __Host-
    // cookie for this origin's host must be among them before anything is
    // saved. A `__Host-` cookie carries no Domain attribute; if one ever
    // arrives it still has to name this host.
    const session = cookies.find((cookie) => cookie.name === QA_SESSION_COOKIE);
    assert.equal(session?.domain.replace(/^\./, ""), new URL(origin).hostname);
    assert.equal(session?.httpOnly, true);
    assert.equal(session?.secure, true);
    await response.body?.cancel().catch(() => {});
    return { cookies, origins: [] };
  }
  throw qaLoginThrottleError(identity, retryAfterSeconds, QA_LOGIN_MAX_ATTEMPTS);
}
