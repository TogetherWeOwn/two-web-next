# Request correlation in Workers Logs

The HTTP middleware emits one single-line JSON `http.request` record for each
request dispatched to Hono. It runs outside the security-header middleware and
mounted routers, so redirects, denials, 404s, handled 500s and downstream response
replacements have the same log/header contract.

```json
{"event":"http.request","request_id":"0123456789abcdef-LHR","method":"GET","route":"/e/:key","status":200,"duration_ms":12.34,"colo":"LHR","error_class":null,"build_sha":"0123456789abcdef0123456789abcdef01234567","release":"0123456789abcdef0123456789abcdef01234567"}
```

## Find a request

1. Ask for the response's **`x-request-id`** and approximate time, not a cookie,
   Authorization header, OAuth callback URL or Discord identity. The header is
   a validated Cloudflare Ray ID (`cf-ray`), or a generated ULID when no valid
   Ray ID is available. Client `x-request-id` input is ignored. The generic 500
   page, the 429 rate-limit page, and the database-outage and maintenance 503
   pages show the same value as their **Support reference**, so a member can
   copy it without developer tools. The 429 and 503 JSON envelopes carry it as
   `request_id`. The join-flow recovery page shows the same value as its **Support reference**.
2. Open **Cloudflare dashboard → Workers & Pages → two-web-next → Observability**.
   Choose a time window around the report and the correct deployed Worker.
3. Search the log message for the exact ID (for example,
   `0123456789abcdef-LHR`). These console records are serialized JSON strings;
   use the message/text **contains** filter rather than assuming a custom
   `request_id` field is indexed. If the dashboard exposes the parsed key,
   `request_id` **equals** the ID is also sufficient.
4. The `http.request` record gives the method, registered route pattern,
   final status, wall-clock `duration_ms` and edge colo (`null` locally).
   Unknown URLs use `unmatched`; URL parameters and query strings are absent.
   Every structured record (`http.request`, `error.alert`, `queue.failing`)
   also carries `build_sha` and `release`: the deploy commit parsed from the
   Worker Version tag (`null` where no `version_metadata` binding exists, as
   locally), and `error_class` (the exception class on error records, `null`
   on `http.request`). Filter on `build_sha` to ask whether an error predates
   or postdates a specific deploy.
5. Search the same ID across `error.alert` and `queue.failing` records to connect
   an HTTP failure or a later queued failure with the request that produced it.
   Error alerts still mute duplicate exception-class/route fingerprints for
   five minutes per isolate. A muted alert does not suppress the request log.

Queue payloads carry an optional `requestId`; request-produced jobs preserve it
through retries and terminal failure alerts. Old messages and scheduled jobs
may have no originating HTTP request ID. Do not interpret a missing ID as a
successful job. The W8 event-sync carrier and W13 queue-ledger carrier both
propagate it; it is not a deduplication key and does not change job execution.

## Sync-event retry-cause diagnostics

The queue consumer emits one `sync retry classified` warning per
delivery at the retryable refusal/transport boundary, before the retry deadline
is persisted (`src/jobs/consumer.ts`, via `projectSyncRetryDiagnostic` in
`src/jobs/sync-retry-diagnostic.ts`). The same narrow projection is retained
through retry-result persistence failure into the terminal `queue.failing`
source alert; see [request-log queries](#find-a-request) for correlation and
the [alert runbook](runbook-alerts.md#sync-event-retry-cause-diagnostics) for
the paging side. These fields describe only the current delivery: they do not
control retries (the bot's `retryable` flag and backoff still decide), and a
waiting or already-exhausted claim carries no new observation.

| Field | Meaning and safe values |
| --- | --- |
| `sync_retry_class` | `BotFailure` (a retryable bot refusal), `BotTransportError` (no usable bot result), or constant `unknown` for malformed diagnostic input |
| `sync_retry_code` | Refusals only (`BotFailure`); every other/missing/malformed code becomes `unknown` |
| `queue_carrier_attempts` | Positive integer delivery attempts of the current queue message |
| `sync_request_attempts` | Nonnegative integer durable claims from `claimSync`; counts claims, not completed sends |
| `sync_snapshot_age_at_claim_seconds` | Whole seconds from the snapshot's `mirroredAt` to this delivery's claim clock; unavailable, invalid or future times are omitted |

Documented cause set: `discord_unavailable`, `in_progress`, `internal`, `rate_limited`, `unknown`, `upstream_timeout`.

| Cause (`sync_retry_code`) | Meaning |
| --- | --- |
| `in_progress` | The bot reports the operation is already in progress (409 with a retryable answer); another attempt for the same logical operation is underway |
| `rate_limited` | The bot or Discord rate-limited the call (429); a usable Retry-After above 0 sets the wait (fractions round up, values above 86400 cap at 86400), and an absent, zero or unusable value uses the attempt's backoff |
| `internal` | The bot reported a retryable internal error |
| `discord_unavailable` | The bot surfaced Discord-side unavailability |
| `upstream_timeout` | The bot's upstream call timed out |
| `unknown` | Any other, missing or malformed code. Transport errors (`BotTransportError`) never carry a code. Behavior is unchanged: the `retryable` flag still decides |

A new cause value added to `SyncRetryCode` must be documented in the tables
above and in the refusal list in `runbook-alerts.md`;
`test/sync-retry-cause-docs.test.ts` fails CI until both are.

No event payload, request body, bot response body, provider error message,
token, secret, key material, member/event identity or raw key is logged or
copied into this projection. Only own data properties are sampled; accessors
are never invoked. The Tail Worker does not forward these fields.

### Tally retry causes in Workers telemetry

```sh
# Live stream of classified retries (authorized Cloudflare access required).
# The queue consumer runs on two-web-jobs after the handoff: `sync retry
# classified` is emitted there (src/jobs/consumer.ts), not on two-web-next.
npx wrangler tail two-web-jobs --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | contains("sync retry classified"))'

# Count occurrences per cause over a saved tail file
jq -c '.logs[]? | select(any(.message[]?; . == "sync retry classified")) | .message[]? | select(type == "object")' \
  deliveries.json | grep -o '"sync_retry_code":"[a-z_]*"' | sort | uniq -c

# Same tally grouped by class
jq -c '.logs[]? | select(any(.message[]?; . == "sync retry classified")) | .message[]? | select(type == "object")' \
  deliveries.json | grep -o '"sync_retry_class":"[A-Za-z]*"' | sort | uniq -c
```

In the dashboard (**Workers & Pages → two-web-jobs → Observability**), filter
the message/text with `sync retry classified` over the incident window and
group by `sync_retry_code` (refusals) or `sync_retry_class`. These receipts
count occurrences, not distinct durable requests, and cannot reconstruct the
causes of earlier exhausted deliveries.

## Failure log lines

These `console.error` lines mean a request or job hit a failure path. Each row
gives the exact message, what it means, whether the request fails closed,
degrades or only logs, the first read-only check, and the fields the line
carries. Find a line with the message **contains** filter from
[Find a request](#find-a-request). Where a line carries an exception, it is the
class name only, never the raw error text, which can hold SQL bindings, tokens
or personal data. A line that carries a reason instead says so in its row.
Read-only checks only: a Workers Logs search, a `SELECT`, or a source file.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Member read audit failed; refusing contents.` | The member-read audit write failed or reported no row written (`src/member-reads.ts`). | Fails closed: the contents are refused with the unavailable response. | Search logs for the line and the matching `http.request` status; then `SELECT count(*) FROM member_data_access_logs` over the same window to see whether writes resumed. | `exception` (class name), validated `request_id` |
| `Member data access could not be recorded; refusing to serve the read.` | The access-log write failed after a handler declared a member-data read (`src/access-log.ts`). | Fails closed with the database-unavailable response unless `MEMBER_ACCESS_LOG_ENFORCE` is `false`, `0` or `no`; then it only logs. | Search logs for the `route` value; then `SELECT count(*) FROM member_data_access_logs` over the same window. | `route`, `exception` (class name) |
| `admin guard could not resolve the session; refusing.` | The admin session lookup threw (`src/admin/guard.ts`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status on `/admin` routes; then check database health with the [alert runbook](runbook-alerts.md). | `exception` (error name) |
| `event write-back enqueue failed; reconcile will re-dispatch` | Sending the event write-back to the sync queue threw (`src/events/sync.ts`). The request itself already succeeded. | Degrades: the write-back is late until reconcile re-dispatches it. | Search logs for the `eventKey` and `request_id`; then join through `events` (`event_sync_attempts` carries `event_id`, not `event_key`): `SELECT * FROM event_sync_attempts JOIN events ON events.id = event_sync_attempts.event_id WHERE events.event_key = '<eventKey>'` to see whether a later attempt landed. | `eventKey`, `exception` (error name), `request_id` |
| `services.discord.invite_url is unusable; serving the hardcoded fallback invite.` | The configured invite URL is not an `https` `discord.gg` or `discord.com/invite` link (`src/invite.ts`). | Degrades: visitors get the hardcoded invite, which may be a rotation old. | Read the `services.discord.invite_url` setting in the deployed config and compare it with the validator in `src/invite.ts`. | None |
| `agent-events failed` | The agent-events ingress threw before or while handling a request (`src/agent-events/route.ts`, two call sites). | Fails closed: 503 `ingress_unavailable` for a database outage, otherwise 500 `internal_error`. | Search logs for the matching `http.request` status on the agent-events route; then `SELECT * FROM agent_event_audits` for the window. Shield 429 rows are a ~1% sample (multiply by ~100; the latest `agent-events.shield.refusal_sampled` warn carries the running per-class count) and grantless 401s write no rows, so an audit count undercounts refusals. | Error name as the second argument |
| `sync retry result persistence failed` | A known sync-retry result could not be committed (`src/jobs/consumer.ts`), so the durable claim stays fenced. | Degrades: the delivery is retried after the known wait, or marked failed once tries run out. | Search logs for `sync retry classified` and `queue.failing` for the same event; see [sync-event retry-cause diagnostics](#sync-event-retry-cause-diagnostics). | Fixed reason string `sync retry result could not be persisted; request remains fenced` |
| `sync attempt settlement failed` | A definitive sync refusal could not be settled via `failSync` (`src/jobs/consumer.ts`), so the `event_sync_attempts` row stays `pending` and still blocks future revisions. | This delivery retries released-only. A redelivery carrying terminal intent re-runs settlement with backoff; past the carrier budget each unsettled redelivery raises the distinct `queue.failing` line (`terminal settlement unavailable; ...`), still without a `failed` stamp or ack, until the transport backstop drops the carrier and the pending row waits for operator recovery. A redelivery with no recorded intent waits on the nulled claim until the carrier exhausts with `job failed` / `queue.failing` reason `waiting carrier exhausted; request remains recoverable`; the refusal stays unrecorded and newer revisions stay blocked. | Search logs for the line (it carries no event key, only `exception`); then list null-fenced pending rows: `SELECT e.event_key, a.request_attempts, a.next_attempt_at FROM event_sync_attempts a JOIN events e ON e.id = a.event_id WHERE a.state = 'pending' AND a.next_attempt_at IS NULL`. See the operator-recovery paragraph in docs/runbook.md: no live reset or blind replay. | `exception` (class name) |
| `sync terminal intent failed` | The terminal-intent note (`terminal_reason`) for a definitive sync refusal could not be committed (`src/jobs/consumer.ts`); the claim reopens to a due deadline and settlement still runs on this delivery. | Degrades: a healed redelivery re-derives the verdict and re-notes; only a still-wedged store keeps the row unsettled on backoff retry. | Search logs for the line (it carries no event key, only `exception`); then list pending rows carrying intent: `SELECT e.event_key, a.request_attempts, a.terminal_reason FROM event_sync_attempts a JOIN events e ON e.id = a.event_id WHERE a.state = 'pending' AND a.terminal_reason IS NOT NULL`. | `exception` (class name) |
| `job threw` | A queue job threw something that is not a bot transport error, a terminal error or a refusal (`src/jobs/consumer.ts`). | Retries until the job runs out of tries, then it is buried and a `queue.failing` alert fires. | Search logs for `queue.failing` with the same job kind; then `SELECT * FROM queue_failed_jobs` for that kind. | Job `kind`, `exception` (class name) |
| `job failed` | A job returned a failed outcome (`src/jobs/consumer.ts`), and a `queue.failing` alert follows. | Terminal for that job; the ledger row is marked failed. | Search logs for `queue.failing` with the same job kind; then `SELECT * FROM queue_failed_jobs` for that kind. | Job `kind`, then the bounded failure reason (a stable code or class name, not raw error text) |
| `Member request failed; refusing contents.` | An unhandled error reached the shared error handler while a member read was active (`src/error-responses.tsx`). | Fails closed with a 503 "Member data is temporarily unavailable." body. | Search logs for the matching `http.request` record and its route. | `exception` (class name), validated `request_id` |
| `Profile request failed; refusing contents.` | An unhandled error reached the profiles router error handler (`src/profiles/routes-gate.ts`). | Fails closed: database-unavailable response for an outage, otherwise a 503 member text. | Search logs for the matching `http.request` record on a `/members` route. | `exception` (class name), validated `request_id` |
| `profiles could not resolve the session; refusing.` | The profiles session lookup threw (`src/profiles/routes-gate.ts`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `draft ICS could not resolve the session; refusing.` | The draft ICS session rotation threw (`src/events/routes-feeds.ts`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status on the `.ics` route; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `events calendar could not resolve the session; refusing.` | The events calendar session rotation threw (`src/events/routes-calendar.tsx`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status on `/events`; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `profile save failed` | Saving a validated profile threw (`src/profiles/routes-writes.tsx`). | Fails closed: database-unavailable response for an outage, otherwise 500 "Could not save your profile." | Search logs for the matching `http.request` status on the profile save route; then `SELECT updated_at FROM profiles` for that member. | `exception` (class name), validated `request_id` |

### Queue ledger, lock and malformed-carrier warnings

These `console.warn` lines come from the queue consumer
(`src/jobs/consumer.ts`). None pages: ledger and lock cleanup are
best-effort and bounded so they never hold the batch open, and a malformed
carrier is discarded without trusting any of its fields. Each row gives the
exact message, what it means, why it does not page, and the first read-only
check. Find a line with the message **contains** filter from
[Find a request](#find-a-request). Read-only checks only: a Workers Logs
search, a `GET /up` read, or a `SELECT`. Never replay a message, insert or
delete a ledger row, clear a lock, or reset a sync claim to investigate.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `queue malformed message discarded` | The carrier matched neither envelope shape, so `toQueueMessage` returned null (`src/jobs/envelope.ts:65-83`, dropped at `src/jobs/consumer.ts:86-92`): an unknown `kind`, a wrong-type or missing required key (non-string `jobId`, non-UUID `leaseToken`, a string `role-assign` key, a non-string announcement body; `src/jobs/envelope.ts:11-48`), or a W8 write-back with the wrong `action`, a missing `eventKey`/`idempotencyKey`, or `dedupeKey` not equal to `eventKey`. Ack-and-drop for this message only; the rest of the batch still runs. Member impact for a sync-event or W8 carrier: one sync write-back lost for that carrier only; a dirty revision stays dirty until reconcile re-dispatches it on its schedule. An announcement or `role-assign` discard (both run on `two-internal-action`, `src/jobs/consumer.ts:37-48`) has no reconcile backstop: that payload is lost permanently (reconcile redispatches sync events only, `src/jobs/cron.ts:71,110`). | No page. This path never fires `queue.failing` and never touches the ledger or lock. Escalation boundary: for a sync-event carrier, a lone discard with a flat stale count is a poison carrier, nothing to fix; a burst or a growing stale count after a deploy points at a producer bug, route to the owning team with the window and counts. Internal-action discards leave the stale count flat by construction, so a flat count alone does not clear those kinds. | Filter Workers Logs message/text with the exact line on the consumer Worker over the incident window (staging `two-web-jobs`, production `two-web-next-production`) and tally sightings; confirm no `queue.failing` follows in the window. Then trend the `staleEventKeys` count across reconcile passes (`*/10 * * * *`), mirroring the clock-free stale predicate (`src/jobs/events.ts:109-199`; tries = 6, `src/jobs/constants.ts:6-11`). The scheduled pass also drops not-yet-due retries before LIMIT using the scheduler clock, so this count includes sleeping retries the current pass will not dispatch: `SELECT count(*) FROM events e WHERE EXISTS (SELECT 1 FROM event_sync_attempts p WHERE p.event_id = e.id AND p.state = 'pending' AND p.request_attempts > 0 AND p.request_attempts < 6 AND p.next_attempt_at IS NOT NULL) OR (e.status IN ('published', 'cancelled') AND NOT EXISTS (SELECT 1 FROM event_sync_attempts r WHERE r.event_id = e.id AND r.revision = e.sync_revision AND r.state = 'failed') AND NOT EXISTS (SELECT 1 FROM event_sync_attempts b WHERE b.event_id = e.id AND b.state = 'pending' AND (b.request_attempts >= 6 OR b.next_attempt_at IS NULL)) AND (e.sync_revision > e.synced_revision OR (e.status = 'published' AND (e.discord_event_id IS NULL OR EXISTS (SELECT 1 FROM rsvps s WHERE s.event_id = e.id AND s.synced_to_discord_at IS NULL)))))`. A count that drains on later passes recovered; a count that grows points at the producer. There is nothing to replay: the payload was never recorded. Never replay a message to investigate. | None (message only): no `requestId`, event key, `kind`, queue, or exception, so correlate by time window plus revision state, not by a request key; the line cannot tell a sync-event discard from an internal-action one |
| `queue ledger <op> failed` | A best-effort ledger transition failed or hit the 2 s bound (`src/jobs/consumer.ts:103`). `<op>` is one of `reserved`, `released`, `dequeued`, `failed`. Job processing continues; the terminal ack or retry still lands. | No page. A stale ledger row is a visible backlog, not a silent loss. | Read `GET /up` (`queue.status`, `pending`, `oldest_ready_wait_age_seconds`, `ready_wait_severity`; `pending >= 20` is `degraded`) per [Read `/up` without mistaking liveness for readiness](runbook.md#read-up-without-mistaking-liveness-for-readiness); then `SELECT job_id, kind, key, available_at, reserved_at, created_at FROM queue_jobs ORDER BY created_at, job_id LIMIT 100`. Never insert or delete a ledger row to investigate. | `exception` (class name only, never the message, which can carry SQL bindings or secrets) |
| `queue lock release timed out` | The lock `release` hung past the 2 s bound (`src/jobs/consumer.ts:127`). The terminal ack still lands and the rest of the batch still runs. | No page. A stuck lock row self-heals via its TTL (`job_unique_locks.expires_at`; reads treat expired rows as gone). | Search logs for the line; then `SELECT key, expires_at, expires_at > clock_timestamp() AS still_live FROM job_unique_locks ORDER BY expires_at, key LIMIT 100`: `still_live = false` already self-healed. Never delete rows by age or clear locks as a workaround ([Queue containment](runbook.md#queue-containment-drain-and-failed-job-replay)). | Sanitized lock scope (single-line, bounded; a hostile event key cannot split the log line) |
| `queue lock release failed` | The lock `release` rejected (`src/jobs/consumer.ts:134`). Same handling as the timeout: the ack lands, the batch continues, the TTL heals. | No page: TTL self-heal, same as the timeout row. | Same lock-table `SELECT` as the timeout row; a live row expires on its own. Same never-delete rule. | Sanitized lock scope plus `exception` (class name only) |
| `sync successor dispatch timed out; reconcile will retry` | The post-ack successor check and dispatch hit the 2 s bound and aborted (`src/jobs/consumer.ts:387`). The lock was already released; a rejected or timed-out send still leaves the dirty revision for reconciliation. | No page. Reconcile re-dispatches stale revisions every 10 minutes (`*/10 * * * *`). | Search logs for the line; then check whether a later sync landed: `SELECT sync_revision, synced_revision, discord_event_id FROM events WHERE event_key = '<eventKey>'` (`synced_revision` catching up to `sync_revision` means reconcile recovered it). Never replay a sync to investigate. | None (message only) |
| `sync successor dispatch failed; reconcile will retry` | The successor dispatch threw and was caught (`src/jobs/consumer.ts:399`). Same backstop as the timeout: the dirty revision stays for reconcile. | No page: same 10-minute reconcile backstop. | Same revision `SELECT` as the timeout row. Never replay a sync to investigate. | `exception` (class name only, never the message, which can carry SQL or connection secrets) |
| `sync terminal claim reopen timed out` | The best-effort claim reopen to a due deadline after a failed terminal-intent note hit the 2 s bound (`reopenTerminalClaim` in `src/jobs/consumer.ts:204-227`, warn at `:208`, `LEDGER_TIMEOUT_MS = 2000` at `:13`): without a due deadline a healed redelivery would wait on the nulled claim, so a healed redelivery re-runs the bot flow, re-derives the verdict and re-notes instead. | No page. Warn only; settlement still runs on this delivery (the settlement race at `:367` runs unchanged after the reopen). | Filter the jobs-Worker logs (**Workers & Pages → two-web-jobs → Observability**) for the line; then list pending rows by `next_attempt_at` null-vs-due: `SELECT e.event_key, a.request_attempts, a.next_attempt_at FROM event_sync_attempts a JOIN events e ON e.id = a.event_id WHERE a.state = 'pending' ORDER BY a.next_attempt_at NULLS FIRST LIMIT 100` (`NULL` = still on the nulled claim; due = reopened and eligible for redelivery). Never reset a sync claim to investigate. | None (message only) |
| `sync terminal claim reopen failed` | The same best-effort reopen rejected (`src/jobs/consumer.ts:220`): the pending lookup or the defer-to-due write threw. Same handling as the timeout: the settlement race still runs this delivery. | No page: same as the timeout row. | Same pending-row `SELECT` as the timeout row. Same never-reset rule. | `exception` (class name only, never the message, which can carry SQL or connection secrets) |

### Shield sampling and pre-auth refusal warns

Docs-only: this section triages two existing `console.warn` lines. No
behavior, sampler-rate or audit change, and no new logged field.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `agent-events.shield.refusal_sampled` | An over-budget outer-shield 429 refusal was sampled (`src/agent-events/shield.ts:120`). Both the audit row and this warn fire on the same ~1% sample (`SHIELD_REFUSAL_AUDIT_RATE = 0.01`): to estimate true refusals, multiply sampled warns (or sampled `shield:credential` / `shield:anonymous` audit rows) by ~100. The latest warn's `refusals` value is the exact running per-class count for the emitting isolate only (process-local, resets on restart, not Worker-wide); estimate window totals by multiplying sampled warns/rows by ~100. | Warn only: no page. A 429 here is the shield doing its job, not an outage. | Filter logs message/text with `agent-events.shield.refusal_sampled` over the window and split by `bucket_class`; then `SELECT operation, payload_digest, count(*) FROM agent_event_audits WHERE created_at > now() - interval '1 hour' AND operation LIKE 'shield:%' GROUP BY operation, payload_digest`. One `shield:credential` digest recurring with a steadily climbing `refusals` counter within a single isolate's warns points at a misconfigured client looping over budget (route to the credential owner to slow its loop); many distinct credential digests point at spray. `shield:anonymous` rows always store a null digest by design, so grouping yields a single row that cannot attribute source: read anonymous spray vs single client from `bucket_class` volume and `http.request` 429s only. Correlate with `http.request` 429 volume on `POST /api/agent-events`. | `bucket_class` (`credential` or `anonymous`), running per-class `refusals`, server-minted `request_id`. Never raw identity. |
| `agent-events.ingress.pre_auth_refusal` | A pre-auth refusal was sampled (`src/agent-events/ingress.ts:40`): an overlong bearer (> 512 chars), a missing/unknown grant 401, or a grantless control-byte 422. The warn fires on a ~1% sample (`PRE_AUTH_REFUSAL_WARN_RATE = 0.01`): multiply warns by ~100 to estimate true refusals. Grantless refusals write zero audit rows by contract, so an audit count undercounts them to zero. | Warn only: no page. A 401/422 here is the ingress refusing before auth, not an outage. | Filter logs message/text with `agent-events.ingress.pre_auth_refusal` over the window; then compare against `http.request` 401/422 volume on `POST /api/agent-events` for the same window and confirm `SELECT count(*) FROM agent_event_audits WHERE request_id = '<request_id from the sampled warn>'` shows zero rows (zero is expected for these refusals, not a gap). A steady low-rate warn stream with matching 401s and zero matching audit rows points at a misconfigured client (unknown or rotated credential, overlong bearer; route to the provisioning owner, never replay or log the bearer); a burst of warns with a 401/422 spike points at spray. Overlong bearers are never demoted to the anonymous shield bucket, so a rotation flood mints no shield rows. | Server-minted `request_id` only. Never credential, body, operation, key, or anything else the caller chose. |

What the sampling deliberately hides, and why: 99 of 100 refusals leave
no warn and (for pre-auth) no audit row at all, so per-hit granularity is
gone by design; the warn carries only the bucket class (shield) or nothing
but the server-minted `request_id` (pre-auth), and the sampled audit row
carries only the bucket class with a credential sha256 (or null for
anonymous), never the raw bearer, body, operation, key, event key, or IP
bytes. Refusals are attacker-proportional volume, so exact logging would let
a flood dictate log and table growth. The sample is deliberately
probabilistic (`Math.random() < 0.01`), not a token bucket, so a flood of
distinct unknown credentials or buckets cannot spend a shared allowance to
blind the sink. Lock-contention 503s keep their exact error audit because a
contention burst is a retryable load signal, not attacker volume.

### `/up` degrade warnings

These five `console.warn` lines come from the `/up` readiness path (the
route in `src/index.tsx`, plus `src/up-queue.ts`, `src/up-database.ts` and
`src/up-config.ts`). None pages on its own: the queue-only `unknown` still
answers HTTP 200, and each 503 feeds the existing
[`uptime.down`](runbook-alerts.md#scheduled-up-prober-uptimedown) prober
rather than a new page. Each row gives the exact message, what it means, why
it does not page, and the first read-only check, including what the degraded
`/up` body still proves. Find a line with the message **contains** filter
from [Find a request](#find-a-request). Read-only checks only: a Workers
Logs search, a `GET /up` read, a `SELECT`, or a source or deployed-config
read. Never set a secret, run or repair migrations, replay a sync, or
substitute another backend or credential to investigate.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Health check could not build the database client.` | The `postgres()` client constructor threw synchronously (`src/index.tsx:664`), so neither the DB/schema read nor the queue-ledger read started. | No page. The 503 feeds the existing `uptime.down` prober (red for over two minutes); the warn adds no new paging. | Read `GET /up` per [Read `/up` without mistaking liveness for readiness](runbook.md#read-up-without-mistaking-liveness-for-readiness): expect HTTP 503 with `db: error`, `pending_migrations: null` and `queue.status: unknown` with `detail: "queue ledger is not configured."` That triple proves the route served but neither store was read; the `config` and `revision` slices stay valid. Route the unreachable or malformed selection (`DATABASE_URL`, else `DB.connectionString`) to the Operator. Never substitute another backend or credential. | `exception` (class name only) |
| `Health check could not read the queue depth; reporting unknown.` | The ledger measure threw or hit the response deadline (`src/up-queue.ts:75`); the failure is reported as `unknown`, never thrown to the route. | No page. Queue-only `unknown` still answers HTTP 200 when DB/schema is ready, so the prober does not fire; backlog visibility is reduced, not lost, and ledger rows are unchanged. | Read `GET /up`: `queue.status: unknown` with all seven measurements `null`, `ready_wait_severity: unknown` and `detail: null` still proves `db: ok` with `pending_migrations: 0` and the `config` slice when present; then `SELECT job_id, kind, key, available_at, reserved_at, created_at FROM queue_jobs ORDER BY created_at, job_id LIMIT 100`. Never insert or delete a ledger row to investigate. | `exception` (class name only, never the message: the queue tables carry job payloads and the endpoint must not leak one into a log) |
| `Health check could not establish database/schema readiness.` | The DB ping or the migration-ledger read threw or hit its deadline (`src/up-database.ts:67`). `db` reads `ok` when the ping passed but the ledger failed, else `error`; `pending_migrations` is `null` either way. | No page on the line itself. The 503 feeds the existing `uptime.down` prober. | Read `GET /up`: `db` plus `pending_migrations: null` with a still-measured `queue.status` proves the queue slice survived and only the DB/schema half failed; then check database health with the [alert runbook](runbook-alerts.md). Never run or repair migrations through `/up`. | `exception` (class name only) |
| `Health check found SESSION_SECRET too weak: it must be at least 32 characters with no leading or trailing whitespace.` | `SESSION_SECRET` is configured but fails the documented strength floor (`src/up-config.ts:44`): under 32 characters or with leading or trailing whitespace. A weak session key takes precedence over a missing Discord secret, so fixing it can surface `config: "missing"` next. | No page on the line itself. The 503 with `config: "weak"` feeds the existing prober. | Read `GET /up`: `config: "weak"` with measured `db` and `queue` slices proves the stores are healthy and only the secret fails; then read the floor in [`SESSION_SECRET` strength and rotation](config.md#session_secret-strength-and-rotation). Route the fix to the Operator (`wrangler secret put` on the target); never weaken the probe. | `secret: "SESSION_SECRET"` plus the requirement text, never the value |
| `Health check found required Worker secrets missing.` | One or more required secrets is absent, empty or whitespace-only (`src/up-config.ts:52`). The body answers 503 with `config: "missing"` and never names which secret. | No page on the line itself. The 503 feeds the existing prober. | Read `GET /up`: `config: "missing"` with measured `db` and `queue` slices proves the stores are healthy; only these names are safe to list from the log line, never values: `SESSION_SECRET`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`. Route the fix to the Operator under [Deploy and record the rollback pointer](runbook.md#deploy-and-record-the-rollback-pointer); never echo a value. | `missing` (secret names only, never values) |

### Sync-settlement and reconcile warnings

The warnings below cover EventStore operations, the sync successor-settlement
path and scheduled reconcile/prune passes (`src/jobs/events.ts`,
`src/jobs/worker.ts`, `src/jobs/ledger.ts`, `src/jobs/cron.ts`). None pages by
itself: pager signals come from the existing `queue.failing` or
`scheduled.failing` paths in the
[alert runbook](runbook-alerts.md#source-lines), never from these lines.
Read-only checks only: a Workers Logs search on the jobs Worker
(`two-web-jobs`), a `SELECT`, or a source file. Never re-dispatch,
replay a sync, or reset a claim to investigate. The post-ack successor
dispatch pair (`sync successor dispatch timed out; reconcile will retry` and
`sync successor dispatch failed; reconcile will retry`,
`src/jobs/consumer.ts:387,399`) is triaged under
[Queue ledger, lock and malformed-carrier warnings](#queue-ledger-lock-and-malformed-carrier-warnings):
reconcile owns recovery for both; never manually re-dispatch or replay.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `sync successor settlement lifetime expired; unsettled ledger rows remain tracked` | The `waitUntil` successor-settlement extension (`successorLifetime` in `src/jobs/worker.ts:80`) hit its 30 s bound before the after-ACK successor work (dispatch plus exact-`jobId` ledger compensation on fresh pools) settled. Late work may still complete; a row is never deleted merely for being unsettled. | Warn only; no pager. | Filter the jobs Worker logs for the line over the window (it carries no `jobId`); then `SELECT job_id, kind FROM queue_jobs` to confirm tracked rows versus drained. | None (message only) |
| `sync store operation failed` | A bounded `prepareSync`, `claimSync`, `completeSync`, `deferSync` or `pendingSync` operation rejected (`src/jobs/events.ts`). Both database lock and statement waits are capped at 2 seconds, transaction-locally. The error still propagates to the caller; the warning alone does not prove a timeout or a retry. | Warn only; no page from this line. Existing queue/reconcile disposition and exhaustion rules still apply. | Filter jobs Worker logs for this line and the adjacent class-only job/reconcile diagnostic; read `GET /up` for live queue depth. Never reset a claim, replay a sync or substitute a credential to investigate. | `exception` (bounded class name only; never SQL, parameters, connection details or the driver message) |
| `queue ledger compensation failed` | The `trackingQueue` send path (`src/jobs/ledger.ts:46`) threw (the ledger `enqueued` write failed, the send was rejected or cancelled, or the signal aborted) and the exact-`jobId` compensation (`dequeued`) also threw. The original error still propagates to the dispatcher; a committed row hidden behind a lost INSERT response stays visible as backlog, and a later reconciliation cannot remove it. | Warn only; no pager. | Filter logs for the line and its `jobId`; then `SELECT * FROM queue_jobs WHERE job_id = '<jobId>'` to see whether the phantom row remains. | Two positional arguments after the message, not object keys: `jobId` (the canonical UUIDv4 minted for the ledger row), then the exception class name (`e.constructor.name`, or `typeof` for non-errors) |
| `Event reconcile key failed.` | One stale key's `pendingSync`/dispatch threw inside `reconcileEvents` (`src/jobs/cron.ts:119`); it counts as `failed` without starving the rest of the pass, and the first error is kept for the total-outage rethrow (a multi-key pass with only failures rethrows). | Warn only per key; no page from this line. A resolved partial pass pages once after the flight commits via `ReconcilePartialFailureError`, and an all-failed multi-key pass rethrows its real class: see [`scheduled.failing`](runbook-alerts.md#source-lines). | Filter the jobs Worker logs for the line and its `key`. If the pass emits `Event reconcile pass completed.`, read its counts (`failed` above 0 with `resynced`/`absorbed` preserved). Otherwise, inspect the corresponding `scheduled.failing` entry and rethrow class. | `key` (the stale event key being redispatched), `error_class` (exception class via `exceptionClass`; driver messages, which can echo bound values, are never logged) |
| `Model prune pass hit per-table batch cap with rows possibly pending.` | The `job_unique_locks` expiry sweep (`src/jobs/cron.ts:370`) hit the per-pass batch ceiling with a full final batch, so rows may still be pending. This warn fires only for the lock table; other-table caps stay warn-free per the paging contract. The pass still returns its counts and never throws on a cap hit. | Warn only; no page from this line. A cap-only pass pages once after the flight commits via `PruneBatchCapError`; a co-occurring table failure pages with its own class instead: see [`scheduled.failing`](runbook-alerts.md#source-lines). | Check the next prune pass's warn and carried counts. A capped pass does not emit `Model prune pass completed.`; if that line appears, the pass was uncapped and deleted rows. Consecutive warnings mean the lock-table sweep remains capped; they do not distinguish a pre-existing backlog from new inflow. The carried counts are rows deleted during that pass, not the remaining backlog. | Eight per-table totals (`agentEventAudits`, `accessLog`, `joinAttempts`, `idempotencyKeys`, `searchLog`, `boardViews`, `sessions`, `jobUniqueLocks`) plus `cappedTables` |

None of these fields is PII-adjacent: `key` is the sync event key being
redispatched (never a member identity), `jobId` is a random UUIDv4 minted
for the ledger row, and `exception`/`error_class` are bounded class names,
never messages, SQL text, tokens, Discord IDs or payload bodies.

### Moderator-recompute, trust-host and session-fallback warnings

Four `console.warn` lines stay narrow on purpose. Each row gives the exact
message, what it means, the severity (none pages), the first read-only check,
the exact fields the line carries, and why the projection stays narrow. Find a
line with the message **contains** filter from
[Find a request](#find-a-request). Read-only checks only: a Workers Logs
search, a `SELECT`, or a source file.

| Message | Meaning | Severity | First read-only check | Fields carried | Why fields stay narrow |
| --- | --- | --- | --- | --- | --- |
| `moderator recompute lookup failed` | The Discord member-role lookup answered non-OK other than 404 (`src/roles.ts:47` via `fetchMemberRoles`). The lookup returns null so the flag stays non-moderator; sign-in continues. | Degrades to non-moderator; does not page. | Filter Workers Logs for the message and `guild_id`, then split by `status` (a 429 or 5xx points at Discord or wire health; a 401 or 403 points at the bot credential configuration); then read `src/roles.ts` to confirm the non-OK branch. | `status`, `guild_id` | Non-moderator degrade: carries the guild scope and HTTP status only, never the member user ID, role list, or bot credential. A 404 returns the same non-moderator result silently with no line. |
| `moderator recompute lookup returned non-JSON` | Discord answered with a non-JSON edge body (`src/roles.ts:55`). Treated as a failed lookup, not a crash; the flag stays non-moderator and sign-in continues. | Degrades to non-moderator; does not page. | Filter Workers Logs for the message and `guild_id` over the window; then read `src/roles.ts` to confirm the non-JSON branch. | `guild_id` | Non-moderator degrade: same narrow projection as the row above; no member identity or credential is logged. |
| `refusing request with untrusted host` | The request Host or URL host did not match the `APP_URL` trusted hostname, or the request URL failed to parse (`src/trust-hosts.ts:82`; an unparseable URL leaves `urlHost` null at `:77-80`, refused even with a trusted Host header). Refused before routing with the branded DB-free 404. | Refuses with 404; does not page (expected under probing). | Filter Workers Logs for the message and the matching `http.request` 404; then read `src/trust-hosts.ts` and compare the deployed `APP_URL` hostname. | None (message only) | 404-masking: carries no fields and never echoes the refused host or URL, so probes learn nothing beyond the branded 404; the refusal carries no-store, private. |
| `Home session unavailable; serving as guest.` | The homepage session read or rotation failed with a classified database outage, a plain `Error` from the pre-rotation session-store read, or a normalized rotation error (`src/index.tsx:486`). The homepage serves as guest with the session-unavailable treatment; the funnel stays up. | Degrades to guest; does not page. | Filter Workers Logs for the message on `/`; then `SELECT count(*) FROM web_sessions` to confirm the table is readable, and check database health with the [alert runbook](runbook-alerts.md). A revoked or expired row returns null guest without this line. | `exception` (constant `SessionReadFailure` only) | Privacy fail-closed: carries a fixed diagnostic only, never the driver message, which can hold DSN fragments or session identifiers, and never a token or row. |

### Join journey warnings

Two `console.warn` lines are join-scoped (the attempt write in
`src/join/service.ts`, the token-exchange line in
`src/join/route-callback.ts`); the third comes from the shared throttle
helper `checkJoinThrottle` in `src/join/service.ts`. None pages: the prune
and the attempt write are best-effort work that never changes the member's
outcome, and the token-exchange line always accompanies a recovery page the
member already sees. Promoting the attempt-write failure to `error.alert`
was considered and rejected: the request itself succeeded, so a page would
alarm on an analytics gap. The attempt-write and token-exchange lines carry
`request_id` only when it passes validation. The prune line carries neither
a request ID nor a route field, so correlate that line by time window.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Join throttle prune failed; keeping the decided verdict.` | The best-effort expiry delete on `web_throttle_hits` threw, or was still pending after its 2 s wait, after the admit/refuse verdict was already decided (`checkJoinThrottle` in `src/join/service.ts`). A transaction-local 2 s statement timeout cancels a slow `DELETE` in Postgres, independently of the caller timer. Shared helper: the same line fires for join, login, events reads, profile writes and every other throttled POST (via `throttleGuard` in `src/throttle.ts` and profile-write admission in `src/profiles/routes-admission.ts`), so a sighting is not evidence of join traffic. An expired wait logs once with `exception: ThrottlePruneDeadline`; late settlements cause no second warning. | None on this request. Expired rows wait for a later pass; every request retries one bounded 1,000-row skip-locked batch. | `SELECT count(*) FROM web_throttle_hits WHERE at < now() - make_interval(mins => 5)` across passes: a spike that drains is healthy; a count that grows pass over pass points at database write/lock health (see the [alert runbook](runbook-alerts.md)). Correlate by time window across all throttled routes, not just `/join/callback`. A burst of `ThrottlePruneDeadline` means database writes are stalling. | `exception` (class name only, never the message, which can quote statement bindings; `ThrottlePruneDeadline` on an expired wait) |
| `join attempt write failed` | The `join_attempts` analytics transaction threw, or was still pending after its 2 s caller wait. The row may be missing; the request outcome stands (`recordAttempt` in `src/join/service.ts`). A transaction-local 2 s statement timeout cancels a slow `INSERT` in Postgres, independently of the caller timer. A connection/transport stall can still let a row land late. An expired caller wait logs once with `exception: AnalyticsWriteDeadline`; late settlements cause no replay or second warning. | No change to the journey outcome. Analytics adds at most 2 s of waiting; other callback work has its own latency. The gap shows only in `join_attempts` counts. | `SELECT outcome, count(*), max(created_at) FROM join_attempts WHERE created_at > now() - interval '1 hour' GROUP BY outcome`, then compare against `http.request` volume on `/join/callback` for the same window; a gap inside one window matches the warn timestamps. A burst of `AnalyticsWriteDeadline` means database writes are stalling, not that Discord is down. If writes never resume, route database insert health to the authorized operator. Never replay a member join to investigate. | `exception` (class name only, never the message, which can quote the live token or statement text), `outcome`, `request_id` (only when it passes validation) |
| `discord token exchange failed on the join journey` | One bounded line for three triggers in `src/join/route-callback.ts`: oversized code/state refused before throttle spend or any exchange, an invalid-state branch (state cookie missing or mismatched, journey already consumed or expired, missing `code`, or a swallowed journey-store error from `storeFor().catch(() => null)` / `journeys.consume().catch(() => false)`), or a token-exchange/user-fetch throw classified by `failureMeta` (`src/discord.ts`). | The member already sees the matching recovery page: expired-link retry, or the Discord-down 503. A database-caused invalid-state failure also renders "Join link expired" even though the link itself was fine. | Filter logs for the line and split by `kind` and `outcome`, not by `outcome` alone. `provider_outage`/`rate_limited`/`transport_failure` with `outcome: error` point at Discord or wire health; `expired_grant` with `outcome: expired` is a spent or replayed approval. `provider_reject` with status 400/401 (for example `invalid_client` after a secret rotation, or `invalid_request` from a bad redirect URI) points at `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` and the registered redirect URI, not at Discord health. `unknown` with a null status is an app-side throw. A sustained `expired` burst with no matching Discord-side change points at the journey store: check `web_oauth_journeys` and database health via the [alert runbook](runbook-alerts.md). Never replay a member join to investigate. | `exception` (class only, never the message, which can quote the secret), `kind`/`status` (exchange-throw site only), sanitized `source`, `outcome`, `request_id` (only when it passes validation) |

### Kit session-bridge and auth-status probe warnings

Two `console.warn` lines from the Kit hook dispatch
(`src/route-ownership.ts`). Neither pages: the bridge line is a designed
guest-equivalent render or fail-closed refusal, and the probe line is an
optional cookie skipped on an already-authorized response. Neither line
carries `request_id`, route, or cookie values, so correlate by time window
plus route/status evidence per [Find a request](#find-a-request): never
request cookie values and never invent request correlation fields.

| Message | Trigger | Member impact | Severity | First read-only check | Fields carried | Security boundary |
| --- | --- | --- | --- | --- | --- | --- |
| `kit session bridge unavailable; rendering without locals.` | The optional read-only session bridge (`sessionFor`) rejected after a Kit ownership decision and before `resolve` (`src/route-ownership.ts:643-653`). The bridge merges one session decision into `event.locals`; on failure locals stay guest-equivalent and `viewerOf` names no viewer (`src/route-ownership.ts:403-406`). | Protected member contents are refused: the member-read render fails closed with the bridged (unknown) viewer (`test/kit-member-dispatch.test.ts:266`). Public Kit pages render as guest. | No page. Guest-equivalent render or sanitized refusal is the designed outcome, not an outage signal on its own. | Filter the exact message over the incident window; join by time window to `http.request` route/status (member-route refusal). Confirm effective ownership in `ROUTE_MANIFEST` (`src/route-ownership.ts`) via `decideRoute`/`decideOwner`, and read the bridge/session configuration in `src/kit-session.ts:228-245` and [`SESSION_SECRET`](config.md#session_secret-strength-and-rotation). | `exception` (class name only, never the message) | The bridge session read runs outside the member-read boundary (it is not member data); the render stays inside it, so protected contents are refused after bridge failure. Never request cookie values to investigate. |
| `kit auth-status probe unavailable; rendering without probe cookie.` | The optional probe-cookie provider (`authStatusCookieFor`) rejected after the response was already rendered: `GET` on an `/admin` path, status 200, `text/html`, with authenticated moderator locals (`src/route-ownership.ts:701-724`; the signer admits only that shape, `src/kit-session.ts:256-283`). | None on authorization: the successful admin HTML response is served as rendered, without the probe cookie (`test/kit-member-dispatch.test.ts:219`). Scoped to successful GET admin HTML for an authenticated moderator; other responses never call the probe. | No page. A missing optional cookie is not a privilege change, and probe failure never implies de-authentication. | Filter the exact message over the incident window; join by time window to `http.request` (GET admin route, 200). Confirm the probe preconditions and the manifest `enabled` flag in source. Never request cookie values; do not invent request correlation fields. | `exception` (class name only, never the message) | The probe cookie decorates an already-authorized response: probe failure retains that response and never removes authentication. Carries the exception class only, per [privacy and boundaries](#privacy-and-boundaries). |

Kit rollout context: admin shells and manifest-`enabled` rollback in
[Kit admin shells](moderator-admin-guide.md#kit-admin-shells-shipped-join-attempts-pair-kit-served);
artifact and log hygiene in
[Kit journey, visual and performance parity gates](kit-parity-gates.md#security);
moderator authority and role-removal residuals in the
[threat model](threat-model.md#moderator-authority)
([residuals](threat-model.md#gaps-and-residual-risks)).
Ownership flags, response behavior and the log privacy contract are unchanged
by this section.

### Auth sign-in warnings

This section documents one auth-scoped `console.warn` line (the oversized
code/state refusal in `src/auth/routes.ts`), not every auth-scoped line.
It never pages: the refusal keeps today's generic `/?n=signin_failed`
redirect, so the member already sees the outcome. The
replayed/invalid-state branch stays silent and unchanged. Correlate by the
validated `request_id`, which joins to the `http.request` line.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `discord sign-in failed` with `exception: OversizedOAuthParams` | Oversized `code`/`state` on `GET /auth/discord/callback` refused before throttle spend or any journey consume, exchange, or session work. | The generic sign-in failure redirect (`/?n=signin_failed`); the state, next and intended cookies survive for the next real hit. | Filter logs for the message with `exception: OversizedOAuthParams` and compare against `http.request` volume on `/auth/discord/callback`. A burst with no matching Discord-side change points at probing, not at Discord health. Never replay a member sign-in to investigate. | `exception` (class only, never `InvalidState`, never the refused values), validated `request_id` |

### CSP report warnings

The session-free sink (`src/csp-reports.ts`) logs at warn level and always
answers an empty no-store 204 with no session, cookie or DB read. This row
covers the oversize diagnostic; `csp.report.violation` keeps its contract in
[Privacy and boundaries](#privacy-and-boundaries). A separate shed or
exhaustion diagnostic, if added, gets its own row: exhaustion today is silent.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `csp.report.dropped_oversize` | The sink refused a body larger than the 8,192-byte cap (`MAX_CSP_REPORT_BYTES` in `src/csp-report-body.ts`) before parsing. Benign: a misconfigured page or extension emitting a large report. Attack: an oversize flood spending the shared per-isolate log budget to hide real `csp.report.violation` lines. | None: every sink path answers 204. | Filter Workers Logs message/text with `csp.report.dropped_oversize` over the window and compare with `http.request` volume on `POST /csp-reports` and the `csp.report.violation` rate; then cross-check the [CSP report log budget](config.md#csp-report-log-budget) (burst of 20, one refill per 3 seconds, shared by both warning keys) and any shed or exhaustion signal where present. Exhaustion is silent, so a violation drought during an oversize burst may mean the shared per-isolate budget was spent; it does not prove violations stopped — also check `CSP_REPORT_SAMPLE_RATE` (sampled-out reports consume no token) and that the burst reached the burst cap of 20. | `bytes` (number only: the declared length when refused unread, otherwise observed bytes including the discarded overflow chunk; never the body, a URI, or member identity) |

### Discord sign-in and guild auto-join warnings

Two `console.warn` lines in `src/auth/routes.ts` cover the ordinary-login
Discord round trip (`GET /auth/discord/callback`). Neither pages: the sign-in
line always accompanies the member-visible failure redirect, and the auto-join
line always accompanies the recovery page the member already sees. Correlate
both by `request_id` with the `http.request` record (see
[Find a request](#find-a-request)). Where a line carries an exception, it is
the class name only, never the raw error text, which can quote the client
secret or the live access token.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `discord sign-in failed` | The token exchange (`exchangeCode`) or user fetch (`fetchUser`) threw; the failure is classified by `failureMeta` in `src/discord.ts`. Read `kind` plus `status`, not volume alone: `expired_grant` (400 plus `invalid_grant`) is a spent, replayed or timed-out approval; `provider_reject` (any other 4xx, for example `invalid_client` after a secret rotation or `invalid_request` from a bad redirect URI) points at [`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` and the registered redirect URI](config.md), not at Discord health; `rate_limited`, `provider_outage` and `transport_failure` point at Discord or wire health; `unknown` with a null status is an app-side throw. | Sign-in blocked. `rate_limited`, `provider_outage` and `transport_failure` (`isProviderOutage` in `src/discord.ts`) redirect to `/?n=signin_unavailable`; every other kind redirects to `/?n=signin_failed`. | Filter logs for the line and split by `kind` and `status`. A `provider_reject` burst with status 400/401 after a deploy or rotation points at the OAuth config above; `provider_outage`, `transport_failure` and `rate_limited` point at Discord or wire health; a lone `unknown` with a null status points at an app-side throw, so read the `exception` class. Never replay a member sign-in to investigate. | `exception` (class only, never the message, which can quote the secret), `kind`, `status`, validated `request_id` |
| `guild auto-join failed` | Adding the fresh member to the guild (`addGuildMemberDetailed` in `src/discord.ts`) returned a non-member outcome. Read `kind`: `rate_limited` is Discord throttling (a usable backoff rides to the recovery response as a `Retry-After` header); `provider_outage` is a Discord 5xx; `transport_failure` is a fetch throw; `forbidden` (403) is a bot permission problem, not an outage; `failed` is the config-shaped outcome (blank bot token, malformed guild or user id, or any other non-429/403/5xx status), so a sustained `failed` run points at [`DISCORD_GUILD_ID` / `DISCORD_BOT_TOKEN`](config.md) and the bot's guild membership, not at Discord health. | None on sign-in: the session is still issued as a non-member session and the member lands on the `/?n=join_failed` recovery page with the invite fallback; the remembered destination is re-recorded for the retry. | Filter logs for the line and split by `kind`. A sustained `failed` run points at the guild/bot config above; `forbidden` points at the bot's guild role and permissions; `rate_limited`, `provider_outage` and `transport_failure` point at Discord or wire health. Never replay a member sign-in to investigate. | `request_id`, `guild_id` (the configured guild actually used, not a member identity), `kind` |

### Analytics write-degradation warnings

Two `console.warn` lines mark best-effort analytics writes that rejected or
outran the 500 ms response deadline (`recordSearch` in
`src/events/search-log.ts`, `recordBoardView` in
`src/hotzones/board-log.ts`). None pages: neither outcome fails the request,
so a missing analytics row is a dashboard gap, never a member-facing failure.
Promoting these warnings to `error.alert` was considered and rejected for the
same reason the join attempt-write failure above stays a warning: the request
itself succeeded.

For event-search warnings, `recordSearch` is awaited before the page
continues. A rejection warning may be emitted before or after the response
continues, depending on whether the write wins the deadline race. A
`LogWriteDeadline` warning can delay the response by up to 500 ms.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Event search unavailable for logging; serving results without recording.` | The `event_search_logs` `INSERT` rejected, or the 500 ms response deadline fired first (`src/events/search-log.ts`). | None on this request. The results were still served; only the analytics row may be missing. | Filter logs for the exact message over the incident window; then run the shared aggregate check below. | `exception` (the rejection class name, or the fixed `LogWriteDeadline` string; never the raw error text, which can carry the DSN) |
| `Board view unavailable for logging; serving results without recording.` | The `board_view_logs` `INSERT` rejected, or the 500 ms response deadline fired first (`src/hotzones/board-log.ts`). Member-board views queue behind the member-read boundary and write only after a released 200. | None on this request. The board was still served; only the analytics row may be missing. | Filter logs for the exact message over the incident window; then run the shared aggregate check below. | `exception` (the rejection class name, or the fixed `LogWriteDeadline` string; never the raw error text) |

The `exception` field tells a rejection apart from a deadline expiry: a
rejected write carries the error's class name (with a `typeof` fallback for a
non-`Error` throw), while an expired response wait carries the fixed string
`LogWriteDeadline`. The deadline is a race, not a cancellation: the write
promise keeps running after the 500 ms timer fires, so a `LogWriteDeadline`
warning may still be followed by a settled row — and if that late write then
rejects, the same request logs a second warning with the rejection class.
Never equate warning count with lost requests, and never assume one warning
per affected request.

These two lines are fail-open anonymous analytics. Do not confuse them with
the fail-closed mandatory auditing rows in the table above (`Member read audit
failed; refusing contents.`, `Member data access could not be recorded;
refusing to serve the read.`): a member-data read is refused when its
`member_data_access_logs` row cannot be written, while a search or board view
is always served when its analytics row cannot. The analytics tables store
normalized dimensions (`normalized_query` on event searches;
`normalized_board_key`, `scope`, and `season` on board views) with per-row
result counts and `occurred_at` timestamps. They carry no member identity by
design, so erasure leaves them because no row belongs to a member (see [What
is retained and why](member-erasure.md#what-is-retained-and-why)). Retention,
prune batching,
and outage-time refusal policy are decided in the [retention
ledger](retention-ledger.md) and the [database-outage
contract](db-outage-matrix.md); this section changes none of them.

Shared first check for either line (read-only; run no `INSERT`, `DELETE`,
replay, lock clear, or credential change to investigate):

```sql
-- Incident-window aggregates. Compare against http.request volume on the
-- serving routes over the same window; a gap inside one window matches the
-- warn timestamps. If writes never resume, route database insert health to
-- the authorized operator.
SELECT count(*), max(occurred_at) FROM event_search_logs WHERE occurred_at > now() - interval '1 hour';
SELECT count(*), max(occurred_at) FROM board_view_logs WHERE occurred_at > now() - interval '1 hour';
```

Neither line carries a `request_id`, so correlate by time window and route,
not by ID. Keep raw `normalized_query` and `normalized_board_key` values,
member identity, cookies, tokens, connection strings, and invented request IDs
out of diagnostic output: the aggregates above are sufficient, and the
warning's `exception` is a class name, never the message.

### Missing sync-queue binding warning

`event write-back due but SYNC_EVENT_QUEUE is not bound` (`src/events/sync.ts`,
`enqueueEventSync`) is a `console.warn`, not one of the `console.error` rows
above. It means the event write already committed, but this Worker did not send
the queue carrier: the function logs this line and returns the built message
without calling the queue, and its only callers (`dispatchWriteBack` in
`src/admin/writeback.ts`, `dispatchRsvpSync` in `src/events/rsvp.ts`) await it
without sending anything else. The database write remains committed while the
queue carrier was not sent.

On staging the write-back is late, not lost, as long as only the web Worker
lacks the binding. The jobs Worker (`two-web-jobs`) runs `reconcileEvents`
every 10 minutes (`wrangler.jobs.jsonc`) and re-dispatches stale events,
including published or cancelled events with `sync_revision > synced_revision`
and published events with no `discord_event_id` or unsynced RSVPs
(`src/jobs/events.ts`). Reconcile never calls `enqueueEventSync`; it dispatches
through the jobs Worker's own `SYNC_EVENT_QUEUE` binding. If the staging jobs
Worker also lacks that binding, nothing re-dispatches the carrier until the
binding is fixed: treat that case as stuck, not self-healing.

In the production cutover template this self-healing does not apply: the web
Worker `two-web-next-production` owns both the `SYNC_EVENT_QUEUE` producer
binding (`env.production.queues.producers`) and the `*/10 * * * *` reconcile
cron (`env.production.triggers`, `wrangler.jsonc`), and its `scheduled`
handler (`src/worker.ts`) builds its queue from the same `env.SYNC_EVENT_QUEUE`.
A missing binding there also stops reconcile, so the carrier stays unsent until
the binding is fixed: treat a production warning as stuck, not late.

| Field | Meaning and safe values |
| --- | --- |
| `eventKey` | The event whose write-back carrier was not sent |
| `request_id` | The validated HTTP request ID (`safeRequestId`: a Cloudflare Ray ID or a generated ULID) from the `http.request` line's `request_id`. Agent-events ingress write-backs (`POST /api/agent-events`, `src/agent-events/route.ts`) carry that HTTP ID, not the `request_id` in the agent response body nor `agent_event_audits.request_id`, which is a separate ingress-minted ULID (`src/agent-events/ingress.ts`). Always correlate an agent-published event via `eventKey` plus `agent_event_audits WHERE event_key = ...`; `request_id` alone only joins to the `http.request` line. Never a secret or a member identity |

A successful HTTP response is not evidence of Discord synchronization: the
request succeeded against the database, but Discord has not been told yet.

Read-only diagnostic: filter Workers Logs message/text with the exact warning
(see [Find a request](#find-a-request)) and correlate by `eventKey` and
`request_id` (the warning's `request_id` joins to the `http.request` line).
Then check whether a later sync landed: join through
`events` (`event_sync_attempts` carries `event_id`, not `event_key`):
`SELECT * FROM event_sync_attempts JOIN events ON events.id = event_sync_attempts.event_id WHERE events.event_key = '<eventKey>'`,
or compare revisions with
`SELECT sync_revision, synced_revision, discord_event_id FROM events WHERE event_key = '<eventKey>'`
(`synced_revision` catching up to `sync_revision` means reconcile recovered
it). For an agent-published event, the warning's `request_id` never matches
`agent_event_audits.request_id` (the ingress mints its own ULID for the body
and audit rows), so always find the ingress request with
`SELECT * FROM agent_event_audits WHERE event_key = '<eventKey>'`. Then compare
the deployed Workers' queue producer bindings with
`web/wrangler.staging.jsonc`: its top-level `queues.producers` block is staging
(`SYNC_EVENT_QUEUE` bound to `two-sync-event`). Production declares its own at
`env.production.queues.producers` in `wrangler.jsonc` (`SYNC_EVENT_QUEUE` bound
to `two-web-next-production-sync-event`) because bindings are not inherited, so
check the environment that served the request. On staging, if reconcile is not
recovering events, also compare the jobs Worker's bindings with
`wrangler.jobs.jsonc` (which has no production env).
Source stays unchanged: route any binding fix to the authorized Operator under
the existing contract. Never run production database tests or replay a sync
to investigate; log search, read-only `SELECT`s, source and deployed-config
reads only.

### Bot transport warnings

One signed attempt per call; the queued job owns the retry policy
(`src/bot/client-transport.ts`, header comment). The two console lines below
are emitted on the jobs Worker (`two-web-jobs`), from the queue consumer's bot
client, for `announcement.post`, `role.assign`, `event.upsert` and
`event.cancel`. The two throws emit no console line at the transport: they
surface as a transport wait (a retry, never a recorded refusal), and only
exhaustion surfaces as `job failed` / `queue.failing`. None of the four pages
on its own; only a terminal `queue.failing` pages, per the
[alert runbook](runbook-alerts.md). Find a line with the message **contains**
filter from [Find a request](#find-a-request). Read-only checks only: a
Workers Logs search over the incident window, a `SELECT`, or a source file.

| Message | Meaning | Member impact | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `bot internal action refused` | The bot answered with a refusal envelope (`console.warn`, `src/bot/client-transport.ts:205-212`). Branch on `retryable`, never on the status: `in_progress` and `replayed` are both 409 with opposite answers (`src/bot/client-retry.ts:7-18`; the wire flag is authoritative, the table is only the missing-flag fallback). | Retryable (`retryable: true`): the job waits and retries with backoff (a usable Retry-After on 429 is admitted, otherwise the attempt's backoff), so the announcement, role change or event sync is late, not lost, until the carrier exhausts. Terminal (`retryable: false`): the job fails and `queue.failing` follows. | Tally the line over the incident window, grouped by `action` and `code`; then correlate one logical operation by its exact `idempotency_key` UUID. `role.assign` sends no key (natural idempotency), so those lines carry no `idempotency_key`: correlate by time window plus `action: role.assign` instead. Never a cookie, token or secret value. | `idempotency_key` (caller-supplied UUID, absent for `role.assign`), `action` (or `(unknown)`), `status` (HTTP status, informational), `code` (always in-vocabulary, see below), `retryable`, `duration_ms` |
| `bot internal action succeeded` | The bot answered `ok` (`console.info`, `src/bot/client-transport.ts:197-203`). `replayed: true` means the bot acknowledged a repeated idempotency key: an idempotent retry, not a fresh apply. Do not confuse it with refusal `code: replayed`, a 409 refusal code that fails closed when the wire flag is absent. | None: informational. `replayed: true` confirms the retry landed on an already-applied key (same message, same application), not a duplicate. | Same tally and `idempotency_key` correlation as the refused row; a `replayed: true` burst after an outage window is retries draining, not fresh traffic doubling. | `idempotency_key` (absent for `role.assign`), `action`, `status`, `replayed`, `duration_ms` |
| `bot unreachable` | The signed fetch rejected (DNS failure, connection refused, abort/timeout, or a redirect the runtime refused to hand back), thrown as a `BotTransportError` with one fixed string and the raw rejection as the structural `cause` (`src/bot/client-transport.ts:171-176`). Transport, never refusal: no `code` and no `retryable` were observed. | A wait, never a recorded refusal: the job retries with backoff, exactly as if the bot were down. | There is no direct line to search. On the sync path, tally `sync retry classified` with `"sync_retry_class":"BotTransportError"` over the window (see [sync-event retry-cause diagnostics](#sync-event-retry-cause-diagnostics)); on the announcement/role path, per-attempt waits emit no line at all, so check `queue.failing` for the job kind after exhaustion. Correlate via the queue message's idempotency key, never a cookie or secret value. | None in logs. The fixed string travels as the exception message only; receipts carry the class `BotTransportError`, never the raw rejection text |
| `bot answered with a redirect (3xx); not followed` | The bot answered 3xx (`3xx` is the answered status, 300-399), thrown as a `BotTransportError` (`src/bot/client-transport.ts:178-179`). The transport sends `redirect: manual` and never follows: a redirect would forward signed bodies and headers to an unvalidated origin. Same transport disposition as `bot unreachable`. | Same wait-and-retry as `bot unreachable`. A sustained burst points at the bot endpoint answering redirects (misconfigured base URL or a proxy in front of it), not at member behavior. | Same as `bot unreachable`: no direct line; tally `"sync_retry_class":"BotTransportError"` on the sync path, `queue.failing` after exhaustion. Then read the configured `BOT_ENDPOINT_URL` and compare it with the refused statuses. | None in logs. The status number rides in the exception message only; no `Location` target, URL or body ever does |

Three dispositions, three different shapes. A refused-but-retryable answer is
the bot saying no-for-now: it carries a `code` and `retryable: true`, and on
the sync path it also appears as `sync_retry_class: BotFailure` in the
[queue retry-cause table](#sync-event-retry-cause-diagnostics) (which uses its
own narrower cause set: `in_progress`, `rate_limited`, `internal`,
`discord_unavailable`, `upstream_timeout`, `unknown`; transport errors never
carry a code there either). An unreachable/redirect throw is the transport
saying it could not ask: no refusal was recorded, no `code` exists, and the
sync path records it as `sync_retry_class: BotTransportError`. A
`replayed: true` success is the bot saying already-applied: the operation is
done, and the line is the retry's acknowledgment, not evidence of a second
application.

Security boundary: the fixed throw strings carry no endpoint URL, request or
response body, redirect target, resolved address or runtime wording (the
redirect line carries only the 3xx status number); the raw rejection rides
structurally as `cause`, pinned by
`test/bot-client-transport-throw-redaction.test.ts`. The refused line's `code`
is `diagnosticCode(...)`: always one of the eleven known codes (`malformed`,
`unauthorized`, `stale_request`, `action_not_allowed`, `replayed`,
`in_progress`, `discord_rejected`, `rate_limited`, `internal`,
`discord_unavailable`, `upstream_timeout`) with a fixed `unknown` fallback
(`src/bot/diagnostic-code.ts:7-23`); a hostile or overlong provider code can
neither smuggle bytes nor flood the line. Neither console line carries the
provider's `request_id`, the provider's error message, the secret, signature
or nonce material, or any request body —
`test/bot-client-no-secret-log.test.ts` and
`test/bot-client-provider-metadata-redaction.test.ts` pin both. Correlation
uses the caller-supplied idempotency key (a validated UUID, never provider
input) or a time window: never a cookie, token, secret, member identity or
the unlogged provider `request_id`.

```sh
# Live stream of transport diagnostics (authorized Cloudflare access required).
# The internal-action transport runs on two-web-jobs after the handoff, not on
# two-web-next.
npx wrangler tail two-web-jobs --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | contains("bot internal action"))'

# Count refusals per code over a saved tail file
jq -c '.logs[]? | select(any(.message[]?; . == "bot internal action refused")) | .message[]? | select(type == "object")' \
  deliveries.json | grep -o '"code":"[a-z_]*"' | sort | uniq -c

# Correlate one logical operation by its idempotency key (announcement/event only)
jq -c '.logs[]? | select(any(.message[]?; tostring | contains("<idempotency-key-uuid>")))' \
  deliveries.json
```

In the dashboard (**Workers & Pages → two-web-jobs → Observability**), filter
the message/text with `bot internal action refused` (or `succeeded`) over the
incident window and group by `action` and `code`; paste one exact
`idempotency_key` UUID into the filter to follow a single operation across its
attempts. These receipts count attempts, not distinct logical operations.

### Export omission warnings

These `console.warn` lines describe **bounded successful-export omissions or capacity evidence**, not necessarily an outage. ICS/RSS/sitemap responses remain successful (a matching conditional request may answer 304 after the collection is built), so a 200 does not prove completeness. Separate sitemap read outcomes distinguish static fallback from a successful empty read; a capacity warning marks a full bounded SQL result, not known omissions. Each row gives the exact message, meaning, first read-only
check, and fixed fields. Find a line with the message **contains** filter from
[Find a request](#find-a-request). Read-only checks only: a Workers Logs
search or a bounded `SELECT`; never replay an export to investigate. No line
carries member identity (the ICS SEQUENCE line carries public event keys,
which are URL path segments, not member data). Never add SQL, DSNs, exception
text, descriptions or member data to these diagnostics.

Sitemap fallback is still `200`, `application/xml; charset=UTF-8`,
`public, max-age=3600`, with the same seven static leaves. `Sitemap events read.`
is emitted when the handler executes, not on every cache hit; an absent log in a
sampled or cached window proves nothing. Its `ok.returned` count is the
renderable result after omission, while capacity `returned` is the raw SQL
result before omission. Neither count is an uncapped eligible-row total.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Sitemap events read.` | Exactly one outcome per handler read (`src/seo-leaves.tsx:26-46`): `no_binding` means no configured database handle, `acquire_failed` means acquisition rejected, `query_failed` means the acquired read rejected, and `ok` means the query succeeded, including a genuine empty result. | No page from this line alone. Failures warn and serve static fallback; `no_binding` and `ok` are informational. `ok` with `returned: 0` proves no renderable rows in this bounded read, not an outage; check omission warnings before calling it an empty schedule. | Group by `outcome` over the incident window. For acquisition/query failures, check configured binding and database health through the authorized operator; never substitute credentials. An all-static response with no outcome record is still inconclusive because of caching, sampling or retention. | `outcome` (fixed vocabulary above); failures only: `exception: ReadFailure` (fixed generic classification, never driver text/name); success only: `returned` (renderable count, 0–1000) |
| `Event egress read reached capacity.` | The raw sitemap/feed SQL result hit `FEED_EGRESS_LIMIT` before JS filtering (`src/events/reads.ts:867-876,887,919`). The cap remains 1000; sitemap stays published-only, feeds keep their requested published/cancelled statuses and inclusive upcoming scope. Both order by `starts_at, id`. | No page: capacity evidence only, not proof of actual truncation, completeness or an exact omitted count. A 999-row result is silent; exactly 1000 and more than 1000 eligible rows are indistinguishable. | Group by `surface` over the window. Check separate malformed-row warnings; do not add a sentinel/count query, raise the cap, dump the table or replay the export. | `surface: sitemap` or `feed`, `limit: 1000`, `returned: 1000`; no truncated flag or omitted count |
| `listFeed skipped unrenderable rows.` | The read removed rows with an unrenderable `startsAt`/`endsAt` window, preserving good rows (`src/events/reads.ts:920-928`). A row invalid at both boundaries counts once. This does not validate builder-owned `updatedAt` or SEQUENCE and does not duplicate their warnings. | No page: incomplete successful collection, not a query failure. Fires once per read with nonzero omission, even when no valid rows survive. | Note the exact `skipped` count over the window and correlate capacity separately. Use only bounded read-only timestamp-window checks within the same status/upcoming scope; no live export replay, table dump or counter repair. | `skipped` (exact removed-row count, 1–1000; no identities) |
| `eventsRss skipped rows with non-wire timestamps.` | One or more published RSS rows had a `startsAt` or `endsAt` outside the four-digit RSS/ICS wire year range, so those items were omitted while healthy items shipped (`src/events/feeds.ts`). | No page: incomplete 200 export (or 304 after the body is built), not an outage. | Note the bounded `skipped` count; use the published/upcoming RSS query with tie-safe timestamp windows. The diagnostic carries no event key, title or description. | `skipped` count only |
| `eventsRss excluded non-wire updatedAt from lastBuildDate.` | One or more non-wire `updatedAt` values were excluded from the RSS channel's `lastBuildDate`; affected items with wire-valid boundaries remain in the feed (`src/events/routes-feeds.ts`). The channel uses the latest wire-valid update, including pre-1970 dates, and falls back to the epoch only when none exists. | No page: metadata omission only; the feed remains 200 (or 304 after building). | Note the `skipped` count and check bounded read-only timestamp windows; do not replay the export. | `skipped` count only |
| `sitemapEvents skipped unrenderable rows.` | One or more published rows had an unrenderable window (`startsAt`/`endsAt` outside the finite JS Date range) or an `updatedAt` that is not a finite `Date`, so those URLs were dropped from `/sitemap_index.xml` while the valid rows still shipped (`src/events/reads.ts:894-903`). | No page: incomplete 200 export, not an outage. This remains one omission warning per read; capacity and the `Sitemap events read.` outcome are independent. `ok.returned: 0` plus this warning means all retrieved rows were omitted, not an empty query. Acquisition/query failures instead serve static fallback with the corresponding failure outcome. | Filter logs for the exact message over the window and note `skipped` (the exact poison count). The line carries no event keys, so do not guess which events are missing: compare the served event-URL count against the same ordered, capped input the sitemap reads (`SELECT count(*) FROM (SELECT 1 FROM events WHERE status = 'published' ORDER BY starts_at, id LIMIT 1000) AS capped`, `src/events/reads.ts:881-887`) — an unbounded published count can exceed it by intentional cap overflow, not just skipped rows — then page only that same capped 1,000-row input, ordered by `(starts_at, id)`, to find non-finite or out-of-range instants. `starts_at` and primary-key `id` are non-null, and `id` is unique (`src/db/admin-schema.ts:38,46`), so this is the sitemap's deterministic order even when the 1,000-row cap splits equal-start rows. The first page has no cursor predicate (`WITH capped AS (SELECT id, event_key, starts_at, ends_at, updated_at FROM events WHERE status = 'published' ORDER BY starts_at, id LIMIT 1000) SELECT event_key, id, starts_at, ends_at, updated_at FROM capped ORDER BY starts_at, id LIMIT 100`). Each later page uses the same capped input and resumes after the previous page's last row (`WITH capped AS (SELECT id, event_key, starts_at, ends_at, updated_at FROM events WHERE status = 'published' ORDER BY starts_at, id LIMIT 1000) SELECT event_key, id, starts_at, ends_at, updated_at FROM capped WHERE (starts_at, id) > ('<last starts_at>', <last id>) ORDER BY starts_at, id LIMIT 100`); copy `starts_at` verbatim as PostgreSQL prints it in default ISO `DateStyle` (numeric offset, full fractional seconds), and use the returned integer `id` unchanged. Reformatted timestamps or ambiguous zone abbreviations can shift the cursor and skip or repeat rows. A page shorter than 100 rows is the last. Never dump the table or re-render the export to investigate. | `skipped` (count only, no event keys) |
| `eventsIcsCollection skipped out-of-range SEQUENCE rows.` | One or more collection rows carried a stored `ics_sequence` outside the RFC 5545 wire range 0–2147483647 (`IcsSequenceRangeError`, `src/events/feeds.ts:80-83,114-120,191-194`), so those VEVENTs were dropped from `/events.ics` while the valid VEVENTs shipped byte-identically. The feed is a METHOD:PUBLISH full-state replace, so subscribers drop the skipped event while `/e/:key` still shows it as live. The single-event download instead answers 503 `Calendar revision unavailable` for the same poison row: a 503 there is not a skip. | No page: incomplete 200 export (or a 304 when `If-None-Match` matches the built collection's ETag, `src/events/routes-feeds.ts:38-39,86`), not an outage. A database failure instead fails the whole read without this line. | Use only the logged `skippedEventKeys`, never a table scan: `SELECT event_key, ics_sequence FROM events WHERE event_key IN ('<key>', ...)` confirms the out-of-range revision evidence. Subscriber impact and the only approved recovery (an explicitly approved calendar-identity migration with a new UID and subscriber transition, never lowering the counter on the existing UID) live in [Calendar wire range and exhaustion](import-events-rsvps.md#calendar-wire-range-and-exhaustion): no clamping, modulo, reset, or automatic UID change. Never reset or lower the counter, and never replay an export or sync, as a diagnostic shortcut. | `skipped` (count), `skippedEventKeys` (the skipped public event keys) |
| `eventsIcsCollection skipped rows with non-wire timestamps.` | One or more collection rows carried a `DTSTAMP`/`DTSTART`/`DTEND` instant outside the RFC 5545 wire form (non-finite, negative or expanded year; `IcsTimestampRangeError`, `src/events/feeds.ts:14-32,199-202`), so those VEVENTs were dropped from `/events.ics` while the valid VEVENTs shipped byte-identically. Same METHOD:PUBLISH full-state semantics as the SEQUENCE row above: subscribers drop the skipped event while `/e/:key` still shows it as live. The single-event download answers 503 `Calendar timestamp unavailable` only when the row passes read eligibility and reaches ICS formatting (for example, a poison `updatedAt` or finite expanded/negative-year boundary); an invalid or non-finite `startsAt`/`endsAt` that makes the row ineligible returns 404 before formatting. The 503 has no ETag or attachment header (`src/events/routes-feeds.ts:52-53,138-145`): it is not a collection skip. | No page: incomplete 200 export (or a 304 when `If-None-Match` matches the built collection's ETag, `src/events/routes-feeds.ts:38-39,86`), not an outage. A database failure instead fails the whole read without this line. | Filter logs for the exact message over the window and note `skipped` (the exact poison count). The line carries no event keys, titles or descriptions, so do not guess which events are missing: page only the same ordered, capped 1,000-row input as `/events.ics` (`src/events/reads.ts:912-918`). Run page one without a cursor (`WITH capped AS (SELECT id, event_key, starts_at, ends_at, updated_at FROM events WHERE status IN ('published','cancelled') AND isfinite(starts_at) AND isfinite(ends_at) AND ends_at >= '<now>' ORDER BY starts_at, id LIMIT 1000) SELECT event_key, id, starts_at, ends_at, updated_at FROM capped ORDER BY starts_at, id LIMIT 100`). Later pages resume within that same capped input (`WITH capped AS (SELECT id, event_key, starts_at, ends_at, updated_at FROM events WHERE status IN ('published','cancelled') AND isfinite(starts_at) AND isfinite(ends_at) AND ends_at >= '<now>' ORDER BY starts_at, id LIMIT 1000) SELECT event_key, id, starts_at, ends_at, updated_at FROM capped WHERE (starts_at, id) > ('<last starts_at>', <last id>) ORDER BY starts_at, id LIMIT 100`). Keep `<now>` fixed at the original read's cutoff on every page; copy the last `starts_at` verbatim in PostgreSQL's default ISO `DateStyle` (numeric offset and full fractional seconds) and its integer `id` unchanged. The finite-boundary and inclusive upcoming predicates match the SQL read scope; `(starts_at, id)` matches its tie-breaker even when the cap splits equal-start rows. A page shorter than 100 rows is the last. A row skipped here may also carry an out-of-range revision; that sequence skip surfaces on the next export once the timestamps are repaired. Never dump the table, repair timestamps, reset subscriber identity, or replay an export or sync, as a diagnostic shortcut. | `skipped` (count only, no event keys) |

The diagnostic pages above are tie-safe: page one has no cursor. Sitemap
and ICS pages advance by `(starts_at, id)` within their respective capped
1,000-row inputs. ICS pages also keep the feed's finite-boundary and inclusive
upcoming predicates, with one fixed cutoff, so historical rows cannot consume
its bounded pages.

### Optional-content degradation warnings

Four `console.warn` lines mark degraded optional content. The page still
returns 200 with a hidden block, fallback ranks, or a static fallback; none
of these reads fails the request. Do not triage them as page outages: join
the home-events warn by its validated `request_id` to the `http.request`
line and confirm the status is 200, and read the other three by incident
window (counts carries only a view key, stats carries nothing, and the
widget carries a guild, never a request ID). Absent warnings do not prove
healthy counts, stats or widgets: each family has silent paths that hide
content without logging (see the rows). None of the four pages; the paging
side lives in the [alert runbook](runbook-alerts.md).

| Message | Trigger | User impact | Severity | First read-only check | Fields carried | Escalation boundary |
| --- | --- | --- | --- | --- | --- | --- |
| `Counts read unavailable` | One bot-owned `web_v1` view read threw or passed the 2 s deadline (`cachedRead` catch in `src/counts.ts`). Live counts and ranks degrade independently. | Hidden numerals on home (`src/screens/home.tsx`): no `member-count` block while `memberCount` is null, and static fallback rank labels while `ranks` is empty. The page is still 200. | No page. | Search logs for the line and its `key`; then check the configured bot source (explicit `BOT_DATABASE_URL`, else the `BOT_DB` Hyperdrive binding serving read-only `web_v1` views, `src/db/connection.ts`; see [config](config.md)). Never the web `DB` (it holds no `web_v1` views), never web migrations, never alternate credentials. | `key` only (`counts.live` or `counts.ranks`) | One window that recovers on retry needs nothing. Counts hidden across windows point at bot-source health: route to the authorized operator. A quiet window with hidden counts is cached degradation (unavailable results cached 60 s), no bot source (fallback with no warning), or a stale snapshot: a readable `web_v1.live_counts` row whose `counts_updated_at` is 10 min old or more (or future-dated past the same absolute bound) hides numerals with no warning and caches that outcome. With a readable bot source, check `counts_updated_at` freshness first (collector stall) before treating it as bot-source ill health. |
| `Home events unavailable; serving the fallback.` | The homepage merged read threw or passed the 1 s deadline (`warnHomeFallback` in `src/events/reads.ts`). | The teaser reads "Game nights are unavailable right now." (`data-state="unavailable"`, `src/screens/home.tsx`) instead of "Nothing scheduled yet." The page is still 200. | No page. | Join by the warning's validated `request_id` to the matching `http.request` line ([Find a request](#find-a-request)): 200 with `unavailable` is degradation, not an outage. Only join on the actual ID: malformed caller input is dropped to `undefined`. | Validated `request_id` plus `exception` (`HomeEventsDeadline` on deadline, otherwise `ReadFailure`); never driver text, SQL or identities | `HomeEventsDeadline` points at the canonical/database side of the merged read (canonical rows, past zones, persisted IDs, connection setup): the Discord read is bounded separately at 700 ms (`HOME_DISCORD_TIMEOUT_MS`) and degrades to silent `discordFailed`, so Discord slowness alone cannot trip the 1 s deadline (background: [Discord calendar snapshots](discord-snapshots.md)). Sustained `ReadFailure` with canonical errors points at database health: route to the authorized operator. An `unavailable` teaser with no warning has two silent paths: a null database handle returns unavailable without logging, and an empty canonical list plus a failed or timed-out Discord read (`discordFailed`) returns unavailable without calling `warnHomeFallback`. |
| `discord widget unavailable; rendering the join fallback` | The `/join` widget probe got a non-2xx (other than 429) or threw, while the previous posture was available (`wasAvailable` gate in `src/discord-widget.ts`). Cold isolates start optimistic, so the first failing probe warns; a sustained outage warns once. | The static fallback ("Live server preview is unavailable — the join button above still works.", `src/screens/join.tsx`): no presence snapshot, no preview loader. Join still works. | No page. | Search logs by `guild_id` over the incident window; confirm the probe target in `src/discord-widget.ts` (public `widget.json` for that guild: no member data, no cookies). | `guild_id` plus `status` (non-2xx site) or `exception` (class name, throw site); never a URL, body, token or member field | One transition during a Discord incident needs nothing. A fallback that persists across windows points at the widget switch or guild config (`DISCORD_GUILD_ID`, see [config](config.md)): route to the authorized operator. A 429 never warns: it carries no new information, so the probe keeps the previous verdict and snapshot (see below). |
| `Member stats unavailable; hiding the stats block.` | A profile stats read threw: the 500 ms budget wrapper (`memberStatsWithBudget`) or the `web_v1` view read (`readMemberStats`) in `src/profiles/stats.ts`. | The profile page renders with no stats block (`stats` null hides it, `src/profiles/pages.tsx`); the read itself is not refused. | No page. | Search logs by incident window only (message-only, no join key); then check the same configured bot `web_v1` source as counts ([config](config.md)). Never web migrations or alternate credentials. | None (message only) | Occasional warnings under load are budget trips, not proof of a broken view: when the 500 ms budget expires the wrapper aborts the in-flight `web_v1` query, and the aborted read then warns as it settles (`throwIfAborted`/rejection inside `readMemberStats`). Stats hidden across windows point at bot-source health: route to the authorized operator. Only a missing database/source (no bot URL, null handle) resolves to null silently, so a quiet window with hidden stats proves nothing only in those cases. |

A 429 from the widget probe is not a verdict change: the probe keeps the
previous availability and snapshot and logs nothing, because a rate limit
says nothing new about whether the widget is up. Expect quiet windows that
still serve a stale snapshot during 429 episodes, and a single warning only
when a later probe confirms the widget down (non-2xx) or the fetch throws.

## Privacy and boundaries

Request logs allowlist only `event`, `request_id`, `method`, `route`, `status`,
`duration_ms`, `colo`, `error_class`, `build_sha` and `release`. The last two
are the parsed 40-hex deploy commit or `null` — never the raw version tag.
They never include headers, cookies, tokens, bodies,
query strings, IPs, resolved URL paths or Discord IDs. Error alerts include the
exception class, not its message or stack (which may contain SQL bindings or
personal data). Queue failure lines carry the class for an unexpected throw, or a
fixed or sanitized reason for a handled failure, including the sync-attempt
settlement line (`sync attempt settlement failed` in `src/jobs/consumer.ts`),
which logs the bounded exception class only, never the raw settlement error
message (which may carry SQL or connection secrets); see
[the alert runbook](runbook-alerts.md). Do not add those values when
investigating an incident.

Warning lines follow the same boundary. `roster upsert failed` and
`prior session sweep failed` (`src/index.tsx`) and `guild auto-join failed`
(`src/auth/routes.ts`) carry `request_id` and, where there is one, the exception
class; they never carry a member's Discord ID. `discord sign-in failed`
(`src/auth/routes.ts`) carries the exception class, kind/status and the
validated `request_id`, and `guild auto-join failed` adds only the configured
`guild_id`, never a member identity (see
[Discord sign-in and guild auto-join warnings](#discord-sign-in-and-guild-auto-join-warnings)).
The
[moderator-recompute, trust-host and session-fallback warnings](#moderator-recompute-trust-host-and-session-fallback-warnings)
carry no member identity either: the recompute lines carry `guild_id` (and
`status` on the non-OK branch) but never the member user ID, the trust-host
line carries no fields, and the session-fallback line carries only the fixed
`SessionReadFailure` diagnostic. The join journey lines carry
no member identity either: the prune line carries the exception class (never the message), the attempt line
carries the exception class, `outcome` and validated `request_id`, and the token-exchange line carries
the exception class, kind/status, sanitized `source`, `outcome` and validated `request_id` (see
[Join journey warnings](#join-journey-warnings)). `csp.report.violation`
(`src/csp-reports.ts`) keeps each reported URI's origin and path shape, but a
17-20 digit run in a path segment (a Discord ID in `/members/:user`) is logged
as `:id` (`src/csp-report-uri.ts`). `test/console-user-key-guard.test.ts` fails
the suite if any `console.*` call under `src/` logs a `user` or `userId` key.

This is the application-log contract, not a claim that all platform telemetry
is sanitized. Cloudflare invocation records may independently include the
request URL, and existing specialist audit/warning records have their own
contracts. Worker static assets served directly by Cloudflare, and edge errors
that never dispatch to Hono, do not pass through this middleware.

`wrangler.jsonc` already enables observability. Sampling and account retention
can prevent a historic match: check the deployed configuration and time window
before concluding the request did not occur. `duration_ms` includes downstream
middleware and handler work, not queue execution or streamed-body completion.
No Logpush or external shipping is configured by this change.

## Discord guild-id configuration refusal

`Discord guild id configuration invalid.` is the exact fixed `console.warn`
message when the default cached source refuses `DISCORD_GUILD_ID`
(`src/events/discord-transients-cached.ts:51-59`). Admission requires 1–20 ASCII
digits as configured, with no trimming, coercion or decoding
(`src/events/discord-transients-live.ts:91-111`). The warning has no fields and
never echoes the refused value.

Refusal happens before the snapshot key/claim path and sends zero Discord
requests. Discord events are unavailable: the source returns an empty Discord
list with `lastReadFailed()` true, while canonical events remain available in
the calendar and home teaser (`test/discord-guild-admission-degrade.test.ts:101-175`).
This source does not emit a `Discord snapshot outcome` line. Check the configured
[`DISCORD_GUILD_ID`](config.md), rather than treating the warning as a Discord
or snapshot-store outage.

## Live Discord scheduled-events read failure

`Discord scheduled-events read failed.` is the exact fixed `console.warn`
message for one failed live read of the guild's scheduled events
(`src/events/discord-transients-live.ts:76-81`, `ReadFailure` at
`src/events/discord-transients-types.ts:29-34`). One line per failed
`upcoming()` call; a successful read stays quiet. The cached source turns a
failed live read into a retry hold and keeps serving the last usable snapshot
while one exists, so this line alone is not an outage. Read it together with
the [Discord snapshot outcome](#discord-snapshot-outcome) line for the same
window.

| Message | Trigger (`reason`) | Member impact | Severity | First read-only check | Escalation boundary | Fields carried |
| --- | --- | --- | --- | --- | --- | --- |
| `Discord scheduled-events read failed.` | One of `deadline` (the 1,000 ms headers-and-body budget elapsed), `status` (non-2xx; the body is cancelled unread), `aborted` (the deadline fired while the read was in flight: a late adapter delivery or a mid-body stall), `no_body` (a 2xx without a body), `invalid_payload` (a non-list, over-row-count, or over-byte payload), or `exception` (a fetch/parse throw classified by class name, including unparseable JSON as `SyntaxError`). | Stale cached transients served while a usable snapshot exists (`held`/`stale` on the snapshot line); an honest error state (`cold`, nothing served) only when nothing usable is left. Canonical events stay available. Not an outage. | Warn only. No page and no new alert: a throttled or slow Discord episode is expected to log a burst of these while the snapshot line stays on `held`. | Filter Workers Logs message/text with the exact line over the incident window (see [Find a request](#find-a-request)), tally the `"reason":"..."` substrings, and compare against the [Discord snapshot outcome](#discord-snapshot-outcome) mix for the same window: a `status`/429 burst with `held` snapshots is throttling, while `cold` growth or any `error` line points past Discord. `jq -c '.logs[]? \| select(any(.message[]?; . == "Discord scheduled-events read failed.")) \| .message[]? \| select(type == "object")' tail.json \| grep -o '"reason":"[a-z_]*"' \| sort \| uniq -c` | Discord-side: `status` with 401/403 (token or guild access), 429 (throttling), or 5xx (Discord outage) — check Discord health and the configured guild/token via the authorized Operator, not code. App-side: `deadline`, `aborted`, `no_body`, `invalid_payload`, or `exception` sustained outside a Discord episode, or a matching snapshot `error`/`completionFailed: true` line — triage the app, store, or config. | `reason` (always), `status` (`status` only), `retryAfter` (429 with a usable header only), `exception` (`exception` only, class name), `elapsedMs` (always). Never a message, URL, header, body, token, or member identity. |

`retryAfter` is bounded admitted backoff, not the raw header: the shared
`parseRetryAfterSeconds` parser (`src/jobs/retry-delay.ts`) accepts trimmed
digits with an optional fraction only, rounds fractions up, keeps 1 to 86,400
seconds, and omits the field when the header is absent, empty, or unusable —
so a 429 line without `retryAfter` means "no usable backoff", not "no
throttle". Only a 429 carries it; every other `status` omits it. `exception`
is the throw's fixed class name (`TypeError`, `SyntaxError`, `Error`, or the
`typeof` fallback), never its message, which can echo the bot token or wire
detail. The error body is deliberately never read: a stalled body must not
hold the page past the deadline.

## Rules last-updated stamp warning

`Invalid community.rules_last_updated — hiding /rules stamp` is the exact fixed
`console.warn` message when `rulesLastUpdated`
(`src/rules-last-updated.ts:19-22`) refuses the configured value. Two triggers
share the one line: a non-empty value that fails the strict `YYYY-MM-DD` shape
(for example `someday`, `2026-9-01`, `2026/09/01`), or a well-shaped but
impossible calendar date (month `00` or `13` and up, day `00` or past the
month's length, `February 29` on a non-leap year under Gregorian century
rules). An empty or whitespace-only value hides the stamp silently with no
warning.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `Invalid community.rules_last_updated — hiding /rules stamp` | The configured stamp value was refused, so `/rules` and `/rules.md` render without the "Last updated" stamp. The page itself stays healthy: it still answers 200 with its normal cache headers and no session, cookie or database read. | No page: a hidden stamp is a content gap, never an outage. | Read the [`RULES_LAST_UPDATED`](config.md) value in the deployed config and validate it against the parser in `src/rules-last-updated.ts`: strict `YYYY-MM-DD` shape plus a real-calendar date (month lengths, Gregorian leap years). Find sightings with the message **contains** filter from [Find a request](#find-a-request). | None (message only): the line carries no fields and never echoes the refused value, so correlate by deploy/config-change time. |

Escalation boundary: a content/config correction — set a valid `YYYY-MM-DD`
date. No parser, validation, stamp-rendering, or config-schema change.

## Discord snapshot outcome

The calendar's Discord snapshot source (`src/events/discord-transients-cached.ts`)
emits one bounded `Discord snapshot outcome` diagnostic per request through the
shared snapshot path. The staging events incident, where Discord 429s made the
events page show an error state instead of events, was diagnosed by tallying
these lines. Background: [Discord calendar snapshots](discord-snapshots.md).

| Field | Present | Meaning |
| --- | --- | --- |
| `outcome` | always | One of the outcomes below. The code can emit exactly these outcomes: `cold`, `held`, `fresh`, `stale`, `error`. |
| `completionFailed` | `console.info` line only | `true` when publishing the refresh result to the store threw. The request served live rows or a usable snapshot when one was available; otherwise the outcome is `cold` and nothing was served. |
| `code` | only for allowlisted SQLSTATEs | The store driver's SQLSTATE when `completionFailed` is true or the line is `error`. |

### What each outcome means

| Outcome | Meaning |
| --- | --- |
| `cold` | No usable snapshot: nothing served, and the page shows the error state on an otherwise-empty page. The successful first refresh logs `fresh`, not `cold`: `cold` is for requests that arrive while that first refresh still holds the lease, a refresh that failed with nothing usable left (for example an empty store during a Discord 429 episode), a snapshot older than 600 seconds, or a completion failure with neither live rows nor a usable snapshot. |
| `held` | A usable snapshot was served while a retry hold is active. That covers requests that skipped Discord because another request set the hold, and the request that just set the hold itself after its own Discord read failed. Expect during Discord 429 or slow episodes. |
| `fresh` | Served a usable snapshot completed less than 60 seconds ago. That includes a snapshot this request just refreshed: the lease winner calls Discord, completes, then logs `fresh`. Other requests served from a fresh snapshot skip Discord. |
| `stale` | Served data while the snapshot is 60 to 600 seconds old and another request holds the refresh lease, or after publishing the refresh result threw (`completionFailed: true`, which can serve even live rows because the outcome is derived from the pre-claim view). A failed refresh itself logs `held` (or `cold` when nothing usable is left), never `stale`. |
| `error` | The snapshot store read (claim) failed, the stored payload was corrupt and failed to decode, or the snapshot key config was invalid (an `APP_URL` with a path, query or credentials). Logged at warn level with no live Discord fallback. Points at the store or the config, not at Discord. A store completion failure is not `error`: it stays on the info line with `completionFailed: true`. |

A healthy mix is mostly `fresh`, with `stale` around the 60-second refresh
boundary and brief `held` stretches while Discord throttles or slows.
`completionFailed: true` is rare and usually still serves data (a `cold` line with `completionFailed: true` served nothing). An unhealthy mix is a
`cold` spike (the page error state from the staging incident), `held`/`stale`
that age into `cold`, or any sustained `error` lines.

Only these SQLSTATE codes can appear as `code`: `42501`, `42P01`, `55P03`, `57014`.
Any other driver code is dropped before logging.

The line never carries the snapshot key, the display payload, the driver's
error message (it can echo credentials), the Discord bot token, or member
identity. The `code` is a fixed allowlisted class, not a message.

### Tally in Workers telemetry

1. Open **Cloudflare dashboard → Workers & Pages → two-web-next → Observability**.
   Choose a time window around the report and the correct deployed Worker.
2. Use the message/text **contains** filter with `Discord snapshot outcome`.
   These console records are serialized JSON strings; do not assume an indexed
   `outcome` field.
3. Tally the `"outcome":"cold"`, `"outcome":"held"`, `"outcome":"fresh"`,
   `"outcome":"stale"` and `"outcome":"error"` substrings across the window,
   and note any `"completionFailed":true` or `"code":"..."` values. Compare the
   mix against the healthy and unhealthy shapes above.

## CSP sink shed signal

`POST /csp-reports` (`src/csp-reports.ts`) logs through one in-memory token
bucket per isolate (20 warnings, one token per 3 seconds, shared by violation
and oversize warnings). When the bucket is spent, drops emit a bounded shed
signal instead of going silent, so operators can tell a shedding sink from a
quiet one under flood.

| Message | Meaning | Severity | First read-only check | Fields carried |
| --- | --- | --- | --- | --- |
| `csp.report.shed` | Log-budget drops were shed: at most one line per 3-second refill window per isolate, counting drops since the previous shed emit. | Warns only: every report still answers 204 `no-store`, session-free and DB-free. | Filter logs for the line and compare against `http.request` volume on `/csp-reports` for the same window; an isolated sighting is a burst, a sustained one is a flood or a misbehaving reporter. | `dropped` (positive integer count, never request content) |

The signal carries no URI, directive, sample, header, cookie or identity: only
the fixed `dropped` count. Sampled-out (`CSP_REPORT_SAMPLE_RATE`) and
malformed reports never touch the budget and never shed.

## Local regression check

```sh
# Focused request/correlation tests use fixtures only.
env -u DATABASE_URL -u AUDIT_IMPORT_TEST_DATABASE_URL \
  -u LEGACY_DATABASE_URL -u BOT_DATABASE_URL \
  npx vitest run test/request-log.test.ts test/request-correlation.test.ts test/alerts.test.ts
# First create a fresh run-owned database following README's database setup; replace the suffix.
export TEST_DB=two_web_next_tog1234567890123456
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/${TEST_DB}"
export AUDIT_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"
unset LEGACY_DATABASE_URL
export PGPASSWORD=
export W1_AGENT_TESTDB=0
npm run db:migrate
npm run db:check
env -u BOT_DATABASE_URL npm run check
```

Never point tests or probes at staging or production databases.

Sources:
- [Hono middleware execution/error handling](https://hono.dev/docs/guides/middleware#execution-order)
- [Hono registered route helpers](https://hono.dev/docs/helpers/route#matchedroutes)
- [Workers Logs dashboard, structured logs and sampling](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
