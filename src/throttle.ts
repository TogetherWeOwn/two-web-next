// Human-route throttles (N5: TOG-9897). Ports the legacy `throttle:10,1` /
// `throttle:30,1` route middleware onto the shared Postgres fixed-window
// counter (web_throttle_hits, join/service.ts) and refuses with the one 429
// shape (errors.tsx rateLimitExceeded, ThrottleEnvelope::render).
import type { Context, MiddlewareHandler } from "hono";
import postgres from "postgres";
import { rateLimitExceeded } from "./errors";
import type { Env } from "./env";
import { databaseOptions, databaseUrl } from "./db/connection";
import { checkJoinThrottle } from "./join/service";
import type { Sql } from "./sessions";

/** `throttle:10,1` — join redirect/callback, login callback, QA login. */
export const AUTH_THROTTLE_PER_MINUTE = 10;
/** `throttle:30,1` — logout, event writes, profile writes. */
export const WRITE_THROTTLE_PER_MINUTE = 30;

export type ThrottleStore = () => Promise<Sql | null>;
export type EnvWithThrottle = Env & { THROTTLE_STORE?: ThrottleStore };

const THROTTLED = Symbol.for("two-web-next.throttled");

/** Test seam first, then local URL or Hyperdrive; absent store degrades to allow.
 * No DDL here (TOG-19721): web_throttle_hits comes from the migrate workflow
 * (drizzle/1000); the runtime role stays read/write-only. */
export async function throttleStore(c: Context<{ Bindings: Env }>): Promise<Sql | null> {
  const injected = (c.env as EnvWithThrottle).THROTTLE_STORE;
  if (injected) return injected();
  const url = databaseUrl(c.env);
  if (!url) return null;
  return postgres(url, databaseOptions) as unknown as Sql;
}

export const MAX_CLIENT_KEY_SEGMENT = 64;

/** IPv6 clients share a /64; IPv4 and its mapped form share the IPv4 key. Shared with the agent-events shield so anonymous buckets match human throttles. */
export function normalizeClientIp(ip: string): string {
  return boundClientSegment(normalizeClientIpUnbounded(ip));
}

function boundClientSegment(value: string): string {
  return value.length > MAX_CLIENT_KEY_SEGMENT ? value.slice(0, MAX_CLIENT_KEY_SEGMENT) : value;
}

function normalizeClientIpUnbounded(ip: string): string {
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
 * The per-client key every human-route bucket is built from. On Cloudflare
 * `cf-connecting-ip` is always set and cannot be forged by the client; the
 * `x-forwarded-for` hop and "anon" only matter off-edge (local runs, tests).
 * See docs/throttling.md for prefix sharing and rollout behaviour.
 */
export const clientKey = (c: Context) => {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return normalizeClientIp(cf) || "anon";
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    for (const hop of xff.split(",")) {
      const trimmed = hop.trim();
      if (trimmed) return normalizeClientIp(trimmed) || "anon";
    }
  }
  return "anon";
};

/** Class-only classification of a store rejection: never the message, which can quote statement bindings. */
const MAX_THROTTLE_CLASS_LENGTH = 100;

function exceptionClass(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.name
      : ((err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown");
  // Only strings are sanitized: a non-string name must degrade to unknown
  // instead of throwing the fail-open catch into a 500.
  const name = typeof raw === "string" ? raw : "unknown";
  // De-newline and bound: a hostile error name must not forge log lines.
  return name.replace(/[\r\n]+/g, "_").slice(0, MAX_THROTTLE_CLASS_LENGTH) || "unknown";
}

const THROTTLE_REFUSAL_LOG_BURST = 20;
const THROTTLE_REFUSAL_LOG_REFILL_MS = 3_000;
let refusalLogTokens = THROTTLE_REFUSAL_LOG_BURST;
let lastRefusalLogRefill = 0;

// Fixed-size isolate state, no client keys or timers. Consume synchronously
// just before logging so concurrent refusals cannot overspend the budget.
// Same shape as takeCspLogToken (src/csp-reports.ts): a 429 storm must stay
// visible in logs without letting the storm dictate log volume.
function takeThrottleRefusalLogToken(): boolean {
  const now = Date.now();
  const elapsed = Math.max(0, now - lastRefusalLogRefill);
  refusalLogTokens = Math.min(
    THROTTLE_REFUSAL_LOG_BURST,
    refusalLogTokens + elapsed / THROTTLE_REFUSAL_LOG_REFILL_MS,
  );
  lastRefusalLogRefill = Math.max(lastRefusalLogRefill, now);
  if (refusalLogTokens < 1) return false;
  refusalLogTokens -= 1;
  return true;
}

// Bounded shed signal: at most one warn per refill window, fixed keys only,
// no request content. Counts log-budget drops since the previous shed emit so
// operators can tell a shedding guard from a quiet one without flooding.
let refusalShedDropped = 0;
let lastRefusalShedEmit = 0;
function warnThrottleRefusalShed(): void {
  refusalShedDropped += 1;
  const now = Date.now();
  if (now - lastRefusalShedEmit < THROTTLE_REFUSAL_LOG_REFILL_MS) return;
  lastRefusalShedEmit = now;
  const dropped = refusalShedDropped;
  console.warn("throttle.refused.shed", { dropped });
  refusalShedDropped -= dropped;
}

/** In-handler form for GET routes, where a middleware entry would widen the read inventory. */
export async function throttleGuard(
  c: Context<{ Bindings: Env }>,
  name: string,
  max: number,
): Promise<Response | null> {
  const bucket = `${name}:${clientKey(c)}`;
  const verdict = await throttleStore(c)
    .then((sql) => checkJoinThrottle(sql, bucket, max))
    .catch((err: unknown) => {
      // Fail open with a throttle-naming, class-only line: the client segment
      // is a member IP and must never be logged, and the message can quote
      // statement bindings. Exactly one line per allow: the null-store
      // allow already warned inside checkJoinThrottle (no throw, so this
      // catch never runs for it), and the verdict transaction never warns
      // before rethrowing.
      console.warn("Throttle store failed; allowing the request.", {
        throttle: name,
        exception: exceptionClass(err),
      });
      return { limited: false } as const;
    });
  if (!verdict.limited) return null;
  // Refusal telemetry: route class + outcome only — never the "<name>:<client>"
  // bucket (the client segment is a member IP), never body bytes. One site
  // covers the middleware and in-handler forms, over-budget and busy-path
  // verdicts alike; the 429 itself is unchanged.
  if (takeThrottleRefusalLogToken())
    console.warn("throttle.refused", { throttle: name, outcome: "rate_limited" });
  else warnThrottleRefusalShed();
  return rateLimitExceeded(c, verdict.retryAfter);
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
