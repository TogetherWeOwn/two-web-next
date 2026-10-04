// Human-route throttles (N5: TOG-9897). Ports the legacy `throttle:10,1` /
// `throttle:30,1` route middleware onto the shared Postgres fixed-window
// counter (web_throttle_hits, join/service.ts) and refuses with the one 429
// shape (errors.tsx rateLimitExceeded, ThrottleEnvelope::render).
import type { Context, MiddlewareHandler } from "hono";
import postgres from "postgres";
import { rateLimitExceeded } from "./errors";
import type { Env } from "./env";
import { databaseOptions, databaseUrl } from "./db/connection";
import { checkJoinThrottle, migrateJoin } from "./join/service";
import type { Sql } from "./sessions";

/** `throttle:10,1` — join redirect/callback, login callback, QA login. */
export const AUTH_THROTTLE_PER_MINUTE = 10;
/** `throttle:30,1` — logout, event writes, profile writes. */
export const WRITE_THROTTLE_PER_MINUTE = 30;

export type ThrottleStore = () => Promise<Sql | null>;
export type EnvWithThrottle = Env & { THROTTLE_STORE?: ThrottleStore };

const THROTTLED = Symbol.for("two-web-next.throttled");
const migrated = new Set<string>();

/** Test seam first, then local URL or Hyperdrive; absent store degrades to allow. */
export async function throttleStore(c: Context<{ Bindings: Env }>): Promise<Sql | null> {
  const injected = (c.env as EnvWithThrottle).THROTTLE_STORE;
  if (injected) return injected();
  const url = databaseUrl(c.env);
  if (!url) return null;
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  if (!migrated.has(url)) {
    await migrateJoin(sql);
    migrated.add(url);
  }
  return sql;
}

/** IPv6 clients share a /64; IPv4 and its mapped form share the IPv4 key. */
function normalizeClientIp(ip: string): string {
  if (!ip.includes(":") || !/^[0-9a-f:.]+$/i.test(ip)) return ip;
  try {
    // URL validates IPv6 and serializes embedded IPv4 as hex pieces.
    // Source: https://url.spec.whatwg.org/#concept-ipv6-parser
    const address = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = address.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const pieces =
      right === undefined
        ? start
        : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
    if (pieces.slice(0, 5).every((piece) => piece === "0") && pieces[5] === "ffff") {
      return pieces
        .slice(6)
        .flatMap((piece) => {
          const value = Number.parseInt(piece, 16);
          return [value >> 8, value & 255];
        })
        .join(".");
    }
    return `${pieces.slice(0, 4).join(":")}::/64`;
  } catch {
    // Preserve the existing fallback key for malformed off-edge headers.
    return ip;
  }
}

/**
 * Keep header precedence unchanged; normalize only the selected address.
 * See docs/throttling.md for prefix sharing and rollout behaviour.
 */
const clientKey = (c: Context) =>
  normalizeClientIp(
    c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "anon",
  );

/** In-handler form for GET routes, where a middleware entry would widen the read inventory. */
export async function throttleGuard(
  c: Context<{ Bindings: Env }>,
  name: string,
  max: number,
): Promise<Response | null> {
  const verdict = await throttleStore(c)
    .then((sql) => checkJoinThrottle(sql, `${name}:${clientKey(c)}`, max))
    .catch(() => ({ limited: false }) as const);
  return verdict.limited ? await rateLimitExceeded(c, verdict.retryAfter) : null;
}

/**
 * Route middleware: `app.post(path, throttle("logout", 30), handler)`. Bucket is
 * `<name>:<client ip>`; a store failure allows (a missed count beats a 500).
 * The returned handler carries a marker the every-POST-throttled audit reads.
 */
export function throttle(name: string, max: number): MiddlewareHandler<{ Bindings: Env }> {
  const mw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    const limited = await throttleGuard(c, name, max);
    if (limited) return limited;
    await next();
  };
  (mw as unknown as Record<symbol, boolean>)[THROTTLED] = true;
  return mw;
}

export const isThrottleMiddleware = (fn: unknown): boolean =>
  typeof fn === "function" && (fn as unknown as Record<symbol, boolean>)[THROTTLED] === true;
