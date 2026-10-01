// Optional join-funnel dashboard widget (TOG-11226): docs/parity.md promises
// the legacy JoinFunnelStats 60 s cache; this module owns that cache plus the
// bounded read the dashboard route awaits. The cache holds aggregate
// per-outcome counts only — no member data, no rendered HTML, no viewer
// identity. Same bounded-optional-widget contract as events/search-log.ts.

import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { joinFunnelStats } from "./reads";

/** Parity pin: the legacy JoinFunnelStats widget caches its aggregate for 60 s. */
export const FUNNEL_CACHE_TTL_MS = 60_000;
/** Read deadline: the optional widget must never hold the dashboard (a locked table would wait forever). */
export const FUNNEL_READ_DEADLINE_MS = 500;
/** DB-side cap below the response deadline so Postgres cancels a lock-blocked SELECT server-side. */
export const FUNNEL_DB_TIMEOUT_MS = 400;

type Funnel = Record<string, number>;
type FunnelRead = (db: Db) => Promise<Funnel>;

// One settled entry per isolate bounds memory and scopes reuse to the DB
// identity (the DATABASE_URL/Hyperdrive string in production, the injected Db
// object in tests); a second identity replaces the slot rather than sharing
// it. Pending I/O is never shared — a Worker invocation can end and cancel
// it, stranding later callers on an unresolved promise — so concurrent cold
// requests fill independently inside the deadline, and a generation counter
// keeps an older late fill from overwriting a newer published snapshot.
// Failures are not cached: a recovered database should show its widget on the
// next request.
let cache: { identity: unknown; value: Funnel; expiresAt: number } | undefined;
let nextFill = 0;
let publishedFill = 0;

/**
 * The aggregate runs in a transaction with transaction-scoped lock/statement
 * timeouts, so Postgres cancels a lock-blocked SELECT server-side instead of
 * the client deadline expiring while the query keeps the connection.
 */
async function funnelRead(db: Db): Promise<Funnel> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${FUNNEL_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${FUNNEL_DB_TIMEOUT_MS}ms`}, true)`,
    );
    return joinFunnelStats(tx);
  });
}

/**
 * Dashboard-facing funnel read: the aggregate is reused for FUNNEL_CACHE_TTL_MS
 * per DB identity, and every fill is bounded by FUNNEL_READ_DEADLINE_MS. A
 * failed, timed-out or indefinitely pending widget read resolves undefined —
 * the dashboard still answers 200. A classified DB outage propagates to the
 * shared sanitized 503 handler instead. `identity` scopes the cache to the
 * connection; `read` is a test seam.
 */
export async function dashboardJoinFunnel(
  db: Db,
  identity: unknown,
  deadlineMs = FUNNEL_READ_DEADLINE_MS,
  read: FunnelRead = funnelRead,
): Promise<Funnel | undefined> {
  if (cache && cache.identity === identity && Date.now() < cache.expiresAt) return cache.value;
  const fill = ++nextFill;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race also consumes late rejections after the deadline has won.
  const settled = (async (): Promise<Funnel | undefined> => {
    try {
      return await read(db);
    } catch (err) {
      if (isDatabaseUnavailable(err)) throw err;
      return undefined;
    }
  })();
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deadlineMs);
  });
  try {
    const value = await Promise.race([settled, deadline]);
    if (value === undefined) return undefined;
    if (fill > publishedFill) {
      publishedFill = fill;
      cache = { identity, value, expiresAt: Date.now() + FUNNEL_CACHE_TTL_MS };
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}
