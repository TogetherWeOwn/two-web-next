import postgres from "postgres";
import { databaseOptions, databaseUrl, withPerRequestStatementBound } from "../db/connection";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import { refreshSessionRoles, roleRecheckConfigFor } from "../session-role-refresh";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  type DbSessionRow,
  hashToken,
  isValidSessionToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
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
 * (`issueSession` below); not reentrant — never wrap it in itself.
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

/** Issue a fresh login session; the caller owns roster and cookie I/O. */
export async function issueSession(
  store: SessionStore,
  row: DbSessionRow,
  {
    readPriorToken,
    warnSweepFailure,
  }: {
    readPriorToken: () => Promise<unknown>;
    warnSweepFailure: (error: unknown) => void;
  },
): Promise<string> {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const replacement = {
    tokenHash,
    ...row,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  };
  const prior = await readPriorToken();
  // Malformed pre-login bearers never reach the store: the shared
  // minted-shape gate rejects them before hashing (malformed prior =>
  // create, never replace).
  const priorHash = isValidSessionToken(prior) ? await hashToken(prior) : null;
  // Serialize the insert+sweep per user (see withFreshLoginUserLock): the
  // second overlapping issuance waits for the first to finish, so the final
  // state equals a serialized order — newest live, previous revoked. The wait
  // is bounded: a holder stuck past FRESH_LOGIN_LOCK_WAIT_MS (for example a
  // disconnect-cancelled callback that never settles its tail) no longer wedges
  // later logins; the overlap stays fail-closed. A sweep failure still
  // completes sign-in (fail-open wins over strict newest-wins: both stay live
  // rather than failing the login). A degenerate empty user id runs unlocked;
  // Discord ids are never empty.
  const runLocked =
    typeof row.userId === "string" && row.userId
      ? (fn: () => Promise<void>) => withFreshLoginUserLock(row.userId, fn)
      : (fn: () => Promise<void>) => fn();
  await runLocked(async () => {
    // Fresh authentication revokes the presented pre-login/pre-join token
    // atomically with the insert (a failed insert leaves the prior session
    // intact; see store.replace). The token is revoked by hash because it can
    // belong to a different user (shared terminal).
    if (priorHash) {
      await store.replace(priorHash, replacement);
    } else {
      await store.create(replacement);
    }
    // Session fixation: additionally revoke every other live session for this
    // user so only the newest survives. The fresh row already exists: a sweep
    // failure warns and sign-in still succeeds (fail-open on the sweep, never
    // a logout-on-login). Token-hash-only.
    try {
      await store.revokeUserSessions(row.userId, tokenHash);
    } catch (err) {
      warnSweepFailure(err);
    }
  });
  return token;
}

type SessionRead = {
  store: SessionStore;
  row: DbSessionRow;
  renewal: { replacement: string; statusKey: string | null } | null;
};

export type SessionReadMode = boolean | { currentMemberId: string };

/** Resolve a verified bearer and optionally rotate it. The caller owns cookie I/O. */
export async function readSession(
  token: unknown,
  env: Env,
  storeFor: () => Promise<SessionStore>,
  mode: SessionReadMode,
): Promise<SessionRead | null> {
  if (!isValidSessionToken(token)) return null;
  // Anonymous public pages must not depend on session storage or its startup DDL.
  const store = await storeFor();
  const tokenHash = await hashToken(token);
  const storedRow = await store.get(tokenHash);
  if (!storedRow) return null;
  // A dedicated write principal must match before any Discord role lookup.
  if (typeof mode === "object" && storedRow.userId !== mode.currentMemberId) return null;
  // Mid-session role recheck: bits older than the cadence re-derive from
  // Discord before they authorize (src/session-role-refresh.ts). A row that
  // stopped being live during the refresh reads as no session.
  const row = await refreshSessionRoles(store, tokenHash, storedRow, roleRecheckConfigFor(env));
  if (!row) return null;
  // Recheck liveness after role refresh. Only the current bearer can submit
  // the dedicated write, and an aborted action must not rotate that bearer.
  if (typeof mode === "object") {
    if (!row.member || row.userId !== mode.currentMemberId) return null;
    const live = await store.getLive(tokenHash);
    if (!live?.member || live.userId !== mode.currentMemberId) return null;
    return { store, row, renewal: null };
  }
  // Abortable calendar fragments validate expiry/revocation but must not delete
  // the browser's current token: an aborted response cannot deliver a replacement.
  if (!mode) return { store, row, renewal: null };

  // Rotate atomically, keeping the immediate predecessor valid for 10s (bounded
  // by its own expiry) while the successor stays live. Rotation errors are
  // outages, not guest reads: preserve classified database errors and normalize
  // the rest to plain Error for the caller's existing outage boundary.
  const statusKey = await store.statusHash(await hashToken(token));
  const replacement = newSessionToken();
  let rotated: boolean;
  try {
    rotated = await store.rotate(await hashToken(token), {
      tokenHash: await hashToken(replacement),
      ...row,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
  } catch (err) {
    if (isDatabaseUnavailable(err)) throw err;
    throw new Error("Session rotation unavailable");
  }
  if (!rotated) {
    // Re-read once for predecessor grace or a lost rotation race. Authenticated
    // grace reads do not renew cookies; revoked or expired sessions stay guest.
    const graceRow = await store.get(await hashToken(token));
    return graceRow ? { store, row: graceRow, renewal: null } : null;
  }
  return { store, row, renewal: { replacement, statusKey } };
}
