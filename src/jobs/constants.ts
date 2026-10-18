// Retry/uniqueness/retention constants, copied byte-for-byte from the Laravel originals in
// TogetherWeOwn/two-web @ 3965a6e8. test/jobs.test.ts pins every value; change a
// number here only together with a deliberate, reviewed parity decision.

// app/Jobs/SyncEventToDiscord.php
export const SYNC_EVENT = {
  debounceSeconds: 10, // :49 DEBOUNCE_SECONDS
  uniqueForSeconds: 300, // :56 $uniqueFor
  backoffSeconds: [10, 60, 300, 900, 3600], // :67 $backoff
  tries: 6, // :69 $tries
} as const;

// app/Jobs/CallInternalAction.php
export const CALL_INTERNAL_ACTION = {
  tries: 5, // :69 $tries
  backoffSeconds: [5, 15, 60, 180], // :78 BACKOFF
} as const;

// routes/console.php + config/member_access_log.php:14
export const MEMBER_ACCESS_LOG_RETENTION_DAYS = 90;
export const AGENT_EVENT_AUDIT_RETENTION_DAYS = 90;
// routes/console.php model:prune ×3 (TOG-8710 join funnel + agent replay store, TOG-8400 search log)
export const JOIN_ATTEMPT_RETENTION_DAYS = 90; // config/join.php: attempt_retention_days
export const IDEMPOTENCY_KEY_RETENTION_DAYS = 90; // config/agent-events.php: idempotency_retention_days
export const EVENT_SEARCH_LOG_RETENTION_DAYS = 90; // config/event_search_log.php: retention_days
// Anonymous board views (hot zones + member leaderboard): same 90-day retention
// as event searches, pruned by occurred_at (see src/hotzones/board-log.ts).
export const BOARD_VIEW_LOG_RETENTION_DAYS = 90;
export const RECONCILE_CRON = "*/10 * * * *"; // routes/console.php:35 everyTenMinutes()
export const PRUNE_CRON = "0 0 * * *"; // routes/console.php:19 daily() (Laravel daily = 00:00)
// Max stale events one reconcile pass redispatches. The stale selection is
// paged deterministically (`ORDER BY event_key` + `LIMIT`); each pass asks
// the store for exactly one page and dispatches at most that many keys in
// the returned order. Dirty rows parked behind a permanently undispatchable
// pending request (budget spent, null deadline) are not stale and never
// consume page slots. Other leftovers stay stale, so the next pass (every
// ten minutes per RECONCILE_CRON) picks them up once earlier keys have synced.
// The bound keeps a large dirty backlog from exceeding Worker CPU/time
// limits mid-loop and repeating identically each pass. The pass result and
// its single completion log line carry the deferred remainder next to the
// other counts; cadence, dispatch semantics and retention are unchanged.
export const RECONCILE_REDISPATCH_PAGE_SIZE = 200;
// Max rows one daily pass deletes per pruned table, including the scheduled
// web_sessions expiry sweep. Postgres DELETE takes no LIMIT, so each
// statement deletes the oldest N ids (age tables) or N expiry-eligible
// session hashes (`expires_at <= now`, expiry-exact rows go, live rows stay)
// via a subselect and reports the exact count through RETURNING. The pass
// repeats the batched statement until a short batch proves the backlog
// drained, so a backlog above one batch clears in a single pass instead of
// piling past retention. The loop stops after PRUNE_DELETE_MAX_BATCHES
// batches per table (100k rows) to bound the `model:prune` single-flight
// hold; a final full batch pages once via `scheduled.failing@model:prune`
// (one redacted line, no table detail) with rows possibly pending, for any
// table including the session sweep. A later pass drains leftovers;
// session lifetime is unchanged.
export const PRUNE_DELETE_BATCH_SIZE = 1000;
// Max batched statements per age-pruned table per daily pass: 100k rows,
// covering the worst-case public event-search inflow (60 reads/min = 86,400
// rows/day from one client) with headroom, plus the smaller join inflow
// (14,400/day); larger floods page once per pass instead of silently piling past retention.
export const PRUNE_DELETE_MAX_BATCHES = 100;

/** Gap before the attempt after `attempts` (1-based), holding at the last value (nextDelay / backoffFor). */
export function backoffFor(backoff: readonly number[], attempts: number): number {
  return backoff[Math.max(1, attempts) - 1] ?? backoff[backoff.length - 1]!;
}
