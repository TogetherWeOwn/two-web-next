import type { Context, Next } from "hono";
import { matchedRoutes } from "hono/route";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RAY_ID = /^[a-fA-F0-9]{16}(?:-[A-Z]{3})?$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Accept only correlation IDs, never arbitrary client-supplied header text. */
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && (RAY_ID.test(value) || ULID.test(value)) ? value : undefined;
}

/** 48-bit timestamp + 80 cryptographically random bits, Crockford base32. */
export function newRequestId(): string {
  let value = BigInt(Date.now());
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) value = (value << 8n) | BigInt(byte);
  let id = "";
  for (let i = 0; i < 26; i++) {
    id = BASE32[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

/** Registered patterns include mount prefixes, but never resolved params. */
export function requestRoute(c: Context): string {
  // routeIndex is the handler that responded, so /events/new is not logged as
  // a later /events/:key. A wildcard guard or 404 names the first endpoint the
  // router would run, and wildcard-only matches get one constant label, never
  // the user-supplied path (or an identity).
  // Source: https://hono.dev/docs/helpers/route#matchedroutes
  const paths = matchedRoutes(c).map((r) => r.path);
  const responded = paths[c.req.routeIndex];
  if (responded && !responded.endsWith("*")) return responded;
  return paths.find((path) => !path.endsWith("*")) ?? "unmatched";
}

export async function requestLog(c: Context, next: Next): Promise<void> {
  const started = performance.now();
  const requestId = safeRequestId(c.req.header("cf-ray")) ?? newRequestId();
  c.set("requestId", requestId);
  // Hono handles downstream exceptions before next resolves. Run this wrapper
  // outermost so downstream response replacements are included in the status.
  // Source: https://hono.dev/docs/guides/middleware#execution-order
  await next();
  c.header("x-request-id", requestId);
  const colo = (c.req.raw.cf as { colo?: unknown } | undefined)?.colo;
  console.log(JSON.stringify({
    event: "http.request",
    request_id: requestId,
    method: c.req.method,
    route: requestRoute(c),
    status: c.res.status,
    duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
    colo: typeof colo === "string" && /^[A-Z]{3}$/.test(colo) ? colo : null,
  }));
}
