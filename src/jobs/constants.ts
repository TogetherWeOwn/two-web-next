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
export const RECONCILE_CRON = "*/10 * * * *"; // routes/console.php:35 everyTenMinutes()
export const PRUNE_CRON = "0 0 * * *"; // routes/console.php:19 daily() (Laravel daily = 00:00)

/** Gap before the attempt after `attempts` (1-based), holding at the last value (nextDelay / backoffFor). */
export function backoffFor(backoff: readonly number[], attempts: number): number {
  return backoff[Math.max(1, attempts) - 1] ?? backoff[backoff.length - 1]!;
}
