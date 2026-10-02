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
| `error.alert` | An unhandled error reached the 500 handler | `fingerprint` (`ExceptionClass@/route/pattern`), `exception`, `method`, `route` |
| `queue.failing` | A job failed terminally or threw on its final attempt | `connection`, `queue`, `job`, `attempts`, `exception` |

- The app mutes `error.alert` per `class@route` for five minutes. Client errors
  (404, 403, 429, other 4xx and validation errors) stay silent.
- Request alert lines use exception classes, not messages. A separate
  `unhandled error:` line can contain the full internal exception.
- Queue source lines are not muted: one per terminal job failure. **Their
  `exception` can be a bot refusal message**, not just a class. Neither that field
  nor any trace exception/request/header/body is forwarded by the Tail Worker.

## Delivery and redaction

`tail/worker.ts` accepts only critical `error.alert` and `queue.failing` JSON
arguments from error-level logs of `two-web-next`. Other events, malformed
arguments, other Workers and recursive Tail logs are ignored.

| Outbound field | Policy |
| --- | --- |
| `event` | Only the two critical event types |
| `fingerprint` | Request: SHA-256 of the source fingerprint; queue: `queue.failing@JobClass` |
| `route` | Request only: a reviewed registered route template; unknown/raw paths and query-bearing routes become `[redacted]` |
| `job`, `attempts` | Queue only: known job class and positive integer attempt count |
| `timestamp` | ISO timestamp from the source console log, never a user-supplied field |

The Discord message is this summary as JSON in `content`, with all mentions
explicitly disabled. No exception/class/message, HTTP method, job body,
connection/queue name, URL, token, member/event ID or full trace is forwarded.
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

## Configure/deploy (staging first)

The Tail Worker has no public route, Workers.dev endpoint, database binding or
queue consumer. `OPS_ALERT_WEBHOOK_URL` is an **optional secret on the Tail
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

## Tailing and fallback

```sh
# Source alerts only (authorized Cloudflare access required)
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
