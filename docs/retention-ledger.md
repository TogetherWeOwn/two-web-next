# Member-data retention ledger (L7 first slice)

First slice of the whole-schema retention ledger ([post-cutover-milestone.md](post-cutover-milestone.md#carried-items), L7): one row per member-data table with its retention window, prune mechanism, and proof. All decisions below already landed — this ledger publishes and pins them, changing no policy.

Pinned by `../test/retention-ledger.test.ts`. Do not change a window or mechanism here without changing the code and the test together.

| Table | Retention window | Prune mechanism | Proof |
|---|---|---|---|
| `member_data_access_logs` | 90 days (`MEMBER_ACCESS_LOG_RETENTION_DAYS = 90`) | Daily `model:prune` via `pruneModelTables`: `accessLog.pruneOlderThan(cutoff(now, 90 days))`. Age-only delete (`occurred_at < cutoff AND occurred_at < clock_timestamp() - interval '2160 hours'`); cutoff-exact rows survive. The append-only trigger (`drizzle/1018`) refuses deletes younger than 90 days by the database clock. Idempotent re-run matches nothing. | [What is retained and why](member-erasure.md#what-is-retained-and-why), `src/jobs/cron.ts`, `src/jobs/constants.ts` |
| `activity_log` | Retain indefinitely per CISO decision | No job prunes it. The table is append-only; although the database trigger permits deletion after 90 days, nothing does so — that exception stays an unused safety valve. Revisit only through the whole-schema retention ledger. | [What is retained and why](member-erasure.md#what-is-retained-and-why) |
| `web_throttle_hits` | 5-minute rolling (`THROTTLE_COUNTER_RETENTION_MINUTES = 5`) | RSVP path prunes counters older than five minutes before judging the budget (`pruneThrottle` in `src/events/rsvp.ts:208-212`: `delete from web_throttle_hits where at < clock_timestamp() - make_interval(mins => ...)`). The join admission path (`checkJoinThrottle` in `src/join/service.ts`) judges and records first, then prunes expired rows for admitted requests. Buckets age out on the next counted request anywhere on the site. | [Throttle buckets](member-erasure.md#throttle-buckets-ephemeral-self-deleting), `src/events/rsvp.ts:208-212`, `src/join/service.ts` |
| `web_sessions` | 2-hour TTL (`SESSION_TTL_SECONDS = 7200`) plus daily expiry sweep | Daily `model:prune` via `sessions.sweepExpired(now)`: deletes rows reads can no longer see (`expires_at <= now`). The TTL bounds how long a session stays readable; the sweep bounds how long after expiry the row lingers. Expiry-exact rows go; live rows stay. Idempotent. | `src/jobs/cron.ts`, `src/sessions.ts` |
| `join_attempts` | 90 days (`JOIN_ATTEMPT_RETENTION_DAYS = 90`) | Daily `model:prune` via `pruneModelTables`: `joinAttempts.pruneOlderThan(cutoff(now, 90 days))`. Age-only delete (`created_at < cutoff`); cutoff-exact rows survive. Idempotent re-run matches nothing. | `src/jobs/cron.ts`, `src/jobs/constants.ts` |

## Scope

- Ops-table rows (queue/jobs/sync-attempts/search-logs) land in a later slice.
- No policy or CISO decision changes in this slice; no retention window or prune behavior changes.
