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
- Jobs top level adds only `placement` (eu-central-1, beside staging Neon),
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
(`neon-web-migrate-staging` concurrency group in
`.github/workflows/db-migrate.yml`, which the deploy job does not call), and
the Operator queue/cron mutations below. One quiet Actions page or one
concurrency group never proves the other two are idle.

- Open both Actions pages (deploy and db-migrate) and confirm no run is in
  flight on either before the first mutation, and re-confirm with the
  exact-SHA gate (`node ci/staging-deploy-gate.mjs`) before each Cloudflare
  mutation.
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
Worker ran with: `max_retries` 10, batch 10, timeout 5):

```bash
# REMOTE MUTATION: run only after the incident's rollback decision.
npx --no-install wrangler rollback "$GOOD_JOBS_VERSION" --name two-web-jobs -y
npx --no-install wrangler rollback "$GOOD_WEB_VERSION" --name two-web-next -y

# Move both consumers back to the web Worker.
npx --no-install wrangler queues consumer remove two-sync-event two-web-jobs
npx --no-install wrangler queues consumer remove two-internal-action two-web-jobs
npx --no-install wrangler queues consumer add two-sync-event two-web-next \
  --message-retries 10 --batch-size 10 --batch-timeout 5
npx --no-install wrangler queues consumer add two-internal-action two-web-next \
  --message-retries 10 --batch-size 10 --batch-timeout 5

# Move both crons back: check out the pre-handoff wrangler.jsonc (it still
# lists both schedules) and apply its triggers, then clear the jobs Worker's
# schedules by applying its produce-only config from the same commit.
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
# unexpected): the web config restores both crons, the jobs config owns none.
# This runs before the triggers deploys so a wrong $PRE_HANDOFF_SHA fails
# before any Cloudflare mutation.
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { readWranglerConfig } from './ci/wrangler-config.mjs'; const web = readWranglerConfig(readFileSync('./rollback-wrangler.jsonc', 'utf8')); const jobs = readWranglerConfig(readFileSync('./rollback-wrangler.jobs.jsonc', 'utf8')); for (const cron of ['*/10 * * * *', '0 0 * * *']) { if (!(web.triggers?.crons ?? []).includes(cron)) { console.error('rollback web config is missing cron ' + cron); process.exit(1); } } if ((jobs.triggers?.crons ?? []).length !== 0) { console.error('rollback jobs config still owns crons'); process.exit(1); } console.log('rollback schedules ok: web owns both crons, jobs owns none');"
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
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
npx --no-install wrangler deployments status --name two-web-next --json
npx --no-install wrangler deployments status --name two-web-jobs --json
curl -fsS https://next.togetherweown.com/up
# Resume delivery only if paused.
```

A Worker rollback does not undo schema, data, Discord side effects or queue
messages. Keep required bindings in place; never delete a queue to roll back.

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
  the same commands as the standard rollback above (same `max_retries` 10,
  batch 10, timeout 5; triggers via the pre-handoff configs).
- Partial detach/attach is idempotent: re-run the list-then-remove/add steps. A
  failed consumer list fails the run instead of reading as empty, and delivery
  resumes only if paused. Bounded delivery resume: run `resume-delivery` only
  when the matching `pause-delivery` ran in this handoff. Never purge,
  delete/recreate queues, age-delete ledger rows or clear unique locks.
