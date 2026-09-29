# TOG-9680 findings (updated 2026-09-29)

## Control leg: direct Postgres — 3/3 PASS

`checks.py` (+ `schema.sql`) against `agent-testdb` (Postgres 17.11), throwaway
schema, torn down after the run. Rerun:
`DATABASE_URL="host=agent-testdb port=5432 user=agent_test dbname=agent_test" python3 checks.py`.
Shapes mirror two-web @ main (file:line in `schema.sql` header).

- (a) FOR UPDATE: second writer blocks on the event row (`lock_timeout` → 55P03);
  post-commit `going=1` with `capacity=1`, i.e. the `takesASeat` check refuses the loser. PASS
- (b) Advisory: `pg_advisory_xact_lock` excludes a concurrent txn; re-acquirable
  after holder commit; session `pg_advisory_lock/unlock` round-trips on direct PG. PASS
- (c) GIN: `subject_user_ids @> '[424242]'` uses
  `spike_access_logs_subject_user_ids_gin` (`jsonb_path_ops`, as in the two-web
  migration), 2001 rows / 1 hit. PASS

wrangler used for version pin: **4.143.1** (`npx wrangler --version`).

## Hyperdrive docs review (Cloudflare docs, fetched 2026-09-29)

- Pooler runs in **transaction mode**: connection returned + `RESET` after each
  transaction; `SET` does not persist; **one Worker invocation may hold multiple
  connections** (`how-hyperdrive-works`).
- Consequence: **session-scoped** `pg_advisory_lock` is NOT portable through
  Hyperdrive — the cron single-flight (W13) must use `pg_advisory_xact_lock`
  (validated above) or equivalent. Finding for W13, not a blocker.
- Named prepared statements "may have worse performance or may not be
  supported" — only `pg` (recommended, ≥8.16.3) and `postgres.js` (≥3.4.5,
  `prepare:false` = no cache + extra round-trips) are supported
  (`connect-to-postgres`, `how-hyperdrive-works`). Watch item for W3/Drizzle.
- Limits (`platform/limits`): 60 s statement cap, ~100 origin conns (Paid),
  10 min idle timeout. None threaten the three shapes.

## two-web lock inventory (ground truth for the port)

two-web uses **no `pg_advisory_*` calls** (`gh search code` 2026-09-29):
`FOR UPDATE` row locks (`EventService::rsvp/update/*ForGrant`) and DB-backed
`Cache::lock('agent-event-grant:…')` / `Cache::lock('agent-event:…')`
(`AgentEventService.php:342,474`). The "advisory lock single-flight" in this
card is the W13 re-expression of `onOneServer`/`withoutOverlapping` — this spike
proves the `pg_advisory_xact_lock` primitive it will rest on.

## Open: Hyperdrive→Neon leg (blocked on [TOG-9679](/TOG/issues/TOG-9679))

Needs S1's Neon staging branch (S1 acceptance #1 is itself "staging branch
serves a Hyperdrive-bound Worker query"). Runbook: `worker-probe.md`. Expectation:
(a) and (c) pass unchanged; (b) xact variant passes, session variant unreliable
by design (transaction-mode pooling) — that split is the actual verify-don't-assume result.
