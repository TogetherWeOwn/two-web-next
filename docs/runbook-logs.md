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
| `agent-events failed` | The agent-events ingress threw before or while handling a request (`src/agent-events/route.ts`, two call sites). | Fails closed: 503 `ingress_unavailable` for a database outage, otherwise 500 `internal_error`. | Search logs for the matching `http.request` status on the agent-events route; then `SELECT * FROM agent_event_audits` for the window. | Error name as the second argument |
| `sync retry result persistence failed` | A known sync-retry result could not be committed (`src/jobs/consumer.ts`), so the durable claim stays fenced. | Degrades: the delivery is retried after the known wait, or marked failed once tries run out. | Search logs for `sync retry classified` and `queue.failing` for the same event; see [sync-event retry-cause diagnostics](#sync-event-retry-cause-diagnostics). | Fixed reason string `sync retry result could not be persisted; request remains fenced` |
| `sync attempt settlement failed` | A definitive sync refusal could not be settled via `failSync` (`src/jobs/consumer.ts`), so the `event_sync_attempts` row stays `pending` and still blocks future revisions. | Stuck, not self-healing: this delivery is retried, but redeliveries wait on the null-fenced claim (`failSync` is never retried) and the carrier is ACKed after six deliveries with `job failed` / `queue.failing` reason `waiting carrier exhausted; request remains recoverable`; the refusal stays unrecorded and newer revisions stay blocked. | Search logs for the line (it carries no event key, only `exception`); then list null-fenced pending rows: `SELECT e.event_key, a.request_attempts, a.next_attempt_at FROM event_sync_attempts a JOIN events e ON e.id = a.event_id WHERE a.state = 'pending' AND a.next_attempt_at IS NULL`. See the operator-recovery paragraph in docs/runbook.md: no live reset or blind replay. | `exception` (class name) |
| `job threw` | A queue job threw something that is not a bot transport error, a terminal error or a refusal (`src/jobs/consumer.ts`). | Retries until the job runs out of tries, then it is buried and a `queue.failing` alert fires. | Search logs for `queue.failing` with the same job kind; then `SELECT * FROM queue_failed_jobs` for that kind. | Job `kind`, `exception` (class name) |
| `job failed` | A job returned a failed outcome (`src/jobs/consumer.ts`), and a `queue.failing` alert follows. | Terminal for that job; the ledger row is marked failed. | Search logs for `queue.failing` with the same job kind; then `SELECT * FROM queue_failed_jobs` for that kind. | Job `kind`, then the bounded failure reason (a stable code or class name, not raw error text) |
| `Member request failed; refusing contents.` | An unhandled error reached the shared error handler while a member read was active (`src/error-responses.tsx`). | Fails closed with a 503 "Member data is temporarily unavailable." body. | Search logs for the matching `http.request` record and its route. | `exception` (class name), validated `request_id` |
| `Profile request failed; refusing contents.` | An unhandled error reached the profiles router error handler (`src/profiles/routes-gate.ts`). | Fails closed: database-unavailable response for an outage, otherwise a 503 member text. | Search logs for the matching `http.request` record on a `/members` route. | `exception` (class name), validated `request_id` |
| `profiles could not resolve the session; refusing.` | The profiles session lookup threw (`src/profiles/routes-gate.ts`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `draft ICS could not resolve the session; refusing.` | The draft ICS session rotation threw (`src/events/routes-feeds.ts`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status on the `.ics` route; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `events calendar could not resolve the session; refusing.` | The events calendar session rotation threw (`src/events/routes-calendar.tsx`). | Fails closed with the database-unavailable response. | Search logs for the matching `http.request` status on `/events`; then `SELECT count(*) FROM web_sessions` to confirm the table is readable. | `exception` (class name) |
| `profile save failed` | Saving a validated profile threw (`src/profiles/routes-writes.tsx`). | Fails closed: database-unavailable response for an outage, otherwise 500 "Could not save your profile." | Search logs for the matching `http.request` status on the profile save route; then `SELECT updated_at FROM profiles` for that member. | `exception` (class name), validated `request_id` |

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
| `request_id` | The validated HTTP request ID (`safeRequestId`: a Cloudflare Ray ID or a generated ULID) from the `http.request` line's `x-request-id`. Agent-events ingress write-backs (`POST /api/agent-events`, `src/agent-events/route.ts`) carry that HTTP ID, not the `request_id` in the agent response body nor `agent_event_audits.request_id`, which is a separate ingress-minted ULID (`src/agent-events/ingress.ts`). Always correlate an agent-published event via `eventKey` plus `agent_event_audits WHERE event_key = ...`; `request_id` alone only joins to the `http.request` line. Never a secret or a member identity |

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
the deployed Workers' queue producer bindings with `wrangler.jsonc`: the
top-level `queues.producers` block is staging (`SYNC_EVENT_QUEUE` bound to
`two-sync-event`); production declares its own at
`env.production.queues.producers` (`SYNC_EVENT_QUEUE` bound to
`two-web-next-production-sync-event`) because bindings are not inherited, so
check the environment that served the request. On staging, if reconcile is not
recovering events, also compare the jobs Worker's bindings with
`wrangler.jobs.jsonc` (which has no production env).
Source stays unchanged: route any binding fix to the authorized Operator under
the existing contract. Never run production database tests or replay a sync
to investigate; log search, read-only `SELECT`s, source and deployed-config
reads only.

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
class; they never carry a member's Discord ID. `csp.report.violation`
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
| `error` | The snapshot store read (claim) failed, the stored payload was corrupt and failed to decode, or the snapshot key config was invalid (an `APP_URL` with a path, query or credentials, or a missing or oversized `DISCORD_GUILD_ID`). Logged at warn level with no live Discord fallback. Points at the store or the config, not at Discord. A store completion failure is not `error`: it stays on the info line with `completionFailed: true`. |

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
