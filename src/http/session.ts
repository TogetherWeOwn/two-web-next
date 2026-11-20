import postgres from "postgres";
import { databaseOptions, databaseUrl, withPerRequestStatementBound } from "../db/connection";
import type { Env } from "../env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  type SessionStore,
  type Sql,
} from "../sessions";

// Test seam: tests carry a SessionStore on the env object (`{...env, SESSION_STORE: store}`,
// cast at the call site). Production bindings never set it, so this branch is dead in
// production. It keeps per-request store isolation without module-global state.
type EnvWithStore = Env & { SESSION_STORE?: SessionStore };

// Shared with the Kit hook: the same DB selection Hono uses, so
// Kit reads the sessions Hono writes. Same lifecycle too — a short-lived
// per-request client, Hyperdrive pooling underneath, idle_timeout reaping.
export async function storeForEnv(env: Env): Promise<SessionStore> {
  const injected = (env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = databaseUrl(env);
  // No DB configuration: a fresh memory store per request fails closed to guest.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client; Hyperdrive pools underneath in the Worker.
  // Keep it alive while the store uses it; idle_timeout closes idle sockets.
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  // Per-request statement bound (SET LOCAL in a short transaction per
  // statement): a stuck session lookup cancels into the existing outage
  // handling instead of wedging the request. Journeys share the adapter, so
  // the OAuth consume path is bounded the same way.
  return createPostgresSessionStore(withPerRequestStatementBound(sql));
}

/** Fresh-login mutual exclusion, per user: overlapping callbacks for the same
 * user run their insert+sweep one at a time, so insert A, insert B, sweep A,
 * sweep B cannot revoke both fresh tokens. Keys are user ids only — never a
 * global lock, so different users stay concurrent. Process-wide (not
 * per-store) so per-request store instances still serialize the same user;
 * entries are removed when their tail has no waiter. Holds no session data and
 * no live database connection while waiting (per-request clients connect
 * lazily on first query, inside the lock body — a queued waiter adds no
 * socket beyond the client its own request already owns). Single call site
 * (`issueSession` in the Hono entrypoint); not reentrant — never wrap it in itself.
 *
 * Cross-isolate note: this chain serializes only within one isolate. Two
 * callbacks for the same user on different isolates still overlap; that case
 * stays fail-closed (re-login, no leak) until a store-coordinated follow-up
 * lands behind the same per-user scope. */
const freshLoginChains = new Map<string, Promise<void>>();

/** Bound on waiting for the previous same-user issuance (see
 * withFreshLoginUserLock): a holder that never settles its tail — a store
 * query stalled on transport (the per-request statement timeout cancels
 * server-side execution, not a dead socket) or a disconnect-cancelled
 * callback — would otherwise hang that user's future logins on the isolate
 * indefinitely. Normal insert+sweep work is millisecond-scale and the
 * barrier-test hold is 1.5 s, so 10 s (matching the DB connect timeout) only
 * fires on a genuinely stuck holder; the bound must stay above the worst
 * legitimate hold or waiters time out into the very overlap the lock exists
 * to prevent. A timeout overlap stays fail-closed (re-login, no leak), never
 * wedged — trading a both-dead window after a >10 s stall for eliminating
 * the indefinite hang. Exported for tests; production callers use the
 * default. */
export const FRESH_LOGIN_LOCK_WAIT_MS = 10_000;

export async function withFreshLoginUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
  waitMs = FRESH_LOGIN_LOCK_WAIT_MS,
): Promise<T> {
  const prev = freshLoginChains.get(userId) ?? Promise.resolve();
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const cur = prev.then(() => tail);
  freshLoginChains.set(userId, cur);
  // Bounded wait: skip waiting on a stuck predecessor, never unlink the
  // chain — later waiters still queue behind this tail, preserving FIFO
  // order. The timer is cleared on the fast path so settled waits hold no
  // resources. `prev` never rejects (tails only resolve), so the race cannot
  // throw here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prev,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  try {
    return await fn();
  } finally {
    releaseTail();
    if (freshLoginChains.get(userId) === cur) freshLoginChains.delete(userId);
  }
}
