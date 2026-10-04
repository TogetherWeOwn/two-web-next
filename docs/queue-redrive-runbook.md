# Queue dead-letter redrive runbook: two-web-next

Inspect-list-redrive loop over `queue_failed_jobs` for dead-letter recovery.
Companion to the [operations runbook](runbook.md#queue-containment-drain-and-failed-job-replay):
that section owns containment/drain gates; this page owns the dead-letter loop.
Transitions are proved against real SQL in `test/queue-redrive.test.ts`.

## Rules

- The worker gate in `runbook.md` applies: do not redrive real messages until
  the worker's `BOT_*` bindings are confirmed present (missing config fails jobs
  terminally). Redrive rehearsal evidence is the test file, not live replay.
- A failed row is diagnostic identity only (`id`, `job_id`, `kind`, `key`,
  `reason`, `failed_at`) — no payload, no original bot idempotency key. Never
  reconstruct an announcement/role action from a key or fabricate a key.
- Every step is one row at a time. There is no batch redrive, no blind `DELETE`,
  and no live replay command in this repo.

## The loop

1. **Inspect** — `GET /up` `queue.failed` is the backlog-independent failure
   count (probes: `test/up.test.ts`). Newest-first inspection of the same rows
   the helper reads: `SELECT id, job_id, kind, key, reason, failed_at FROM
   queue_failed_jobs ORDER BY failed_at DESC, id DESC LIMIT 100;` against
   agent-testdb / CI service only — never staging or production data for a test.
   Helper: `listFailedJobs(sql)` (newest-first, bounded, optional `kind` filter).
2. **Retry once** — for a transient failure (transport/outage class in `reason`)
   with the original authorized message source still available: re-dispatch
   through that source's producer path (`trackingQueue`), which mints a fresh
   `jobId`. The dead row stays until recovery of the new message is confirmed;
   the test pins the old `jobId` untouched while the new live row exists.
   Role assignments have no idempotency key: reconcile downstream first, or the
   retry double-applies.
3. **Discard** — after a confirmed recovery, or for poison that must never run
   again: `discardFailedJob(sql, failureId)` deletes exactly that row and
   reports `false` for an unknown id. The `/up` `failed` count drops by one per
   confirmed discard only.

Only after successful reconciliation of the re-dispatched message should its
dead row be discarded; unbounded history cleanup belongs to the separately
approved path, not this loop.
