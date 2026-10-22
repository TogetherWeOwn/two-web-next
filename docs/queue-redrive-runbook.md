# Queue dead-letter redrive runbook: two-web-next

Inspect-list-redrive loop over `queue_failed_jobs` for dead-letter recovery.
Companion to the [operations runbook](runbook.md#queue-containment-drain-and-failed-job-replay):
that section owns containment/drain gates; this page owns the dead-letter loop.
Transitions are proved against real SQL in `test/queue-redrive.test.ts`;
sync-event replay reconciliation is proved in `test/queue-replay.test.ts`.

## Rules

- The worker gate in `runbook.md` applies: do not redrive real messages until
  the worker's `BOT_*` bindings are confirmed present (missing config fails jobs
  terminally). Redrive rehearsal evidence is the test file, not live replay.
- A failed row is diagnostic identity only (`id`, `job_id`, `kind`, `key`,
  `reason`, `failed_at`) — no payload, no original bot idempotency key. Never
  reconstruct an announcement/role action from a key or fabricate a key.
- Every step is one row at a time. There is no batch redrive, no blind `DELETE`,
  and no CLI replay command. The default-off runtime preview below calls
  `reconcileFailedJob` only. The guarded re-dispatch route below is the single
  operational apply path for `replay` advice (via `replayFailedSyncEvent`);
  `discardFailedJob` remains library-only: no operational route deletes a row.

## Read-only runtime preview (disabled until separately authorized)

`GET /admin/queue/failed/:id/preview` loads exactly one server-side failed row
from the Worker's source database (`DATABASE_URL`, otherwise `DB`). It runs
`reconcileFailedJob` against `pgEventStore` in a PostgreSQL repeatable-read,
read-only transaction. Every preview source SELECT includes the VOLATILE
`clock_timestamp()` function: [Hyperdrive excludes such queries from its read
cache](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
This prevents a fresh timestamp being combined with cached source reads.
Direct PostgreSQL fixture tests prove the single-snapshot behavior under concurrent
edits; live Hyperdrive/source isolation remains an activation prerequisite, not a
local-test claim. The response is **advice for the transaction snapshot at
`observedAt`, not a write grant**. A later action must freshly reconcile; an earlier
clean preview can already be stale.
Missing source, invalid source identity or an incomplete source checker cannot
become stale-discard advice. SQL/connection failures return a redacted 503.

**Authority and custody prerequisites (all required):**

1. Independent security review of this exact operational boundary and separate
   authorization for activation. Merging this route does **not** activate it.
2. An authorized provisioning actor must verify the staging Worker/source DB
   isolation and configure `QUEUE_RECONCILE_PREVIEW_ENABLED` to exact `true`
   and `QUEUE_RECONCILE_OPERATOR_ID` to exactly one reviewed Discord snowflake.
   Neither setting is supplied by checked-in Worker configuration. Verify the
   deployed uncached-read implementation and staging Hyperdrive-to-source isolation
   before activation. On a separate authorized provisioning card, set the ID
   first and the flag last, verify readback, and name a custodian and expiry.
   Leave both unset until approved. `keep_vars` preserves them on redeploy:
   revocation requires explicitly removing both, verifying readback and revoking
   the session. Never set them on production.
3. The caller must hold an existing, valid signed session whose **server-side**
   identity matches that dedicated ID and whose moderator bit is true. A general
   moderator is insufficient. Synthetic QA identities are explicitly excluded;
   `QA_AUTH_TOKEN`, ingress grants and bot credentials confer no preview authority.
   The existing session must come from the custodian's real Discord OAuth login;
   this deliverable neither issues sessions nor provisions a principal/grant.
   Treat the cookie as a full staging-moderator credential, not a preview-only
   grant: the dedicated ID restricts this route, not other admin routes. Discord
   role removal alone does not revoke the stored session's moderator authority.
4. The authorized caller must have approved custody of the session and the single
   failure ID from the existing incident record. No failure listing or bulk
   classification endpoint exists. Never export a cookie into logs, argv values,
   shared files or a ticket. The example below uses a protected cookie jar under
   the approved principal's custody (mode 0600), **not** a new token or staging DB
   credentials. Browsers cannot set the required explicit Origin on a same-origin
   GET; the approved caller must use a non-browser client.
5. The application must be able to append the operational read receipt to the
   existing `activity_log`. It writes one `queue.failed.preview` receipt with
   actor, failure ID, disposition and snapshot time before releasing a successful
   buffered response. Audit failure always returns 503. No fabricated member subjects are recorded.

**Single-row invocation after those prerequisites only:**

```sh
# Execute under the independently approved principal; do not print the cookie jar.
# FAILURE_ID is one canonical positive safe integer, not an event/payload/key.
curl --silent --show-error --fail-with-body --max-time 30 \
  --cookie "$APPROVED_SESSION_COOKIE_JAR" \
  --header 'Origin: https://next.togetherweown.com' \
  --header 'Accept: application/json' \
  "https://next.togetherweown.com/admin/queue/failed/${FAILURE_ID}/preview"
```

No query overrides are accepted. Only GET is admitted (HEAD and write verbs get
405); an explicit matching Origin and exact staging request origin are required.
Disabled/non-staging/unconfigured admission returns DB-free 404; missing or expired
session follows the existing OAuth redirect, wrong principal gets 403, malformed
ID gets 422, unknown ID gets 404. Do not follow redirects automatically or treat
an OAuth page as a successful preview.

The bounded JSON response contains `previewOnly: true`, failure `id/kind/failedAt`,
`observedAt` and `disposition: {action, reason}`. Rationale includes only the helper's
sanitized source scope; no failure diagnostics, payload, job ID or idempotency key
is returned. `replay`, `discard-stale` and `keep` never send, delete, reset a
refusal, clear locks or change retry budgets. All responses are private/no-store.

**Handoff distinction:** the route is callable through an independently approved
principal *after* activation and custody are established. A route existing or
being merged is not proof that an operator has that permission or a live session.
An Operator without it must preserve every failed row and request the narrow
security/custody decision through the established process, not substitute QA or
DB credentials. No live preview, replay or discard is required to verify this
implementation: `test/queue-preview-route.test.ts` and
`test/queue-preview-postgres.test.ts` use offline fixtures / disposable SQL only.

## Guarded one-row re-dispatch (disabled until separately authorized)

`POST /admin/queue/failed/:id/redispatch` applies exactly one `replay`
advice. It reloads the candidate from the Worker's source database with the
same reconciliation the preview reads, then dispatches only a fresh
`replay` row. It never replays from a request body, query string, or cached
advice: the body is never parsed, query overrides are rejected, and anything
that is not `replay` with a live `eventKey` is refused with its preview
advice. The dead row is never touched here — no delete, no refusal reset,
no retry-budget change. A stale or keep row answers `409
redispatch_refused`; only a later confirmed recovery discards the dead row
through the separately approved path.

**Guards (all required, in order):**

1. Same staging/default-off admission as the preview: `QUEUE_RECONCILE_PREVIEW_ENABLED`
   must be exactly `true`, `APP_URL` must be exactly the staging origin, and
   the request origin plus an explicit matching `Origin` header must equal it.
   Only POST is admitted (other verbs get 405). Disabled, non-staging, or
   unconfigured admission returns a DB-free 404 before any session, source,
   or audit read.
2. Moderator gate plus the dedicated `QUEUE_RECONCILE_OPERATOR_ID`
   principal. The caller must hold an existing, valid signed session whose
   server-side identity matches that ID and whose moderator bit is true; a
   general moderator gets 403. A bare snowflake shape is insufficient: the
   value must match `/^\d{10,25}$/`, QA identities can never activate the
   boundary, and an unset value denies every request at admission.
3. Preview-before-redispatch order. The handler re-reconciles the single row
   fresh (`loadRedispatchCandidate`, same statements and transaction posture
   as the advice), so preview first to read the advice, then POST to apply
   only that advice. Malformed IDs and query overrides get 422, unknown IDs
   get 404 without an audit receipt, and source errors fail closed with a
   redacted 503. Preview advice is never authority: an earlier clean preview
   can already be stale, and the POST re-checks.
4. Audit-before-dispatch. The handler writes one `queue.failed.redispatch`
   receipt (`attempted` for a dispatch try, `refused` for a refusal) before
   anything is queued; an audit failure refuses with 503 so no dispatch ever
   answers without a trail. Receipts are append-only and count attempts, not
   dispatches — a `refused` receipt means nothing was queued, and only the
   response tells a queued dispatch (200) apart from an in-flight duplicate
   (200 with `deduped: true`) or a failed send (503, ledger-compensated, with
   a retry writing its own receipt). To count real dispatches, read the live
   queue rows, not the trail.
5. Producer fail-closed. A missing `SYNC_EVENT_QUEUE` binding or database
   fails closed with 503 before anything is written. A queue send failure
   keeps the attempt receipt while the ledger compensation removes the
   un-sent row, so there is no phantom backlog. A held lock reports the
   in-flight dispatch instead of queueing a duplicate.

**Single-row invocation after the preview prerequisites only:**

```sh
# Execute under the independently approved principal; do not print the cookie jar.
# FAILURE_ID is one canonical positive safe integer, not an event/payload/key.
curl --silent --show-error --fail-with-body --max-time 30 --request POST \
  --cookie "$APPROVED_SESSION_COOKIE_JAR" \
  --header 'Origin: https://next.togetherweown.com' \
  --header 'Accept: application/json' \
  "https://next.togetherweown.com/admin/queue/failed/${FAILURE_ID}/redispatch"
```

Success answers `redispatched: true` plus the preview shape; refusals and
errors mirror the preview's bounded, private/no-store envelope with no
payload, job ID, idempotency key, or failure diagnostics.

No live redispatch is required to verify this implementation:
`test/queue-redispatch-route.test.ts` uses offline fixtures with injected
candidate/dispatch doubles (no source database), and
`test/queue-redispatch-postgres.test.ts` uses disposable SQL only — never
staging or production data for a test.

## Auth-wall drill (staging only)

`bin/queue-authwall-probe.mjs` drills the three operator legs without an
operator session and without writing anything: preview admission, redispatch
admission and the source-evidence bearer wall, each across guest, member and
(non-operator) moderator legs. It follows the `bin/admin-authwall-probe.mjs`
conventions: staging-only target, `QA_AUTH_TOKEN` from env only, redacted
JSON result (statuses and fixed redirect classes — never raw locations,
tokens, cookies or bodies), nonzero exit claims nothing.

QA identities can never satisfy the operator boundary, so the probe never
expects 200: each route reports its own admission state from the guest leg
(disabled 404 or walled), and the member/moderator legs must agree with it.
Preview and redispatch share one flag and one operator ID, so their states
must agree; source-evidence is independently flagged. The probe asserts
statuses only: a moderator 403 is the operator boundary and a member 403 is
the panel gate — that attribution is pinned by
`test/queue-preview-route.test.ts` and `test/queue-redispatch-route.test.ts`,
not by this drill.

Run it with `QA_AUTH_TOKEN` from an approved secret binding:

```sh
QA_AUTH_TOKEN=<from the approved binding, never pasted> node bin/queue-authwall-probe.mjs
```

Run it after any staging deploy that touches the queue operator routes, the
admin guard or the throttle order; before and after operator-boundary
activation or revocation; and whenever a wall failure is suspected. Live runs
belong to the authorized operator procedure, not CI.

A green result names each route's admission state (`enabled`, `disabled`,
`unexpected`) plus the hit counts. A red result names the failing checks:

- A `guest` status failure with a 200/500-class actual means the wall is open
  or the route is down: treat it as an operator-boundary incident, not a drill
  failure. Disabled routes answer 404 on every leg; that is the default-off
  pass, not red.
- A `member`/`moderator` failure means a non-operator leg reached past its
  guard: do not activate or dispatch until it is explained.
- A `preview/redispatch admission agreement` failure means the two routes
  disagree despite sharing one flag: suspect deploy skew or diverged
  admission, and re-run after the deploy settles.
- A `guest POST without trusted origin status` (cross-origin control) or
  `guest POST source-evidence status` (method control) failure means the outer
  guard or method contract moved: check `src/same-origin.ts` and the route
  registrations before re-running.
- `Usage: node bin/queue-authwall-probe.mjs` on stderr means extra arguments
  were supplied: remove them; the token belongs only in the environment. No
  request was sent.
- The generic `Queue auth-wall probe failed` stderr line means missing input,
  a refused QA login or a transport failure; the probe claims no outcome and
  deliberately hides exception text. Check the approved QA binding and staging
  health. If the shared login budget was exhausted, wait out the 60-second
  window before re-running. Never substitute another credential.

Budget: 13 hits per run — 2 `qa-login` (10/min shared per runner IP, shared
with every other QA login) and 0 `admin-write` (every redispatch POST and
both controls refuse before the shared throttle; preview and source-evidence
spend no throttle). Do not loop the probe inside one minute: back-to-back runs
share the 10-login window with the admin probe and the staging suites.

## The loop

1. **Inspect** — `GET /up` `queue.failed` is the backlog-independent failure
   count (probes: `test/up.test.ts`). Newest-first inspection of the same rows
   the helper reads: `SELECT id, job_id, kind, key, reason, failed_at FROM
   queue_failed_jobs ORDER BY failed_at DESC, id DESC LIMIT 100;` against
   agent-testdb / CI service only — never staging or production data for a test.
   Helper: `listFailedJobs(sql)` (newest-first, bounded, optional `kind` filter).
2. **Retry once** — for a transient failure (transport/outage class in `reason`)
   with the original authorized message source still available: preview the
   single row first, then apply a `replay` advice only through the guarded
   one-row re-dispatch route above. The route re-reconciles (dirty source
   replays; clean source with no failed snapshot and no pending request
   discards as stale; definitive refusal or surviving pending request keeps),
   wraps the raw queue binding and ledger with `trackingQueue`, and mints a
   fresh `jobId` via `replayFailedSyncEvent`. The dead row stays until
   recovery of the new message is confirmed; the test pins the old `jobId`
   untouched while the new live row exists. Role assignments have no idempotency
   key: reconcile downstream first, or the retry double-applies.
3. **Discard** — after a confirmed recovery, or for poison that must never run
   again: `discardFailedJob(sql, failureId)` deletes exactly that row and
   reports `false` for an unknown id. The `/up` `failed` count drops by one per
   confirmed discard only.

Only after successful reconciliation of the re-dispatched message should its
dead row be discarded; unbounded history cleanup belongs to the separately
approved path, not this loop.
