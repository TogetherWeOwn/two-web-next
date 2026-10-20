# Staging jobs handoff runbook: two-web-next → two-web-jobs

Staging-only transfer of the queue consumers and cron schedules from the web
Worker (`two-web-next`, `wrangler.jsonc`) to the jobs Worker (`two-web-jobs`,
`wrangler.jobs.jsonc`). Same queue names, same bindings, same payloads, same
handlers (`handleQueue`/`handleScheduled` in `src/jobs/worker.ts`); no Effect,
no renames. `test/jobs-worker-config.test.ts` and `test/jobs-handoff.test.ts`
pin the split: exactly one consumer per queue and one cron owner.

## What moves and what does not

- Moves: `consumers` for `two-sync-event` / `two-internal-action` and both
  crons (`*/10 * * * *` reconcile, `0 0 * * *` prune) to the jobs top level.
- Stays: web producers (`SYNC_EVENT_QUEUE`, `INTERNAL_ACTION_QUEUE`), routes,
  `env.production` cutover template, preview envs and their disjoint queues.
- Jobs top level adds only `placement` (aws:us-east-1, beside PlanetScale staging),
  `tail_consumers` (staging pager), `keep_vars` and `APP_URL`; never preview
  production guild settings and never secrets in source.

## Least-required secrets (Operator step, names only)

Provision on `two-web-jobs` with `wrangler secret put --config
wrangler.jobs.jsonc`, never in a file, PR, log or argv value:

- `BOT_ENDPOINT_URL`, `BOT_KEY_ID`, `BOT_SHARED_SECRET` — required for
  delivery. A missing value fails every bot job terminally (`BotTerminalError`,
  `queue.failing` alert, never acked as success). Confirm present before
  resuming delivery or replaying real messages. The staging deploy workflow
  enforces this fail-closed (`node ci/check-jobs-secrets.mjs` runs before the
  jobs Worker deploy and refuses when any of the three names is absent), so an
  automatic deploy after merge can never attach the jobs consumer without them.
- `QA_AUTH_TOKEN` — staging only; gates the alert-probe path through
  `qaEnabled()` with the staging `APP_URL`.

Do not provision on jobs: `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`SESSION_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_MODERATOR_ROLE_IDS`,
`QUEUE_RECONCILE_*` (separate authorization). The jobs preview keeps
`APP_URL https://two-web-jobs-preview.invalid` so `qaEnabled()` stays false.

Custody (names only, never values): the three BOT names come through the
existing staging-only granted custodian path. Do not rotate or substitute a
credential to fill a gap, do not copy production or preview guild settings,
and do not provision `QUEUE_RECONCILE_*` by inference. `QA_AUTH_TOKEN` is
optional and probe-only: two older host QA-token sources disagree, so do not
pick the older file merely because it exists. Establish the current approved
staging QA source through the granted custodian before copying any probe
token, and record which source was used without pasting a value.

## Readiness (jobs has no fetch handler)

- `npx wrangler deployments status --name two-web-jobs --json` names the
  active version; `npx wrangler queues consumer list <queue>` shows exactly
  one consumer (`worker:two-web-jobs`) per staging queue.
- Staging `GET /up` still answers 200 with the queue ledger envelope
  (`healthy`/`degraded`, never sunk by a queue-only read).
- Jobs `queue.failing` traces page through `two-web-next-alerts`
  (`APP_SCRIPT_NAMES` includes `two-web-jobs`).
- Synthetic: the staging-only internal-action drill
  (`bin/internal-action-drill.mjs`, throwaway channel/identity) and the alert
  probe; both refuse production targets.

## Coordinated hold (required before any handoff mutation)

The handoff needs a bounded exclusive hold across three lanes that no single
workflow serializes: the staging deploy lane (`deploy-staging` concurrency
group in `.github/workflows/deploy.yml`), the hand-dispatch migration lane
(`web-migrate-staging` concurrency group in
`.github/workflows/db-migrate.yml`, which the deploy job does not call), and
the Operator queue/cron mutations below. One quiet Actions page or one
concurrency group never proves the other two are idle.

Establish the hold before provisioning any missing BOT secret: the deploy
workflow fires on every green main CI (`workflow_run` on `ci`), and once
`node ci/check-jobs-secrets.mjs` sees the three BOT names it detaches the web
consumers and attaches `two-web-jobs` itself with no pause-delivery step. Treat
secret provisioning as a covered handoff mutation, not a pre-step outside the
hold.

- Make the hold enforceable for the window, not just acknowledged: disable
  both automatic lanes before the first mutation —
  `gh workflow disable deploy` and `gh workflow disable db-migrate` — then
  re-enable both when the handoff is done or aborted —
  `gh workflow enable deploy` and `gh workflow enable db-migrate` — unless the
  handoff rolled back, in which case leave both disabled per Rollback
  until the cause is fixed. After re-enabling, verify
  `gh workflow list --all` shows both `deploy` and `db-migrate` as active:
  a workflow left disabled silently drops later `workflow_run` events.
  An acknowledgement on the card thread alone does not stop the lane. (There
  is no approval gate to leave pending: the `staging` environment has no
  required reviewers, so only the disable commands freeze anything.)
  The staging migration hold (`vars.STAGING_MIGRATION_HOLD`, exactly `false`
  to release) is independent of this lane disable: it holds staging
  migrations and the whole staging deploy even while both workflows are
  enabled, and the handoff does not change it.
- Open the deploy, db-migrate and ci Actions pages (the `ci.yml` workflow for
  the exact main SHA counts: a still-running ci run on main triggers a deploy
  when it ends and shows on neither of the other two pages) and confirm no run
  is in flight on any of them before the first mutation, and re-confirm with
  the exact-SHA gate (`node ci/staging-deploy-gate.mjs`) before each Cloudflare
  mutation.
- The gate script is Actions-only by default: outside Actions
  `process.env.GITHUB_EVENT_PATH` is undefined and it exits 1 with a TypeError.
  Run it by hand from a main checkout at the gate SHA with:
  `printf '{"repository":{"full_name":"TogetherWeOwn/two-web-next"}}' >
  /tmp/staging-gate-event.json` then `GITHUB_EVENT_NAME=workflow_dispatch
  GITHUB_EVENT_PATH=/tmp/staging-gate-event.json
  GITHUB_REPOSITORY=TogetherWeOwn/two-web-next GITHUB_REF=refs/heads/main
  GITHUB_SHA=$(git rev-parse HEAD) GITHUB_TOKEN=$(gh auth token) node
  ci/staging-deploy-gate.mjs`. The checkout SHA must equal `GITHUB_SHA`.
- Record the hold on the handoff card thread with named owner
  acknowledgements, a start time and an expiry (at most 2h; release explicitly
  when done). An expired hold is not a hold: re-acknowledge before continuing.
- While the hold is active, any new deploy or migration run aborts the handoff:
  stop, re-record the rollback pointers and the backlog, and re-enter under a
  fresh hold.
- Source changes to this runbook or the pinned configs need ordinary
  exact-head CI and an independent review before they count as the packet.

## Handoff sequence (authorized Operator, serialized)

Run under the coordinated hold above with no deploy in flight. Re-verify
exact-SHA CI (`node ci/staging-deploy-gate.mjs`) before each Cloudflare
mutation. Detach before attach so two consumers never exist.

```bash
# 0. Record the rollback pointers and the backlog (read-only).
npx --no-install wrangler deployments status --name two-web-next --json
npx --no-install wrangler deployments status --name two-web-jobs --json
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
npx --no-install wrangler queues info two-sync-event
npx --no-install wrangler queues info two-internal-action
curl -fsS https://next.togetherweown.com/up

# 1. Pause delivery (reversible; producers keep enqueueing, backlog retained).
npx --no-install wrangler queues pause-delivery two-sync-event
npx --no-install wrangler queues pause-delivery two-internal-action

# 2. Detach: deploy the web Worker without consumers or crons, then remove
# its existing consumers explicitly. The deploy alone does NOT detach:
# Wrangler only adds or updates the consumers listed in the deployed config
# and never deletes one that was dropped from it, so without the removes the
# next step collides with the still-attached worker:two-web-next consumer.
npx wrangler deploy --config wrangler.jsonc --tag "$DEPLOY_SHA"
for q in two-sync-event two-internal-action; do
  # Capture before grepping: a failed list piped into grep reads as "no
  # consumer" without pipefail, and the attach then collides with the
  # still-attached web consumer. A failed list fails the run instead.
  out=$(npx --no-install wrangler queues consumer list "$q") || exit 1
  if printf '%s' "$out" | grep -q "two-web-next"; then
    npx --no-install wrangler queues consumer remove "$q" two-web-next
  else
    echo "no two-web-next consumer on $q"
  fi
done
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
# Both lists are empty; messages accumulate, none are lost.

# 3. Attach: deploy the jobs Worker with consumers and both crons.
npx wrangler deploy --config wrangler.jobs.jsonc --tag "$DEPLOY_SHA"
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
# Each list shows exactly worker:two-web-jobs, once.

# 4. Resume the existing transport and reconcile.
npx --no-install wrangler queues resume-delivery two-sync-event
npx --no-install wrangler queues resume-delivery two-internal-action
curl -fsS https://next.togetherweown.com/up
```

Backlog is reconciled, never purged: queue names are unchanged so transport
messages survive the redeploys; the Postgres ledger plus the single-flight
advisory lock serialize the cron passes; tracked sends with the unique lock
and immutable idempotency keys keep bot side effects from duplicating. Do not
purge, delete/recreate queues, age-delete ledger rows or clear unique locks
as a shortcut. Never `wrangler queues purge` here.

## Rollback (restores ownership once)

`wrangler rollback` only changes which Worker version is active. Queue
consumers are queue-side attachments and cron schedules are trigger settings
applied outside versions, so rolling back both Workers alone leaves
`two-web-jobs` still owning both consumers and both crons. Move them back
explicitly after the version rollbacks (same pre-handoff settings the web
Worker ran with: `max_retries` 10, batch 10, timeout 5). First freeze the deploy lane
and the migrate lane until the cause is fixed: run `gh workflow disable deploy`
and `gh workflow disable db-migrate` before anything else, then list every
non-terminal `deploy` and `ci` run on main. Address both workflows by file name,
scope to main, and filter out only `completed`
(`gh run list --workflow deploy.yml --branch main --json databaseId,status,headBranch --jq '.[]
| select(.status != "completed" and .headBranch == "main")'`, `gh run list --workflow ci.yml --branch main --json databaseId,status,headBranch --jq '.[]
| select(.status != "completed" and .headBranch == "main")'`):
the plain workflow-name lookup stops resolving once the lane is disabled, an unscoped list would cancel other open PRs' `ci` runs, and
filtering on a single queued status misses the run the `deploy-staging`
concurrency group holds as pending behind an executing deploy
(`cancel-in-progress: false`). Cancel every listed run except an in-progress deploy first — a pending run starts as soon as the executing deploy finishes and would pass the secrets gate and re-attach `two-web-jobs` — then let the in-progress deploy finish rather than cancelling it mid-mutation,
cancel the remainder with `gh run cancel <run-id>`. Re-list both workflows and confirm only `completed` runs remain, and only then start the wrangler
commands below. The step-0 record stays immutable:
never overwrite the pre-handoff version pointers; if a deploy completed in the
meantime, log its new live version IDs under separate incident names, re-read
`wrangler queues consumer list` for both queues and the live schedules, and apply
the moves below against the original pre-handoff pointers. Disabling stops
future triggers; the hold treats existing runs as surviving the disable, so the rollback
carries the same in-flight check.
Re-enable both (`gh workflow enable deploy` and `gh workflow enable db-migrate`)
explicitly after the cause is fixed and the revert or fix is on main, then
verify `gh workflow list --all` shows both `deploy` and `db-migrate` as active:
a lane left disabled silently drops later `workflow_run` events. `db-migrate`
is the staging recovery path, so a rolled-back handoff must not strand it
disabled. `db-migrate` serves both `staging` and `production` targets on one
workflow, and production is live (the apex serves `two-web-next-production`
since 2026-10-10; cutover closed 2026-10-12 — see docs/runbook.md), so the
freeze covers the production target too: while `db-migrate` is disabled no
hand-dispatch production migration can run. Coordinate the window explicitly:
announce owner, start time and expiry on the handoff card, confirm no
production `db-migrate` run is queued or in progress on the Actions page before
disabling, and re-enable both lanes promptly per above once the cause is fixed.
This coordination is an announcement plus a read-only check — not a new approval gate:
the existing disable/enable exclusion stays the mechanism, and no runtime
or config authority changes. A revert of
the consumer/cron move on main is not a freeze — a revert is a push to main, so
it fires the deploy workflow — and is merged only after the manual rollback
below is complete: main still carries the moved consumers/crons and the three
BOT secrets now exist, so the next push to main would pass the secrets gate,
re-detach the web consumers and re-attach `two-web-jobs`, silently reversing
the rollback.

```bash
(
  set -euo pipefail
  # REMOTE MUTATION: run only after the incident's rollback decision.
  # Enclosing fail-fast boundary: any failure stops the rollback before later
  # mutations. Preflight validates pointers, commit, configs and live ownership
  # before the first remote mutation; mutations then run in safe order
  # (pause, versions, consumers, triggers, verify). Delivery resume is a
  # separate block below so the hold and readiness gates are re-confirmed first.

  # --- Preflight: version pointers and pre-handoff commit (no mutations) ---
  # The step-0 record stays immutable: read the pre-handoff pointers from it,
  # never overwrite them. If a deploy completed in the meantime, log its new
  # live version IDs under separate incident names (see prose above) and apply
  # the moves below against the original pre-handoff pointers.
  : "${GOOD_WEB_VERSION:?pre-handoff web Worker version ID from step-0}"
  : "${PRE_HANDOFF_SHA:?pre-handoff main commit SHA from step-0}"
  # FIRST_INSTALL=1 when two-web-jobs has no prior application version (inert
  # draft only): the jobs version rollback is skipped. Otherwise the jobs
  # pointer is required. The rollback never defaults to the previous version.
  if [ "${FIRST_INSTALL:-0}" = "1" ]; then
    if [ -n "${GOOD_JOBS_VERSION:-}" ]; then
      echo "FIRST_INSTALL=1 but GOOD_JOBS_VERSION is set" >&2
      exit 1
    fi
  else
    : "${GOOD_JOBS_VERSION:?pre-handoff jobs Worker version ID from step-0 (or FIRST_INSTALL=1)}"
  fi
  # Version IDs are lowercase UUIDs (what wrangler rollback takes and what /up
  # revision.version_id reports). A malformed pointer fails here, before any
  # mutation, instead of rolling back to the wrong version.
  for v in "$GOOD_WEB_VERSION" ${GOOD_JOBS_VERSION:-}; do
    if ! printf '%s' "$v" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
      echo "bad Worker version ID (not a lowercase UUID): $v" >&2
      exit 1
    fi
  done
  if ! printf '%s' "$PRE_HANDOFF_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "bad PRE_HANDOFF_SHA (not 40-hex): $PRE_HANDOFF_SHA" >&2
    exit 1
  fi
  # Delivery must be active before this rollback pauses it. Set
  # DELIVERY_WAS_ACTIVE=1 only after confirming via the Queues REST API
  # (GET /accounts/:acct/queues shows settings.delivery_paused false for both
  # queues — wrangler queues info prints no delivery state). Any other value,
  # including 0 or unset, fails here: if either queue is paused, stop and
  # investigate instead of adopting an unowned pause — this rollback resumes
  # only pauses it owns (markers below), never another run's pause. The pause
  # loop re-reads live delivery state before each pause, so this assertion and
  # that read must agree.
  if [ "${DELIVERY_WAS_ACTIVE:-}" != "1" ]; then
    echo "DELIVERY_WAS_ACTIVE must be 1 (Queues API showed delivery active for both queues)" >&2
    exit 1
  fi
  # A verified marker from an earlier run must never gate this run's resume:
  # clear it before any pause. The resume block consumes it after resuming.
  rm -f ./.rollback-verified
  # Cloudflare API credentials are needed for the live delivery reads below
  # (and the schedule readback later): fail here, before any mutation, when
  # they are absent. Tokens come from the environment, never argv.
  : "${CF_ACCOUNT_ID:?staging account id}"
  : "${CLOUDFLARE_API_TOKEN:?injected, never on argv}"

  # --- Preflight: rollback configs (local writes, no Cloudflare mutations) ---
  # $PRE_HANDOFF_SHA is the pre-handoff main commit: the commit SHA the
  # pre-handoff Versions are tagged with (step-0 record, bin/revision-check.mjs).
  # The rollback configs are written inside the checkout, not /tmp: wrangler
  # resolves the web config's assets.directory (./public) relative to the config
  # file, so /tmp/rollback-wrangler.jsonc aborts with "assets.directory ...
  # does not exist: /tmp/public" before any API call. --env "" silences the
  # multi-environment warning for the top-level staging config.
  git show "$PRE_HANDOFF_SHA:wrangler.jsonc" > ./rollback-wrangler.jsonc
  git show "$PRE_HANDOFF_SHA:wrangler.jobs.jsonc" > ./rollback-wrangler.jobs.jsonc

  # Verify the pre-handoff configs before mutating (fails closed when either is
  # unexpected): the web config restores both crons and both consumers, the
  # jobs config owns none. This runs before the version rollbacks so a wrong
  # $PRE_HANDOFF_SHA fails before any Cloudflare mutation.
  node --input-type=module -e "import { readFileSync } from 'node:fs'; import { readWranglerConfig } from './ci/wrangler-config.mjs'; const web = readWranglerConfig(readFileSync('./rollback-wrangler.jsonc', 'utf8')); const jobs = readWranglerConfig(readFileSync('./rollback-wrangler.jobs.jsonc', 'utf8')); const webCrons = (web.triggers?.crons ?? []).slice().sort(); const wantCrons = ['*/10 * * * *', '0 0 * * *'].sort(); if (JSON.stringify(webCrons) !== JSON.stringify(wantCrons)) { console.error('rollback web config crons mismatch: ' + JSON.stringify(webCrons)); process.exit(1); } if ((jobs.triggers?.crons ?? []).length !== 0) { console.error('rollback jobs config still owns crons'); process.exit(1); } const webQueues = (web.queues?.consumers ?? []).map((c) => c.queue).sort(); const wantQueues = ['two-internal-action', 'two-sync-event']; if (JSON.stringify(webQueues) !== JSON.stringify(wantQueues)) { console.error('rollback web config consumers mismatch: ' + JSON.stringify(webQueues)); process.exit(1); } if ((jobs.queues?.consumers ?? []).length !== 0) { console.error('rollback jobs config still owns consumers'); process.exit(1); } console.log('rollback preflight ok: web restores both crons and both consumers, jobs owns none');"

  # --- Preflight: live consumer ownership (reads, no mutations) ---
  # Read live attachments before mutating. A failed list fails the run instead
  # of reading as empty; an unexpected consumer (neither two-web-next nor
  # two-web-jobs) fails instead of being blindly touched. Uses --json for exact
  # script-name matching: table grep would match two-web-jobs-preview as
  # two-web-jobs.
  for q in two-sync-event two-internal-action; do
    out=$(npx --no-install wrangler queues consumer list "$q" --json) || exit 1
    CONSUMERS_JSON="$out" QUEUE="$q" node -e '
      const d = JSON.parse(process.env.CONSUMERS_JSON);
      if (!Array.isArray(d)) { console.error(process.env.QUEUE + ": consumer list is not an array"); process.exit(1); }
      for (const c of d) {
        const script = c.script ?? c.script_name ?? null;
        if (script === "two-web-next" || script === "two-web-jobs") continue;
        console.error(process.env.QUEUE + ": unexpected consumer " + JSON.stringify(script ?? c));
        process.exit(1);
      }
      console.log(process.env.QUEUE + ": live consumers ok (" + d.length + ")");
    '
  done

  # --- Pause delivery (owned pauses only; producers keep enqueueing) ---
  # Each pause this rollback makes is recorded in a marker file
  # (./.rollback-paused-<queue>). The resume block below resumes only marked
  # queues; a queue paused by another run has no marker and is left untouched.
  # Re-entry is state-aware: live delivery is read via the Queues REST API
  # before each pause (wrangler queues info prints no delivery state, so the
  # API's settings.delivery_paused is the exact read). A marked queue that is
  # still paused is this rollback's own pause (skip); a marked queue that is
  # live-active holds a stale marker from an already-resumed incident (clear it
  # and pause fresh); an unmarked queue that is live-paused belongs to another
  # run (fail, never adopt). A failed or unknown delivery read fails the run.
  # Never purge, delete/recreate queues, age-delete ledger rows or clear
  # unique locks.
  for q in two-sync-event two-internal-action; do
    delivery=$(CF_TOKEN="$CLOUDFLARE_API_TOKEN" CF_ACCT="$CF_ACCOUNT_ID" QUEUE="$q" node -e '
      (async () => {
        const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + process.env.CF_ACCT + "/queues", {
          headers: { authorization: "Bearer " + process.env.CF_TOKEN },
        });
        const d = await r.json();
        if (!d.success) { console.error(JSON.stringify(d.errors)); process.exit(1); }
        const found = (d.result ?? []).filter((x) => x.queue_name === process.env.QUEUE);
        if (found.length !== 1) { console.error(process.env.QUEUE + ": expected exactly one queue, got " + found.length); process.exit(1); }
        const paused = found[0].settings?.delivery_paused;
        if (paused === true) console.log("paused");
        else if (paused === false) console.log("active");
        else { console.error(process.env.QUEUE + ": unknown delivery state " + JSON.stringify(paused)); process.exit(1); }
      })();
    ') || exit 1
    if [ -f "./.rollback-paused-$q" ]; then
      if [ "$delivery" = "paused" ]; then
        echo "already paused by this rollback on $q, skipping"
        continue
      fi
      echo "stale pause marker on $q (delivery is live-active); clearing and re-pausing"
      rm -f "./.rollback-paused-$q"
    elif [ "$delivery" = "paused" ]; then
      echo "$q: delivery already paused by another run; refusing to adopt" >&2
      exit 1
    fi
    npx --no-install wrangler queues pause-delivery "$q"
    touch "./.rollback-paused-$q"
  done

  # --- Mutations in safe order ---
  if [ "${FIRST_INSTALL:-0}" != "1" ]; then
    npx --no-install wrangler rollback "$GOOD_JOBS_VERSION" --name two-web-jobs -y
  else
    echo "FIRST_INSTALL=1: skipping jobs version rollback (no prior jobs version)"
  fi
  npx --no-install wrangler rollback "$GOOD_WEB_VERSION" --name two-web-next -y

  # Move consumers back state-aware: read live metadata first, fail on failed
  # reads or unexpected consumers, skip already-completed web-only queues, and
  # never blindly add or remove an owner. A queue with both owners converges by
  # removing jobs; a queue with neither converges by adding web.
  for q in two-sync-event two-internal-action; do
    out=$(npx --no-install wrangler queues consumer list "$q" --json) || exit 1
    state=$(CONSUMERS_JSON="$out" QUEUE="$q" node -e '
      const d = JSON.parse(process.env.CONSUMERS_JSON);
      if (!Array.isArray(d)) { console.error(process.env.QUEUE + ": consumer list is not an array"); process.exit(1); }
      let has_web = false;
      let has_jobs = false;
      for (const c of d) {
        const script = c.script ?? c.script_name ?? null;
        if (script === "two-web-next") has_web = true;
        else if (script === "two-web-jobs") has_jobs = true;
        else { console.error(process.env.QUEUE + ": unexpected consumer " + JSON.stringify(script ?? c)); process.exit(1); }
      }
      console.log(has_web && has_jobs ? "both" : has_web ? "web-only" : has_jobs ? "jobs-only" : "neither");
    ') || exit 1
    case "$state" in
      web-only)
        echo "already web-only on $q, skipping"
        ;;
      jobs-only|neither|both)
        if [ "$state" = "jobs-only" ] || [ "$state" = "both" ]; then
          npx --no-install wrangler queues consumer remove "$q" two-web-jobs
        fi
        if [ "$state" = "jobs-only" ] || [ "$state" = "neither" ]; then
          npx --no-install wrangler queues consumer add "$q" two-web-next --message-retries 10 --batch-size 10 --batch-timeout 5
        fi
        ;;
      *)
        echo "$q: unexpected consumer state $state" >&2
        exit 1
        ;;
    esac
  done

  # Move both crons back: the pre-handoff wrangler.jsonc (validated above)
  # still lists both schedules; apply its triggers, then clear the jobs
  # Worker's schedules by applying its produce-only config from the same
  # commit.
  npx --no-install wrangler triggers deploy --config ./rollback-wrangler.jsonc --env ""
  npx --no-install wrangler triggers deploy --config ./rollback-wrangler.jobs.jsonc --env ""

  # Read back the live schedules just applied (fails closed when Cloudflare
  # disagrees with the pre-handoff configs). The local check above cannot show
  # what the Workers now hold, so GET each staging script's schedules like
  # docs/runbook.md does for production (token from the environment, never argv).
  (
    set -euo pipefail
    : "${CF_ACCOUNT_ID:?staging account id}"
    : "${CLOUDFLARE_API_TOKEN:?injected, never on argv}"
    CF_TOKEN="$CLOUDFLARE_API_TOKEN" CF_ACCT="$CF_ACCOUNT_ID" node -e '
      const token = process.env.CF_TOKEN;
      const acct = process.env.CF_ACCT;
      (async () => {
        const expected = { "two-web-next": ["*/10 * * * *", "0 0 * * *"], "two-web-jobs": [] };
        for (const [script, crons] of Object.entries(expected)) {
          const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + acct + "/workers/scripts/" + script + "/schedules", {
            headers: { authorization: "Bearer " + token },
          });
          const d = await r.json();
          if (!d.success) { console.error(JSON.stringify(d.errors)); process.exit(1); }
          const live = (d.result?.schedules ?? []).map((s) => s.cron).sort();
          if (JSON.stringify(live) !== JSON.stringify([...crons].sort())) {
            console.error(script + " schedules mismatch: " + JSON.stringify(live));
            process.exit(1);
          }
        }
        console.log("live schedules ok: web owns both crons, jobs owns none");
      })();
    '
  )
  rm -f ./rollback-wrangler.jsonc ./rollback-wrangler.jobs.jsonc

  # Verify: exactly one consumer again (worker:two-web-next, once per queue).
  # Re-read live state and fail unless converged: a remove/add that exited 0
  # but did not take effect must not be marked verified.
  for q in two-sync-event two-internal-action; do
    out=$(npx --no-install wrangler queues consumer list "$q" --json) || exit 1
    CONSUMERS_JSON="$out" QUEUE="$q" node -e '
      const d = JSON.parse(process.env.CONSUMERS_JSON);
      if (!Array.isArray(d)) { console.error(process.env.QUEUE + ": consumer list is not an array"); process.exit(1); }
      const s = d.map((c) => c.script ?? c.script_name ?? null);
      if (s.length !== 1 || s[0] !== "two-web-next") {
        console.error(process.env.QUEUE + ": expected exactly worker:two-web-next, got " + JSON.stringify(s));
        process.exit(1);
      }
    ' || exit 1
  done
  npx --no-install wrangler deployments status --name two-web-next --json
  npx --no-install wrangler deployments status --name two-web-jobs --json
  curl -fsS https://next.togetherweown.com/up
  # Resume delivery only if paused. Owned pauses resume in the separate block
  # below, after the hold and readiness gates are re-confirmed.
  touch ./.rollback-verified
)
```

A Worker rollback does not undo schema, data, Discord side effects or queue
messages. Keep required bindings in place; never delete a queue to roll back.

Delivery resume is owned and gated: the main block above reads live delivery
state via the Queues API before each pause, pauses only queues that are
live-active and unmarked, and records each pause it makes in a marker file
(`./.rollback-paused-<queue>`); the block below resumes only marked queues. A
queue paused by another run — for example an aborted handoff whose own markers
live outside this rollback — has no marker here and fails the pause loop
instead of being adopted: adopting it would resume delivery the owning run may
still need paused. A marker whose queue reads live-active is stale (delivery
was resumed since, by hand or from another checkout): the loop clears it and
pauses fresh. If a queue is paused with no marker, stop and investigate; resume
it only by an explicit Operator decision recorded on the card (confirm the
owning run is aborted, then resume that queue by hand and record why). The
verified marker (`./.rollback-verified`) is single-use: the main block clears
any earlier copy before pausing, writes it only after the consumer, schedule
and health readbacks pass, and the resume block consumes it after resuming, so
a stale copy can never authorize a later resume. Re-confirm the hold is active,
no deploy or migrate run appeared (re-run the `gh run list` checks above and
require only `completed`), and `/up` is healthy or degraded before resuming.
Never purge, delete/recreate queues, age-delete ledger rows or clear unique
locks.

```bash
(
  set -euo pipefail
  # REMOTE MUTATION: resume only owned pauses, after the gates above clear.
  if [ ! -f ./.rollback-verified ]; then
    echo "main rollback block did not verify; refusing to resume" >&2
    exit 1
  fi
  for q in two-sync-event two-internal-action; do
    if [ ! -f "./.rollback-paused-$q" ]; then
      echo "no owned pause on $q, leaving delivery untouched"
      continue
    fi
    npx --no-install wrangler queues resume-delivery "$q"
    rm -f "./.rollback-paused-$q"
  done
  # Consume this run's verification: a later rollback must verify again, and a
  # stale marker must never authorize its resume.
  rm -f ./.rollback-verified
)
```

### First install: no prior jobs application version

Right now `two-web-jobs` is only the inert bootstrap draft (zero crons, no
queue bindings) plus the existing staging `BOT_KEY_ID`; `BOT_ENDPOINT_URL` and
`BOT_SHARED_SECRET` are deliberately absent so the required-secrets gate stays
fail-closed. There is no good jobs application version yet, so
`$GOOD_JOBS_VERSION` does not exist and a version rollback of the jobs Worker
is not the rollback. If the handoff fails before the first jobs attach:

- Keep the web rollback pointers from the step-0 record: the known pre-handoff
  web pointers recorded 2026-10-12 were version
  `55c22e8e-b1d4-4137-867f-06bf3ceebae2` and deployment
  `5a8e6b90-ecaa-48e2-8026-14552066d8f1`, but always prefer the fresh step-0
  record over these copies. A Worker version rollback alone never restores the
  queue-side consumers or the trigger schedules; move both back explicitly with
  the same block as the standard rollback above (same `max_retries` 10,
  batch 10, timeout 5; triggers via the pre-handoff configs), but skip the `wrangler rollback "$GOOD_JOBS_VERSION" --name two-web-jobs` line by setting `FIRST_INSTALL=1` and run only the pause, consumer, trigger and verify steps: there is no good jobs version to roll back to, and the command would default to the previous (bad or draft) version instead of failing.
- Partial detach/attach re-entry is state-aware: re-run the main rollback
  block, which reads live consumer metadata first (`consumer list --json`),
  fails on a failed list or an unexpected consumer, skips queues already back
  on the web Worker, and never blindly adds or removes an owner. A failed
  consumer list fails the run instead of reading as empty. Pauses are
  state-aware too: the loop reads live delivery state via the Queues API,
  refuses an unmarked live-paused queue, and clears a stale marker on a
  live-active queue before pausing fresh. Bounded delivery resume: the resume
  block runs `resume-delivery` only for queues this rollback paused (marker
  files `./.rollback-paused-<queue>`) after the verified marker gates it; a
  queue paused by another run has no marker and is left untouched. Never purge,
  delete/recreate queues, age-delete ledger rows or clear unique locks.
