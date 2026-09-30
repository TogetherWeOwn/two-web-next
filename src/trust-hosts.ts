// TrustHosts re-expression (W16: TOG-10110). Ports two-web's
// App\Http\Middleware\TrustHosts (APP_URL host only) to Workers.
//
// Legacy behaviour: only the APP_URL host is trusted; anything else raises
// before routing. Workers terminate TLS at the edge, so there is no
// trustProxies/nginx layer to port — and `X-Forwarded-Host` is deliberately
// ignored (it is client-controlled; honouring it is the classic poisoning
// vector). The allowlist is per-environment by construction: it is derived
// from that environment's APP_URL, so staging trusts the staging host,
// production trusts the production host, and nothing else in either.
//
// Refusal shape: the branded DB-free 404 (same page an unknown path gets),
// never a bare 400/421 — a scanner learns nothing about which hosts are
// valid, matching Laravel's production rendering of an untrusted host as a
// 404. The refused host is warn-logged server-side (structured field, never
// interpolated) so misconfigurations surface in the tail during the W16
// shadow run. Refused responses carry `no-store, private` from the 404
// handler, so a poisoned Host can never settle into a shared cache.
//
// Two allowances, both documented and safe:
// - Absent Host header: only synthetic traffic (Vitest's `app.request`, edge
//   probes) has none — Workers always set Host on real requests. Allowed so
//   the existing suite needs no churn; a missing host cannot poison anything
//   because no absolute URL is ever derived from it (all come from APP_URL).
// - Loopback (`localhost`, `127.0.0.1`, `::1`): `wrangler dev` and Vitest
//   serve loopback. Not routable, so not a poisoning vector for others.
//
// Mounted once on the main app in src/index.tsx, after secureHeaders (so a
// refusal still leaves with the hardened headers) and before every route.
// Sub-app factories (admin, profiles) carry no copy: in production all
// traffic enters through the main app's fetch.

import type { Context, Next } from "hono";
import type { Env } from "./env";
import { notFoundHandler } from "./errors";

const LOOPBACKS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Lowercase hostname without port/brackets; null when absent or empty. */
export function normalizeHost(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end === -1) return null;
    return v.slice(1, end) || null;
  }
  const colon = v.indexOf(":");
  const host = colon === -1 ? v : v.slice(0, colon);
  return host || null;
}

/** The one trusted hostname for this environment, from APP_URL. Null when misconfigured. */
export function trustedHost(appUrl: string): string | null {
  try {
    const h = new URL(appUrl).hostname.toLowerCase();
    return h === "" ? null : h;
  } catch {
    return null;
  }
}

/**
 * True when the request may proceed. Exact match only — subdomains,
 * parents, suffix-lookalikes and trailing-dot FQDN forms are all refused,
 * same as the legacy exact APP_URL allowlist.
 *
 * `hosts` carries every host signal on the request (the Host header and the
 * request URL's own hostname — in production the edge keeps them in
 * agreement; in tests either may be synthetic). One untrusted value refuses
 * the request.
 */
export function isTrustedHost(appUrl: string, hosts: Array<string | null | undefined>): boolean {
  const trusted = trustedHost(appUrl);
  for (const h of hosts) {
    const n = normalizeHost(h);
    if (n === null) continue; // absent Host: synthetic traffic only (see above)
    if (LOOPBACKS.has(n)) continue;
    if (trusted === null) return false; // misconfigured APP_URL fails closed
    if (n !== trusted) return false;
  }
  return true;
}

/** Refuse foreign Host values before routing. */
export function trustHosts() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let urlHost: string | null = null;
    try {
      urlHost = new URL(c.req.url).hostname;
    } catch {
      urlHost = null;
    }
    if (!isTrustedHost(c.env.APP_URL, [c.req.header("host"), urlHost])) {
      console.warn("refusing request with untrusted host", { host: c.req.header("host") });
      return notFoundHandler(c);
    }
    await next();
  };
}
