# Runbook: critical alerts and the ops Discord pager

For deploy/rollback, `/up` interpretation, queue containment/replay limits,
Neon/Hyperdrive outages, restore drills and escalation, start with the
[operations runbook](runbook.md). `queue.failing` is terminal failure evidence,
not proof of a successful drain or a replayable dead-letter queue.

## Source lines

The app writes ONE single-line JSON object on `console.error`, with
`level: "critical"`. It does not call Discord itself. The attached
`two-web-next-alerts` Tail Worker delivers redacted summaries to the ops webhook.
**No webhook secret means no pager delivery**; the source log remains available.

| `event` | When | Source fields (internal logs only) |
| --- | --- | --- |
| `error.alert` | An unexpected non-4xx error reached an HTTP error path, including a member-read refusal or locally handled profile-save failure (the response may remain 503) | `fingerprint` (`ExceptionClass@/route/pattern`), `exception`, `error_class` (same class), `method`, `route`, optional `request_id`, `build_sha`, `release` |
| `queue.failing` | A job failed terminally or threw on its final attempt | `connection`, `queue`, `job`, `attempts`, `exception`, `error_class` (same value), optional `request_id`, `build_sha`, `release` |
| `scheduled.failing` | A scheduled reconcile or retention run failed (known cron only); pages directly without waiting for the crash-loop gate, which sparse cron invocations can never trip alone. Exception: a `model:prune` line with exception `PruneBatchCapError` means the pass committed but hit the per-pass batch ceiling with rows possibly pending — a backlog, not an outage. Exception: an `events:reconcile` line with exception `ReconcilePartialFailureError` means the pass committed with isolated dispatch failures while healthy keys still dispatched — a poison key, not an outage | `job` (`events:reconcile` or `model:prune`), `exception`, `error_class` (same class), `build_sha`, `release`. One line per failed invocation, no source-side mute; healthy runs, advisory-lock skips and unknown crons stay silent. A capped pass likewise pages once per pass, after the flight commits; only `PruneBatchCapError` pages for a committed pass, and a rolled-back pass pages only its real error. A resolved partial reconcile pass likewise pages once per pass, after the flight commits, with `ReconcilePartialFailureError`; the pass still resolves and the all-failed throw path keeps exactly its one real-class page. On a cap page, check that the next pass drains the remainder; pages on consecutive passes mean inflow above the ceiling. On a `ReconcilePartialFailureError` page, first check the same pass's `Event reconcile pass completed.` counts in the jobs Worker logs (failed > 0 with resynced/absorbed preserved); pages on consecutive passes mean a persisting poison key |

- The app mutes `error.alert` per `class@route` for five minutes. Client errors
  (404, 403, 429 and other 4xx) and `ZodError` stay silent. A thrown
  `MemberReadRefused` is a non-4xx boundary failure and does alert.
- Request alert lines use exception classes, not messages or stacks (a database
  error message can hold bound values); no `unhandled error:` line is emitted.
- Both alert types carry a validated `request_id` when an HTTP request
  originated them; scheduled jobs and legacy queue messages may omit it.
  Correlate it with the `http.request` record, see
  [request-log queries](runbook-logs.md). Request IDs do not change the
  fingerprint or mute window, and the Tail Worker does not forward them.
  Both alert types also carry `build_sha`/`release` (the emitting Worker's
  deploy commit, `null` without a `version_metadata` binding); the Tail
  Worker forwards only a validated `build_sha`, never `release`.
- Queue source lines are not muted: one per terminal job failure. **Their
  `exception` can be a bot refusal message**, not just a class. Neither that field
  nor any trace exception/request/header/body is forwarded by the Tail Worker.

### Sync-event retry-cause diagnostics

`sync retry classified` is a source warning at the retryable refusal/transport
boundary, before the retry deadline is persisted. The same narrow projection
appears in the final `queue.failing` source alert, including when retry-result
persistence fails. It adds only these optional fields:

| Field | Meaning and safe values |
| --- | --- |
| `sync_retry_class` | `BotFailure` (a retryable refusal), `BotTransportError` (no usable bot result), or constant `unknown` for malformed diagnostic input |
| `sync_retry_code` | Refusals only: exactly `in_progress`, `rate_limited`, `internal`, `discord_unavailable`, `upstream_timeout`; every other/missing/malformed code becomes `unknown` |
| `queue_carrier_attempts` | Positive integer from the current queue message's delivery attempts; existing `attempts` remains this same carrier count for compatibility |
| `sync_request_attempts` | Nonnegative integer from the durable snapshot returned by `claimSync`; counts durable claims, not necessarily completed HTTP sends |
| `sync_snapshot_age_at_claim_seconds` | Whole seconds from the snapshot's `mirroredAt` to this delivery's claim clock; unavailable, invalid or future times are omitted |

These fields do not control retries. The bot's existing `retryable` flag and
Retry-After/backoff still determine behavior, even for an unknown code. No
provider request ID, error message, payload, response body, raw key or additional
input field is copied into the projection. Only own data properties are sampled;
accessors are never invoked. Unreadable fields are omitted or use the constant
fallback, and a malformed optional receipt cannot suppress the failure alert.
An unavailable snapshot property omits only age, not the observed cause/counts.
The Tail's outbound summary is unchanged and does **not** forward these fields.

**Correlation and history boundary:** no vetted safe durable request reference
is exposed by the current objects, so this receipt deliberately omits it. Do not
hash an event/member key or describe a carrier UUID or HTTP `request_id` as a
stable durable identity across replay. The age is snapshot age at claim, not
dispatch age, request creation age or final-alert age. A waiting/fenced claim or
already-exhausted request has no new refusal/transport observation: its receipt
omits cause and durable count rather than guessing from carrier timing or
inventing a prior cause. No new query, schema, secret or identity is added.
Cause is delivery-local; the receipt cannot reconstruct prior carriers' causes.

Count exhaustion **occurrences**, not distinct durable requests. A transport
classification can include an unusable response, not just network downtime.
Neither a missing classification nor deployment/E2E timing proves an originating
cause. Instrumentation is not replay, discard, restart or deployment authority;
later observation requires a separately authorized release and naturally
occurring work.

## Delivery and redaction

For source alerts, `tail/worker.ts` accepts only critical `error.alert`,
`queue.failing` and `scheduled.failing` JSON arguments from error-level logs
of `two-web-next` and `two-web-jobs` (`error.alert` from the web Worker,
`queue.failing` and `scheduled.failing` from the
jobs Worker after the handoff). Other
events, malformed arguments, other Workers and recursive Tail logs are ignored.

| Outbound field | Policy |
| --- | --- |
| `event` | Only the three critical event types |
| `fingerprint` | Request: SHA-256 of the source fingerprint; queue: `queue.failing@JobClass`; scheduled: `scheduled.failing@events:reconcile` or `scheduled.failing@model:prune` |
| `script` | The exact allowlisted app script name from the trace (staging web, staging jobs, or production); the reliable environment discriminator |
| `build_sha` | Optional: the deployed 40-hex source SHA, parsed from the trace's version tag when present (a bare SHA in staging, `<sha>-<run-id>-<attempt>` in production), else from the trace's own release-tagged log lines (only an exact 40-hex `build_sha` paired with an equal `release` passes — live traces do not populate the version tag, per the 2026-10-17 staging drill); anything else is omitted, never forwarded |
| `logs` | Fixed dashboard path for that script: `Workers & Pages > <script> > Observability > Logs`; a navigation path, never a URL with parameters |
| `route` | Request only: a reviewed registered route template; unknown/raw paths and query-bearing routes become `[redacted]` |
| `job`, `attempts` | Queue only: known job class and positive integer attempt count |
| `job`, `exception` | Scheduled only: the allowlisted job discriminator and the identifier-shaped exception class |
| `timestamp` | ISO timestamp from the source console log, never a user-supplied field |

The Discord message is this summary as JSON in `content`, with all mentions
explicitly disabled. No exception message, HTTP method, job body,
connection/queue name, cron text, URL, token, member/event ID or full trace is forwarded;
request and queue summaries carry no exception at all, while a scheduled
summary carries only the allowlisted exception class.
A request's original fingerprint can be correlated internally by hashing it:

```sh
printf '%s' 'AlertProbeError@/__probe/alert' | sha256sum
```

The Tail Worker adds its own five-minute mute per event/fingerprint, across
batches and concurrent invocations. Its window uses source console-log timestamps,
not Tail arrival or webhook completion time: delivery latency cannot extend the
window past the next source emission. In-flight deliveries remain deduplicated.
Queue failures of the same job class are
coalesced (attempt count does not split the fingerprint). Both source and Tail
mutes are **per isolate, not durable/global**: cold starts, deployment and
multiple isolates can produce duplicates. State is bounded to 500 sent fingerprints and 500 in-flight deliveries;
capacity eviction may allow an older fingerprint to page again. This is a small,
best-effort pager, not a durable delivery queue or exactly-once channel.

Delivery uses Discord `wait=true`, a five-second fetch timeout and no redirects.
Only a successful HTTP response records `ops.alert.delivered`; non-2xx and
transport/timeout failures record `ops.alert.delivery_failed` with the same
redacted summary. A failed delivery does not start the mute; a later source line
can retry, but the current event is not durably retried. Source request muting
can delay that next attempt. Review Tail logs when delivery is suspected lost.
The webhook URL and webhook response bodies are never logged.

### Aggregate spike alarm: `error.spike`

Per-fingerprint pages cannot say "half of traffic is failing", so the Tail
Worker also counts **every** accepted trace outcome — fetch responses by
status class and crash outcomes — without reading request URLs, headers,
exception text or log bodies. A crash outcome is `exception`, `exceededCpu`,
`exceededMemory` or `scriptNotFound`, or any trace with a non-empty
`exceptions` list; the client-disconnect outcomes `canceled` and
`responseStreamDisconnected` never count as crashes. Counts live in one `AlertAggregator` Durable
Object per Tail Worker environment (`ALERT_AGGREGATOR`, migration tag `v1`),
so cold starts and multiple isolates cannot split a spike; storage holds only
30-second bucket counts, timestamps and the allowlisted build SHA. Without
the binding the same thresholds run per isolate as a best effort.

In a rolling five-minute window per script, one `error.spike` page fires when
either gate crosses, then a 15-minute cooldown applies:

- **Error rate:** at least 5 error responses (HTTP 5xx, or a fetch that ended
  in a crash outcome — a CPU/memory limit kill has no response status at all)
  **and** at least 50% of that script's requests in the window.
- **Crash loop:** at least 5 crash outcomes, including queue, cron and
  other non-fetch invocations that produce no `error.alert` line at all.

Counts enter by event time, not by invocation or arrival time. One Tail
invocation can carry same-script traces minutes apart (a delayed flush, a
retry batch), and trace arrival order within that invocation is arbitrary:
each trace is filed into its 30-second event-time bucket from its own
`eventTimestamp`, and the buckets of one invocation are observed oldest
first. Each script retains a monotonic window endpoint: the newest accepted
event time seen for that script, including observations with zero counts.
An older arrival never moves that endpoint backward. A bucket contributes
only while its end is strictly greater than `endpoint - five minutes`;
the bucket ending exactly at the cutoff is expired. This preserves the
existing bucket-overlap convention (up to 30 seconds of boundary rounding).

Across separate invocations, four recent crashes and one six-minute-older
crash therefore never combine into a false five-crash spike, in either
arrival order. Expired arrivals are ignored before insertion, attribution
or paging: they cannot displace live counts at the bucket cap, contaminate
build attribution or retrospectively page a window already expired by a
newer observation. A late crash still inside the retained window can
complete the five-crash threshold. Equal timestamps add counts; they are
not deduplicated. The endpoint is script-local and independent of the
uptime-health observation watermark. Alert timestamps, pending-attempt
fencing and delivered-only cooldown timing keep their existing semantics.

The endpoint is persisted with counts and restored on cold start. A
rejected observation write rolls back the endpoint, counts and pending
attempt together. Legacy snapshots derive an initial endpoint from the
newest valid retained bucket start, irrespective of stored array order;
expired buckets are pruned, compatible pending/cooldown state survives and
legacy counts retain unknown attribution. An empty legacy snapshot starts
its endpoint on the first accepted observation. This migration has only
bucket-level precision; it cannot recover an old writer's exact event time
or counts already evicted by that writer.

This remains best-effort counting, not a delivery-time window or replay
engine. The endpoint advances with source observations, not wall-clock
passage; wholly delayed traffic with no newer observation can still form
its own event-time spike. Earlier pages are not retracted, and arrivals
outside the retained window are not replayed to find historical spikes.
Independent local fallback/isolate state can still differ from durable
state. Fixture tests prove the counting boundary, not live rollout or
webhook delivery.

Like the per-fingerprint mute, the cooldown arms only when the page is
actually delivered; a failed Discord POST leaves the alarm ready to retry on
the next batch.

The summary is allowlisted like the other events: `event`, `script`, optional
`build_sha` (same version-tag rule as above), the fixed `logs` dashboard path,
`window_seconds`, `requests`, `errors`, `crashes`, `error_rate` and
`timestamp`. It is recorded with the usual `ops.alert.delivered` /
`ops.alert.delivery_failed` receipt. Aggregation is additive: a failing
aggregator falls back to local counts and never suppresses the per-fingerprint
pager. Each malfunction fallback (non-OK, unparseable, or wrong-shape 200 on
`/observe` and `/health`) also emits one `console.warn` JSON line naming path
and failure class, with no payload bytes or secrets: `{"event":
"aggregator.fallback", "path": "spike" | "health", "fallback":
"aggregator-fallback", "reason": "non-ok-status" | "unparseable-json" |
"wrong-shape", "status"?: number}`. Well-formed aggregator answers stay
silent; thrown or stalled operations fall back silently. Query:
`npx wrangler tail two-web-next-alerts --search '"event":"aggregator.fallback"'`.
If the first storage load rejects with a transient fault, that request
fails and the caller falls back; a later request on the same instance retries
the load and recovers the persisted counts/cooldowns and the health window
coherently. A failed load applies nothing and writes nothing, so the retry
restores stored state exactly once, while a successful first load stays
single-flight. This path is covered by hermetic tests; live recovery has not
been observed. Tune the gates in `tail/worker.ts` (`SPIKE_MIN_ERRORS`,
`SPIKE_MIN_RATE`, `SPIKE_MIN_CRASHES`, `SPIKE_COOLDOWN_MS`) only with staging
evidence; on a quiet site the count floor, not the rate, is what fires.

Future-skew drop observability: a batch stamped beyond now plus the
`BATCH_FUTURE_SLACK_MS` slack is dropped on the tail path and rejected with
400 on the aggregator `/observe` wire — the slack bound and drop semantics
are unchanged, only the accounting is new. Each `tail()` invocation that
drops skewed traces emits one `tail.skew_drop` sink line reporting that
invocation's dropped count; a 400 for a future-skewed but otherwise valid
batch logs a skew-rejection line, while a 400 for a structurally invalid or
unparseable batch logs a malformed-payload line (status stays 400 either
way). A skew line means a poisoned clock is eating traffic; a malformed
line means payload corruption. No threshold or slack change.

The three exact rejection lines come from the Tail Worker
`two-web-next-alerts` (`AlertAggregator.fetch` in `tail/worker.ts`). Each is
`console.warn` only — no page, no Discord delivery — and the response status
stays 400; the line names the reason so operators can tell clock skew from
payload corruption. No line carries payload bytes.

| Exact warn | Emitter / path | Contract and severity | First read-only check |
| --- | --- | --- | --- |
| `tail observe rejected malformed batch: invalid body` | `two-web-next-alerts` `AlertAggregator.fetch`, pre-dispatch: any POST to `/observe`, `/health`, `/spike-result`, or `/health-result` (`tail/worker.ts`) | 400; warn only, no page. Unparseable body is malformed, never skew. No payload bytes in the line. | Filter the alerts-Worker logs for the exact string (Workers Logs, or `npx wrangler tail two-web-next-alerts --search 'tail observe rejected'`), then check the sender batch shape/version and that the sender posted valid JSON. |
| `tail observe rejected future-skewed batch: timestamp beyond slack` | `two-web-next-alerts` `AlertAggregator.fetch` `/observe` (`tail/worker.ts`) | 400; warn only, no page. Otherwise-valid batch stamped beyond now plus `BATCH_FUTURE_SLACK_MS`; a batch that is both malformed and future-stamped reads as malformed, never skew. No payload bytes in the line. | Filter the alerts-Worker logs for the exact string, then compare the sender clock against `BATCH_FUTURE_SLACK_MS` in `tail/worker.ts`. A skew line means a poisoned clock is eating traffic. |
| `tail observe rejected malformed batch: invalid payload` | `two-web-next-alerts` `AlertAggregator.fetch` `/observe` (`tail/worker.ts`) | 400; warn only, no page. Structurally invalid batch (`script`, `at`, `requests`, `errors`, `crashes` per `validBatch` in `tail/worker.ts`). No payload bytes in the line. | Filter the alerts-Worker logs for the exact string, then check the sender batch shape/version against `validBatch` in `tail/worker.ts`. A malformed line means payload corruption. |

Attribution is honest about the whole counted window. `build_sha` is present
only on a homogeneous page: every counted bucket in the window carries the
same validated build, through the same 40-hex version-tag and release-log
pairing as above (a bare tag and a production-suffixed tag of one SHA count
as one build). A mixed window — two builds in one bucket or across buckets,
or any counted bucket with unknown attribution (an untagged or invalid batch,
or counts restored from before provenance existed) — pages with `build_sha`
omitted rather than assigning every failure to the latest build. Thresholds,
counts, timing and cooldowns stay script-wide either way, and per-trace
fingerprint summaries keep their own trace's `build_sha`.

### Scheduled `/up` prober: `uptime.down`

The Tail Worker's scheduled handler generates a third event, `uptime.down`,
from its own `/up` prober when `UPTIME_URL` and a valid webhook are configured.
The cron runs every minute; each run probes once and retries a failure after
ten seconds, with a ten-second timeout per attempt. A run is red only if
**both attempts fail**, and the page fires only when health has stayed red
across runs for **over two minutes** (exactly two minutes is not enough); a
healthy run clears the window, and a 15-minute cooldown follows a delivered
page (a failed POST re-pages on the next red run). The red window lives in the same
`AlertAggregator` Durable Object (per-isolate fallback without the binding).
Healthy means HTTP 200 with `x-two-origin: two-web-next`, not merely a
reachable endpoint.

Observation ordering: the tracker persists a monotonic source-observation
watermark (the newest probe source time applied so far) alongside the red
window, and an observation stamped strictly older than that watermark is a
successful no-op — it publishes nothing and changes neither the outage start,
the pending page attempt, nor the cooldown. A delayed older healthy sample
therefore cannot clear a newer outage, and a delayed older red sample cannot
resurrect a window a newer healthy sample already cleared. Equal timestamps
are not strictly older, so a same-time retry still takes effect. The watermark
survives snapshot/restore and Durable Object restarts; snapshots written
before it existed load safely and establish it from the first observation
accepted after the restore.

The summary contains `event`, `status` (the second attempt's HTTP status,
or `0` for a transport error/timeout), `down_seconds` (how long health has
been continuously red), `timestamp`, plus optional `build_sha` (and
`version_id`) read from the already-fetched `/up` body's public
`revision.commit` through the exact 40-hex allowlist (`version_id` only
through the Worker Version UUID allowlist); an unreadable or stalled body
pages unattributed — the marker read races a 2 s independent deadline, so
a hung body cannot stall the run — and no extra probe is made.
The Tail Worker records `ops.alert.delivered` or `ops.alert.delivery_failed`
for each delivery attempt, so the delivery-receipt query below also
catches these pages. **There is no matching app source-log line by design**:
the event originates in the Tail Worker, not an `error.alert` or `queue.failing`
source emission. A receipt without a source alert is therefore expected.

Queue-only blindness pages nowhere here: an unreadable ledger reports
top-level `degraded` with `queue.status: unknown` on HTTP 200, so this prober
stays green by design. That 200 does not double with the direct
`scheduled.failing` page above, which remains the paging signal for failed
reconcile/prune runs.

### Synthetic main-flow checks: `synthetic.down`

Scheduled runs landing on a five-minute boundary also probe the main flow
on the `UPTIME_URL` origin, because a healthy `/up` does not prove members
can load the site or start
sign-in. Each check is an anonymous GET with manual redirects and a
ten-second timeout; synthetic response bodies are never read (only the
run's already-fetched `/up` body is parsed for the revision marker).
Checks run even when
`/up` is down, and each failing check is retried once after ten seconds
before it can page:

| Check | Healthy means |
|-------|---------------|
| `/` | HTTP 200 with an HTML content type |
| `/events` | HTTP 200 with an HTML content type |
| `/join` | HTTP 200 with an HTML content type |
| `/login` | HTTP 302 redirecting to `/auth/discord` on the same host |

The summary contains `event`, `check` (the probed path), `target`
(the public host of the configured `UPTIME_URL`, which identifies the
environment), `status` (the second attempt's HTTP status, or `0` for a
transport error/timeout), `timestamp`, plus the same optional `build_sha`
(and `version_id`) from the run's already-fetched `/up` body. Redirect
targets are compared by host and path only: any Location query is discarded
inside the probe and never appears in a page or log line.
Delivery uses the same five-minute, per-isolate mute, keyed by
`synthetic.down:<check>` (the status and the build attribution ride in the
page but do not split the mute, so a check flapping between failing
statuses — or a deploy answering `/up` mid-incident — pages once per
window), and the same delivery receipts as `uptime.down`.

- Correlate the page to the deploy: `build_sha` is the `/up`
  `revision.commit` observed in the paging run, so open that commit (and
  `version_id` in Cloudflare) instead of assuming the current `main` head.

No check authenticates, posts a form, injects a fault, or changes
application data, so the production prober stays passive. The sign-in
check stops at `/login` on purpose: the next hop, `/auth/discord`, mints
OAuth state and would write a login-redirect throttle hit and an OAuth
journey row on every probe attempt. The conversion check likewise stops
at the `/join` page: the next hops (`/join/discord`, `/join/callback`)
mint journey state and write throttle hits, while the page itself is a
persistence-free leaf that writes nothing. Like any anonymous visitor, the
`/events` probe records one rate-limit counter hit (the `events-read`
bucket) per admitted attempt; the existing throttle expiry sweep deletes
those counters. Staging and production each probe their own configured
host; no extra configuration exists beyond `UPTIME_URL`. The checks prove
the sign-in entry redirects onward correctly, not that the Discord
authorize hop or a full OAuth round trip completes.

## Configure/deploy (staging first)

The Tail Worker has no public route, Workers.dev endpoint, database binding or
queue consumer; its only binding is the `ALERT_AGGREGATOR` Durable Object
(counts and the health window; declared in both environments because bindings
are not inherited). `OPS_ALERT_WEBHOOK_URL` is an **optional secret on the Tail
Worker only**, not an app `Env`/`JobsEnv` variable. Only an HTTPS Discord webhook
URL at `discord.com/api[/vN]/webhooks/<id>/<token>` is accepted. Invalid/unset
configuration silently drops outbound work; it is not a successful probe.

1. Deploy the Tail Worker **before** attaching the producer:
   `npx wrangler deploy --config tail/wrangler.jsonc`.
2. The operator creates/selects the Discord channel/webhook out of band and,
   under the existing credential approval process, installs its secret with
   `npx wrangler secret put OPS_ALERT_WEBHOOK_URL --config tail/wrangler.jsonc`.
   Enter it through the secure prompt, never a command argument, repo file or
   issue comment. Do not create/rotate/export credentials to run this drill.
3. Deploy the app through `.github/workflows/deploy.yml`, which builds and
   deploys `web/wrangler.staging.jsonc` after deploying the Tail Worker. That
   Kit staging config attaches `tail_consumers: [{ service:
   "two-web-next-alerts" }]`; the workflow also retains the exact-SHA gate,
   version tag and consumer handoff. Do not deploy the Kit preview config as
   staging. CI dry-run builds both the staging Kit config and the preview config.
4. Verify the deployed app revision, exact `next.togetherweown.com` target,
   staging Hyperdrive binding and the attachment in Cloudflare. Run the probe
   below with the already-approved staging QA token. Record the revision and
   the script's redacted result. A merged/dry-run-built PR is **not** live
   webhook delivery evidence.

Production post-deploy check: after
`npx wrangler deploy --config tail/wrangler.jsonc --env production`, confirm
`OPS_ALERT_WEBHOOK_URL` is bound on `two-web-next-alerts-production` (secret
names only, never values). A missing binding deploys successfully but pages
nothing: both `tail()` and `scheduled()` return early with no outbound work.

Production/cutover remains separately gated: staging probe success does not
approve a production deploy, credential change or production test.

## Probe parity: request error + self-failing queued job

`POST /__probe/alert` exists only when `qaEnabled(APP_URL, QA_AUTH_TOKEN)` is true:
exact `https://next.togetherweown.com` and a nonempty configured QA token. It
requires `X-TWO-QA-Auth` (constant-time comparison) and the existing global
same-origin/host guards. It has **no same-origin exemption**. Valid same-origin
requests with QA disabled (including production configuration), wrong/missing
token, or GET return 404 without sending a job. Untrusted unsafe requests retain
the ordinary global 403. Authenticated probes run the shared `action` body cap
(at most 4,096 bytes) after the QA gate and before the shared 10/minute QA
throttle (so production/bad tokens cannot turn into 429s); over-cap probes
return 413 with no throttle spend and without enqueueing, even when the budget
is exhausted. Only under-cap probes can return the ordinary 429. Disabled or
unauthenticated probes never read bodies or consume throttle budget.

An authorized call enqueues `{ kind: "alert-probe", probeId }` on the staging internal
queue, then throws `AlertProbeError` through the real 500 handler. **500 is the
expected response, not proof of delivery.** An absent queue returns 503.
The consumer rechecks the QA gate, throws the same fixed synthetic exception,
emits terminal `queue.failing` for `AlertProbe` on its first attempt and acks it.
No member/event/bot mutation or ledger fixture is created. The queue envelope
accepts only an optional canonical UUIDv4 and forbids a ledger `jobId` on these
synthetic jobs; legacy probes without an ID remain valid. A delayed probe
received with QA disabled is silently acked. Repeated probes inside the mute
window will not produce two new receipts; wait at least five minutes first.

Connect the Tail Worker's receipt stream **before** invoking the probe:

```sh
# Terminal 1; private file outside the repo. Wait for Wrangler's connected message.
npx wrangler tail two-web-next-alerts --format json > /path/to/private/alert-receipts.json

# Terminal 2; QA_AUTH_TOKEN must already be supplied by an approved secret binding.
node bin/alert-probe.mjs --receipt-file /path/to/private/alert-receipts.json
# Offline preflight (validates receipt file plus token presence, sends nothing):
node bin/alert-probe.mjs --receipt-file /path/to/private/alert-receipts.json --dry-run
# Discovery (usage to stdout, zero effects):
node bin/alert-probe.mjs --help
```

The script refuses every non-staging target, posts with the QA token in a
header (never argv), expects HTTP 500, then waits up to 90 seconds for **both**
new `ops.alert.delivered` receipts matching the fixed probe fingerprints and its
random UUIDv4 `probeId` (sent in `X-TWO-Alert-Probe`). The route accepts this ID
only after QA authentication; malformed IDs return 400 without enqueueing. A
caller without that optional header receives a server-generated ID internally.
The ID follows the synthetic exception/job into internal source logs and Tail
receipts **only**; it never leaves the account in the Discord payload and does
not split/bypass the fingerprint mute. A concurrent probe cannot satisfy this
exercise's receipt pair.

Before sending, the script saves the connected file's prefix and object-start
boundary. It excludes every pre-existing object, including one partially written
at the boundary and completed later; it fails closed on prefix replacement or
truncation. Freshness does not compare the operator clock to Cloudflare's clock.
A source critical line, old receipt, foreign-probe receipt, delivery-failed
receipt, or only one receipt cannot pass. It never calls or reads the webhook
secret. Failure/timeout exits nonzero and claims no delivery, with a stable
`code=` reason distinguishing mis-invocation and missing inputs (exit 2) from
delivery failure (exit 1). Stop the live tail and remove the private raw
stream after the drill; retain only the script's redacted JSON result plus the
tested SHA as evidence. A missing operator secret leaves this live drill
unverified; local fixture tests still cover the chain.

## Aggregate threshold drill (staging only)

This exercises the `error.spike` gate end to end without touching production:

1. Wait out any cooldown (15 minutes after the last staging `error.spike`
   receipt) and connect the Tail receipt stream first, as in the probe drill.
2. Send at least five authorized `POST /__probe/alert` calls (each returns the
   expected 500) inside five minutes, with no other staging traffic in
   between where practical, so 5xx responses are at least half of the web
   Worker's requests. The shared QA throttle allows 10/minute; five calls fit
   one minute. Each call also emits its usual per-fingerprint receipts.
3. Require exactly one fresh `error.spike` receipt
   (`ops.alert.delivered`) whose `script` is `two-web-next` and whose
   `build_sha` equals the deployed staging version tag. A spike receipt
   without the correct SHA, or only the per-fingerprint receipts, is a failed
   drill — check the `ALERT_AGGREGATOR` binding on the staging Tail Worker.
4. Retain only the redacted receipt line and the tested SHA as evidence, per
   the probe drill's handling rules. Never run this against production; the
   production check is passive (binding present, receipts flow on real errors).

## Tailing and fallback

```sh
# Source alerts only (authorized Cloudflare access required). The queue
# consumer runs on two-web-jobs after the handoff, so tail it for
# queue.failing and scheduled.failing; tail two-web-next for error.alert.
npx wrangler tail two-web-jobs --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing|scheduled.failing)\""))'
npx wrangler tail two-web-next --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing)\""))'

# Redacted delivery receipts/failures
npx wrangler tail two-web-next-alerts --search '"delivery":"ops.alert.'
```

Workers Logs is enabled on both Workers. Source traces remain the diagnostic
fallback and can be piped into an approved external pager. Do not publish raw
source traces or receipt streams; they may contain the invocation envelope.

## Rollback and containment

Record the previous app **and Tail Worker** version IDs before deployment.
For a code rollback use `npx wrangler rollback <previous-id>` for the app and
`npx wrangler rollback <previous-tail-id> --config tail/wrangler.jsonc` for the
Tail Worker, then recheck the attachment and logs. On the first Tail deployment
there is no previous Tail version: roll the app back to its recorded pre-Tail
version to detach it; leave the route-less Tail Worker inert. Do not delete or
rotate the webhook credential as rollback.

For immediate paging containment, detach the Tail consumer through the
approved deployment/configuration process while preserving source logs. Keep
the Tail service deployed until the app is detached; otherwise app deployments
with a missing `tail_consumers` target fail. After restoration, wait out the
mute window and rerun the staging-only probe to confirm both receipts. No live
rollback drill is claimed by local fixture or dry-run build evidence.

References: [Cloudflare Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
(`tail()` and producer `tail_consumers`),
[Discord execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
(`wait=true`, `content`, `allowed_mentions`).
