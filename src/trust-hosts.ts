// TrustHosts re-expression (W16: TOG-10110). Only the environment's APP_URL
// hostname is trusted. X-Forwarded-Host is deliberately ignored: it is
// client-controlled, and absolute URLs always come from APP_URL.
//
// Both the request URL and any supplied Host must match. A missing Host
// header is safe only when the URL is trusted; a present malformed Host is
// never treated as missing. Development uses a loopback APP_URL, not a
// runtime exemption. An invalid APP_URL fails closed for every request.
//
// Mounted after secureHeaders and before routes, including the ASSETS
// fallback. Wrangler must use run_worker_first so assets cannot bypass it.
// Refusals use the branded DB-free 404, never echo the host, and carry
// no-store, private so an untrusted Host cannot settle into a shared cache.

import type { Context, Next } from "hono";
import type { Env } from "./env";
import { notFoundResponse } from "./errors";
import { isTrustedHost } from "./http/trust-hosts";
import { safeRequestId } from "./request-log";

export { isTrustedHost, normalizeHost, trustedHost } from "./http/trust-hosts";

/** Refuse foreign Host values before routing. */
export function trustHosts() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let urlHost: string | null = null;
    try {
      urlHost = new URL(c.req.url).host;
    } catch {
      // An invalid request URL is refused, even with a trusted Host header.
    }
    if (urlHost === null || !isTrustedHost(c.env.APP_URL, [c.req.header("host"), urlHost])) {
      const requestId = safeRequestId(c.get("requestId"));
      console.warn(
        JSON.stringify({
          event: "http.untrusted_host",
          ...(requestId ? { request_id: requestId } : {}),
          next_action: "check_app_url_and_proxy_host",
        }),
      );
      return notFoundResponse(c);
    }
    await next();
  };
}
