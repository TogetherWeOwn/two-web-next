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
| `scheduled.failing` | A scheduled reconcile or retention run failed (known cron only); pages directly without waiting for the crash-loop gate, which sparse cron invocations can never trip alone. Exception: a `model:prune` line with exception `PruneBatchCapError` means the pass committed but hit the per-pass batch ceiling with rows possibly pending — a backlog, not an outage | `job` (`events:reconcile` or `model:prune`), `exception`, `error_class` (same class), `build_sha`, `release`. One line per failed invocation, no source-side mute; healthy runs, advisory-lock skips and unknown crons stay silent. A capped pass likewise pages once per pass, after the flight commits; only `PruneBatchCapError` pages for a committed pass, and a rolled-back pass pages only its real error. On a cap page, check that the next pass drains the remainder; pages on consecutive passes mean inflow above the ceiling |

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

Like the per-fingerprint mute, the cooldown arms only when the page is
actually delivered; a failed Discord POST leaves the alarm ready to retry on
the next batch.

The summary is allowlisted like the other events: `event`, `script`, optional
`build_sha` (same version-tag rule as above), the fixed `logs` dashboard path,
`window_seconds`, `requests`, `errors`, `crashes`, `error_rate` and
`timestamp`. It is recorded with the usual `ops.alert.delivered` /
`ops.alert.delivery_failed` receipt. Aggregation is additive: a failing
aggregator falls back to local counts and never suppresses the per-fingerprint
pager. Tune the gates in `tail/worker.ts` (`SPIKE_MIN_ERRORS`,
`SPIKE_MIN_RATE`, `SPIKE_MIN_CRASHES`, `SPIKE_COOLDOWN_MS`) only with staging
evidence; on a quiet site the count floor, not the rate, is what fires.

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
3. Deploy the app (`npx wrangler deploy`). `wrangler.jsonc` attaches
   `tail_consumers: [{ service: "two-web-next-alerts" }]`. The staging deploy
   workflow performs the same Tail-first ordering. Both bundles are dry-run
   built by CI.
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
the ordinary global 403. Authenticated probes use the shared 10/minute QA
throttle, checked only after the QA gate (so production/bad tokens cannot turn
into 429s); an exhausted budget returns the ordinary 429 before reading an upload
or enqueueing. After authentication/admission, the shared `action` body limit
counts at most 4,096 bytes; oversized bodies return 413 without enqueueing.
Disabled or unauthenticated probes never read bodies or consume throttle budget.

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
secret. Failure/timeout exits
nonzero and claims no delivery. Stop the live tail and remove the private raw
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
