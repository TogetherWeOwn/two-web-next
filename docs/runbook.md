# Operations runbook: two-web-next

This is the Cloudflare Worker runbook, not the frozen Laravel/VPS runbook.
Start here for releases, queue incidents and database recovery; use
[log-line alerts](runbook-alerts.md) for fingerprints and
[shared Postgres](db-migrations.md) for migration ownership and backup policy.
The [parity matrix](parity.md) records what is implemented versus still missing.
The production cutover and its DNS changes are outside this runbook; only the
staging rollback and DNS flip-back rehearsal is covered here.

## Safety and escalation

- **Read the incident/release authorization first.** Commands labelled remote
  mutate the deployed service; none is a test or an instruction to execute now.
  Respect existing deployment, receiver/HMAC and isolation holds. A green
  workflow or an always-200 endpoint does not release them.
- Never test, probe or verify database behavior against staging or production
  databases. Tests use `agent-testdb`, database `two_web_next`, or local fixtures;
  CI uses its disposable Postgres service. Do not send synthetic writes or
  authenticated smoke actions to live services as a substitute for those tests.
- On an authentication/ownership/permission failure, **stop**. Do not try a
  credential from another environment, print a URL/password, change identity,
  or bypass a failed check. Use the authorized broker/provisioning principal.
- DevOps & Reliability Engineer owns containment, release/rollback timing and
  incident evidence. Escalate technical decisions or missing implementation to
  the **Director of Engineering**; CI baselines belong to QA & Release Engineer.
  Security/access or suspected leaked member data go through the Director to
  CISO. The CEO consolidates owner-reserved credential rotation/deletion, new
  spend and irreversible data recovery approvals. Do not route ordinary tool
  gaps to the owner or file a second `Operator:` card for the same host step.
- Record UTC time, exact commit and Worker version IDs, affected route/job,
  redacted error class, action and rollback pointer on the incident card. Keep
  logs/dumps private; never attach member-data archives or secret-bearing logs
  to an issue. Follow [SECURITY.md](../SECURITY.md) for private disclosure.

All commands run from this repository root in Bash, with Node 24 and the
lockfile-installed Wrangler (4.143.1 at this revision). Database drill commands
also need PostgreSQL client tools compatible with the server, Python 3 and `psql`.
Remote batches use fail-fast subshells: a failed command stops that batch without
changing the caller's shell options. Stop the incident workflow on failure;
do not continue by pasting a later block.

Database commands clear inherited `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`
and `PGOPTIONS`; a host address can redirect the connection, and service settings
override environment defaults. `PGPASSFILE=/dev/null` prevents fallback to a
saved credential. See PostgreSQL's [environment variables](https://www.postgresql.org/docs/17/libpq-envars.html)
and [service precedence](https://www.postgresql.org/docs/17/libpq-pgservice.html).
Install development tools even when the shell defaults to production mode:

```bash
(
  set -euo pipefail
  npm ci --include=dev
  # Fixture-only check: limited evidence, not database acceptance.
  npm run check:offline
)
```

`check:offline` runs typecheck, config checks, fixture Vitest tests, a11y policy
self-tests, cutover self-tests and smoke self-tests. It unsets `DATABASE_URL`,
`AUDIT_IMPORT_TEST_DATABASE_URL`, `W1_AGENT_TESTDB`, all
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` variables and `PG*` settings
for every child. Conditional SQL suites then skip, including the fixed
agent-testdb control in `test/staging-fixed-agent-testdb.test.ts` enabled solely
by `W1_AGENT_TESTDB=1`. `test/review-p1-verify.test.ts` gates its live-DB proofs
behind the same skip and keeps its P1-3 refusal proofs offline, so Vitest runs
without exclusions. The command accepts no extra arguments, and
reports success as **limited evidence**, not a substitute for exact-head CI with
service-container DB coverage. Appending flags to the full shell-chain `check`
script sends them to its final cutover command, not the earlier Vitest command.

Full `npm run check`, coverage thresholds and required CI gates are unchanged.
Full database verification must explicitly use
`postgres://agent_test@agent-testdb:5432/two_web_next` and the migrated schema,
never a live service. Required CI runs the complete suite on
its disposable Postgres service.

## Deploy and record the rollback pointer

The authoritative target is [wrangler.jsonc](../wrangler.jsonc): Worker
`two-web-next`, custom domain `next.togetherweown.com`, Hyperdrive binding `DB`.
`two-web-next-staging` is a Hyperdrive resource description, **not** a Worker
name or a Wrangler environment. There is no `[env.staging]` configuration.
Do not add `--env staging` or invent a different Worker target. Verify the
approved account and binding isolation before any remote mutation.

1. Require independent Code Reviewer approval on the exact head SHA and green
   `check`, `gitleaks`, `pr-lint`; the approving reviewer squash-merges, not the
   author. Record the merged SHA and intended target.
2. Before release, capture the current deployment and its **version ID** (not
   its deployment ID) as the known-good rollback pointer. The following are
   remote metadata reads, not database probes; approved Cloudflare credentials
   must already be injected, never supplied on argv:

   ```bash
   (
     set -euo pipefail
     npx --no-install wrangler deployments list --name two-web-next --json
     npx --no-install wrangler deployments status --name two-web-next --json
   )
   ```

   On staging the live Worker also reports its own Version ID:
   `GET https://next.togetherweown.com/up` carries
   `revision: { version_id, commit }`. `version_id` is the value
   `wrangler rollback` takes; `commit` is the SHA the deploy tagged that Version
   with (`null` for a manual deploy without `--tag`). The deploy job logs it in
   `Record live revision (rollback pointer)` before any Cloudflare mutation.
   A Version uploaded before the marker existed reports no `revision`; use
   `wrangler deployments list` for it. If `/up` and `wrangler deployments`
   ever disagree, `wrangler deployments` wins. Production `/up` has no
   `revision` until a cutover PR declares the binding in `env.production`.

3. Normal path: merge to `main` invokes
   [.github/workflows/deploy.yml](../.github/workflows/deploy.yml), using the
   GitHub Environment `staging` gate. It installs dependencies, applies
   migrations to its disposable Postgres, runs `npm run check`, then plans,
   applies and verifies the **staging web migrations** of the CI-verified SHA
   against the staging database — the pinned PlanetScale staging branch
   (Neon endpoints still accepted during the transition; `ci/neon-migrate.mjs`, see
   [Neon web schema migrations](#neon-web-schema-migrations-separate-operator-action)),
   ensures `two-sync-event` and `two-internal-action` exist, then deploys. A
   failed migration step fails the job before any Cloudflare mutation. The
   queue-create step currently suppresses errors; it is not permission/provisioning evidence.
   The final staging smoke runs `node bin/smoke.mjs https://next.togetherweown.com`
   ([smoke checker](../bin/smoke.mjs)), covering 16 public routes: `/up`
   (HTTP 200, `application/json`, `status` healthy/degraded with `queue.status`
   healthy/degraded/unknown) plus HTML/RSS/iCal/sitemap/robots/redirect/404
   routes with CSP/nosniff/content-type/noindex/redirect assertions; queue
   `degraded` or `unknown` is allowed. This is public-route liveness only,
   not DB/schema readiness or queue-drain acceptance.
4. An explicitly authorized manual deployment of the reviewed release uses:

   ```bash
   # REMOTE MUTATION: approved target and release only; not a test.
   npm run deploy -- --tag "$(git rev-parse HEAD)"
   ```

   `--tag` is what lets `/up` name the commit (`revision.commit`); without it
   the Version is untagged and `commit` is `null`.

   This deploys the current checkout. Do not run it from an unmerged working
   branch, and do not bypass the Environment gate to clear a blocked CI release.
   A manual `npm run deploy` does not migrate any database, and neither deploy
   path ever migrates production. Before a manual deploy of a schema-dependent
   Worker, run the [Neon migration workflow](#neon-web-schema-migrations-separate-operator-action)
   for the matching target; coordinate with both bot and web owners using
   `docs/db-migrations.md`.
5. Capture the resulting deployment/version IDs and workflow URL. On staging
   the `Verify deployed revision` step has already proved the live Worker
   reports the commit this job deployed and logged its Version ID (it runs on
   every deploy, including docs-only ones that skip the smoke steps). `/up`
   otherwise reports only limited queue-ledger evidence (below), not successful
   private persistence. Source behavior and local tests are not proof of live
   isolation.

### Neon web schema migrations (separate operator action)

[db-migrate.yml](../.github/workflows/db-migrate.yml) is a **remote mutation**
and not a test. It is the hand-dispatch path for staging recovery and the only
path for production; the staging `deploy.yml` applies staging migrations on its
own (see *Staging deploy integration* below). This workflow's addition
does not authorize its execution. No live
migration or Neon branch creation is performed by its selftest.

**Before enabling or dispatching:**

- Require an approved schema-change window, exact-SHA review and green required
  CI on the release merged to `main`. Coordinate the shared database with bot
  and web owners; only web SQL in this repo (including the two grandfathered
  bootstraps) is applied. Use backward-compatible expand/contract changes so the
  running Worker and bot tolerate the new schema before the Worker release.
- Pre-create the matching GitHub Environments, `staging` and `production`.
  `production` must have required reviewers (recommend prevent-self-review and
  main-only deployment branches). Do not enable production if that protection
  is absent. Required reviewers live in repository settings, **not YAML**.
  Both the shell gate and runner reject non-`main` refs, invalid targets and
  production unless `PRODUCTION_DEPLOY_ENABLED` is exactly `true` (the same
  flag used for production Worker deploys). Leave it unset/false until approved.
- Provision `NEON_STAGING_DATABASE_URL` **only on the staging Environment** and
  `PRODUCTION_DATABASE_URL` **only on the production Environment**, using
  the authorized operator's secret-provisioning path. Verify the intended
  project/branch/database and direct endpoint out of band. Staging is the pinned
  PlanetScale staging branch and host (direct Neon endpoints still accepted
  during the transition); production is PlanetScale Postgres on its own branch
  and host (direct `<id>.pg.psdb.cloud:5432` endpoint — never the
  pooled `6432` port). The migrate gate pins the staging host and branch id and
  refuses the production identity in code, so a production URL in the staging
  secret fails closed. The driver pins port 5432, uses
  certificate-verified TLS, strips optional `channel_binding=prefer|disable`, and
  refuses `channel_binding=require` (unsupported by postgres.js) before connecting.
  Never weaken a required channel-binding policy just to run migrations; stop and
  coordinate a compatible driver. Never copy credentials to argv, comments, code
  or logs. No `DATABASE_URL`/Hyperdrive/alternate-secret fallback.
- GitHub's `secrets` context also resolves repository/organization secrets.
  Therefore verify the selected name exists at Environment scope before using
  this workflow; do not rely on an existing repo-scoped backup secret when the
  Environment copy is missing. The repository backup workflow currently uses
  `NEON_STAGING_DATABASE_URL` at repo scope; that is **not** migration approval
  or provisioning. YAML cannot attest a resolved secret's scope. Missing
  Environment provisioning is a stop, even if a same-named repo secret exists.
- Verify backup/PITR eligibility for the target branch (Neon history retention
  or PlanetScale backups) and a tested recovery procedure before apply. The summary's timestamp is a recovery
  reference, **not** a snapshot, a restore drill, or proof PITR is available.

**Operator execution after those gates:** select Actions → `db-migrate` → Run
workflow, branch `main`, target `staging` or `production`. The job Environment
matches the target and must clear its configured reviewers before secrets are
available. The workflow validates migration numbers, then:

1. `plan` reads the canonical SQL/journal and `drizzle.__drizzle_migrations`,
   lists pending tags and counts in logs/job summary, and performs **no DDL**.
   This is a journal diff, not a SQL execution rehearsal.
2. `apply` starts one connection-bound transaction, acquires the web transaction
   advisory lock, rechecks history, and records the database clock's UTC
   **pre-migration PITR timestamp** and release SHA in the job summary
   **before DDL**. Ledger initialization, canonical Drizzle journal SQL and
   hash/timestamp inserts, and the zero-pending check all run in that transaction.
   Connection loss fails closed, never reconnects mid-apply; the success receipt
   is printed only after commit. URLs and raw database/SQL errors are never printed.
3. Both `apply` and the final `verify` require **zero pending web migrations**.
   Save the workflow URL, release SHA, timestamp and count with release evidence
   before the Worker deployment. A successful journal check does not establish
   bot schema readiness or run staging E2E. Staging E2E at the tested revision
   remains required before any production deployment.

SQL hashes/timestamps must be an exact prefix of the release journal. Edited,
gapped, foreign/bot or newer history fails closed; never delete/forge the ledger,
use `drizzle-kit push`, or automatically baseline existing tables. Empty history
with pre-existing tables requires owner coordination, not automatic replay.
Web applies are serialized by a non-cancelling Actions concurrency group and a
DB advisory lock; bot/manual tools do not automatically share that lock. On
credential/permission errors, **stop; never try another credential**. Driver
errors are deliberately redacted; the authorized database operator investigates
using controlled provider-side evidence. Do not cancel in-flight DDL casually.

**Rollback:** a Worker rollback does not undo schema/data. SQL failure rolls back
the pending transaction, including ledger initialization on a fresh DB. Existing
history stays intact. On connection loss, do not infer commit success: re-plan and
verify under the approved recovery procedure before retrying. After a successful
but harmful migration, prefer a reviewed forward repair.
If authorized PITR is required, pause writers and coordinate **both** consumers,
verify the recorded timestamp is eligible, and use the provider's documented
restore procedure (Neon branch restore or PlanetScale backup/restore). Restore can overwrite all databases on the branch and lose later
writes; retain the prior branch as required by that procedure. Reconcile bot,
queues and external side effects separately. Do not run an unreviewed down
migration or assume restoring the Worker restores the database.

**Staging deploy integration:** `deploy.yml` applies the staging web migrations
itself: `plan`, the exact-SHA CI re-check,
`apply` and `verify` run in the `deploy-staging` job (Environment `staging`, which
holds `NEON_STAGING_DATABASE_URL`) after `npm run check` and before the first
Cloudflare mutation, so new code never meets the old staging schema and a failed
or lock-blocked migration leaves the previous Worker serving. It does not call
`db-migrate.yml`: a reusable-workflow job would check out main's tip instead of the
CI-verified SHA and would run before the test suite. The steps are hard-wired to
`MIGRATION_TARGET=staging` and never see `PRODUCTION_DATABASE_URL` or
`PRODUCTION_DEPLOY_ENABLED`; they share the DB advisory lock with `db-migrate`
(an in-flight hand-dispatch makes the deploy fail with "Another web migration
holds the database lock"; re-run the deploy after it finishes). The `staging`
Environment has no required reviewers, so this adds no second approval. Because
a migration can commit and a later step still fail, migrations must stay
backward-compatible (expand/contract) with the Worker they precede. Rollback:
revert the PR; `db-migrate.yml` stays dispatchable by hand. Never couple
production apply to a Worker deploy or enable that by merging schema SQL.

**Local/CI proof (no Neon/API calls):** `npm run db:migrate:selftest` uses only
`agent-testdb` (`agent_test`, empty password) or the Actions Postgres service.
It creates UUID-owned test databases, uses stub Environment URLs, and drops only
those databases in `finally`. CI supplies `MIGRATION_TEST_DATABASE_URL` for its
throwaway Postgres. It proves production refusal (including the actual workflow
shell gate), target/ref/URL isolation, read-only planning, fresh and partial
apply, Drizzle-ledger compatibility, repeat no-op, history drift/newer/gaps,
locking (including termination of only its own migration backend while a second
fixture connection takes the lock), transactional rollback of ledger setup,
PITR timestamp recording, error redaction, normalized driver options and hostile
ambient `PGPORT`. It never falls back to a remote URL; any non-test endpoint is
refused before connecting.

Sources: [GitHub Environment protection and secrets](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[Drizzle migration semantics](https://orm.drizzle.team/docs/migrations),
[Drizzle PostgreSQL ledger format](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/dialect.ts),
[postgres.js transactions](https://github.com/porsager/postgres#transactions),
[PostgreSQL advisory-lock lifetime](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS),
[Neon branch restore and constraints](https://neon.com/docs/introduction/branch-restore).

### Worker rollback

Use the explicit known-good version recorded before the release. Do not accept
Wrangler's implicit previous-version default in a concurrent release incident.
Keep required resources/bindings in place; never delete a queue to roll back.

#### Production (one-click workflow)

[.github/workflows/rollback-production.yml](../.github/workflows/rollback-production.yml)
is the one-click production rollback: Actions → `rollback-production` → Run
workflow, branch `main`, `version_id` set to the recorded known-good Worker
Version ID. It reuses the same request gate
(`workflow_dispatch` on `main`, `PRODUCTION_DEPLOY_ENABLED` exactly `true`),
the same `production` Environment approval (required reviewers, no
self-review) and the same production-only Cloudflare credentials as a deploy,
then runs `wrangler rollback <version_id> --name two-web-next-production`
followed by the same `/up` smoke. The `version_id` input must be a lowercase
Worker Version UUID and travels inputs → `env:` only, never through
expression interpolation in a shell block. A rollback does **not** undo
Postgres migrations, data writes, Discord side effects, queue messages or
external-resource changes; keep the release workflow from redeploying the bad
head. Record the rollback deployment and previous/current version IDs.

#### Staging (manual)

```bash
(
  set -euo pipefail
  # REMOTE MUTATION: run only after the incident's rollback decision.
  read -r -p 'Recorded known-good Worker version ID: ' GOOD_VERSION
  : "${GOOD_VERSION:?A recorded Worker version ID is required}"
  npx --no-install wrangler rollback "$GOOD_VERSION" --name two-web-next
  npx --no-install wrangler deployments status --name two-web-next --json
)
```

Wrangler prompts for confirmation; the rollback becomes active on all this
Worker's routes/domains. Then prove the target is live: `curl -fsS
https://next.togetherweown.com/up` must show `revision.version_id` equal to
`$GOOD_VERSION` (a Version uploaded before the marker existed reports no
`revision`; use the `deployments status` output for it). It does **not** undo Postgres migrations, data writes,
Discord side effects, queue messages or external-resource changes. Check schema
compatibility first; keep the release workflow from redeploying the bad head.
Record the rollback deployment and previous/current version IDs. Do not claim a
rollback was rehearsed unless there is an execution receipt; the staging
receipt is in the rehearsal record below.

Official references: [Wrangler rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback)
and [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#limits)
(last 100 published versions; resource/class-lifecycle changes can prevent it).

### Staging rehearsal: Worker rollback and DNS flip-back

Staging only: host `next.togetherweown.com`, Worker `two-web-next`. Never run
these steps against `togetherweown.com`, `www` or `two-web-next-production`;
the production flip belongs to the W17 cutover card. Every command marked
REMOTE MUTATION changes staging traffic for about 10 seconds.

Credentials stay in the environment, never on argv. The rollback half needs
Workers Scripts edit (`CLOUDFLARE_API_TOKEN`). The DNS half also needs Zone
DNS edit on `togetherweown.com` plus Workers custom-domain edit (`CF_TOKEN`
below). The deploy token has **no** DNS edit: on 2026-10-02 a record create
returned `10000 Authentication error`. The DNS token needs both scopes: a token
with Zone DNS edit only passes the record calls and returns the same `10000`
on every `/accounts/*/workers/domains` call (seen 2026-10-03), so steps 10 and
12 cannot run. On any such error, stop and use the `Operator:` card; do not
try another token.

Shared helpers for one shell session (`RUN_DIR` is a private scratch
directory; `cfapi` reads its token from `CF_TOKEN` and fails on API errors):

```bash
export RUN_DIR="$(mktemp -d)" CF_ACC="<account id>" CF_ZONE="<togetherweown.com zone id>"
# CF_ACC: the 32-hex id in the table printed by `npx --no-install wrangler whoami`.
# CF_ZONE: only the DNS half below needs it.
cfapi() { # usage: cfapi METHOD PATH [JSON]
  node -e 'const [m,p,b]=process.argv.slice(1);
    fetch("https://api.cloudflare.com/client/v4"+p,{method:m,body:b,headers:{
      authorization:"Bearer "+process.env.CF_TOKEN,"content-type":"application/json"}})
    .then(r=>r.json()).then(d=>{if(!d.success){console.error(JSON.stringify(d.errors));process.exit(1)}
      console.log(JSON.stringify(d.result))})' "$@"
}
probe() { # about one line per 1.3 s: epoch-ms, /up status, X-TWO-Origin (blank if absent), DISC_PATH status
  # DISC_PATH: a public path whose status differs between N and N+1 (step 2); /up if none does.
  local i=0
  while :; do
    i=$((i + 1))
    printf '%s %s %s\n' "$(date +%s%3N)" "$(curl -s -o /dev/null -D - --max-time 5 \
      "https://next.togetherweown.com/up?rehearsal=$i" | tr -d '\r' |
      awk 'NR==1{s=$2} tolower($1)=="x-two-origin:"{o=$2} END{print s, o}')" \
      "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "https://next.togetherweown.com${DISC_PATH:-/up}?rehearsal=$i")"
    sleep 1
  done
}
served_versions() { # usage: served_versions FROM_MS TO_MS -> version switches, oldest first
  CF_TOKEN="$CLOUDFLARE_API_TOKEN" cfapi POST "/accounts/$CF_ACC/workers/observability/telemetry/query" \
    "{\"queryId\":\"rehearsal\",\"view\":\"events\",\"limit\":100,\"timeframe\":{\"from\":$1,\"to\":$2},
      \"parameters\":{\"filters\":[{\"key\":\"\$metadata.service\",\"operation\":\"eq\",
      \"type\":\"string\",\"value\":\"two-web-next\"}]}}" |
  node -e 'const e=JSON.parse(require("fs").readFileSync(0)).events.events
      .map(x=>[x.timestamp,x.$workers?.scriptVersion?.id]).sort((a,b)=>a[0]-b[0]);
    let p;for(const[t,v]of e)if(v!==p){console.log(new Date(t).toISOString(),v);p=v}
    console.log("events",e.length)'
}
```

The telemetry query returns only the newest 100 events. Keep each window to
40 seconds or less while one probe runs, and check the event count.

**Worker rollback (N+1 to N and back)**

1. Obtain a confirmed exclusive staging deploy/migration hold before any
   rehearsal mutation. The DevOps & Reliability Engineer coordinates the
   staging release owner and authorized migration/import operators: they must
   hold automatic and manual staging deploy admission and schema/import writes,
   and confirm that queued or active staging deploy/migration work has reached
   a safe disposition. Do not casually cancel an in-flight migration/DDL.
   Record each owner's acknowledgement, effective hold mechanism, target,
   start/end window and release procedure in the drill receipt. A merge freeze
   alone does not exclude already queued work. If the hold cannot be confirmed,
   stop; a quiet Actions page or historical workflow runtime is not exclusion.
   The observed nine-minute deploy lead time is not a lock or a minimum runtime.
   Keep the hold through DNS steps 8–14 and final state verification, not just
   the Worker half: a staging deploy can reclaim the same custom domain during
   the DNS flip. With the authorized DNS operator, re-confirm it immediately
   before each rollback/roll-forward mutation and each DNS mutation. If it lapses
   or another deploy, migration or schema change appears, stop further drill
   mutations and follow
   the [collision response](cutover-rollback.md#staging-collision-response), not an automatic
   restoration to the captured version. Record the live version, bindings and
   applied schema/journal identity from authorized release/migration evidence
   before selecting N; source-file compatibility alone does not prove live
   schema compatibility.
2. Save `npx --no-install wrangler deployments list --name two-web-next --json`
   as `$RUN_DIR/dep-before.json`. It returns only the 10 newest deployments, so
   N must be among them. N+1 is the active version. The previous deployment is
   the default N, but adjacent versions are often code-identical: any merge
   redeploys, including workflow-only and e2e-only changes. Then only
   telemetry can tell N from N+1. Prefer the newest N whose source differs on
   a public route (`git diff --stat "$N_SHA" "$N1_SHA" -- src public`) and
   that has no migration or binding drift
   (`git diff --exit-code "$N_SHA" "$N1_SHA" -- drizzle migrations.lock ci/neon-migrate.mjs wrangler.jsonc`).
   Set `DISC_PATH` to a public path whose status differs between N and N+1.
   When both versions were deployed with the `/up` revision marker, read
   `revision.version_id` from `/up` instead: it names the serving version
   directly and needs no discriminator.
   Map each version to its commit using the same deploy job's checkout
   `ref`/`HEAD`, the successful `Staging gate passed: <sha>` immediately before
   deployment, and the `Current Version ID:` from `Deploy to Cloudflare
   Workers`. A deployment's `created_on` near that step's `completed_at`
   (Actions jobs API) helps locate the job, but is not source proof alone.
   For a `workflow_run` deploy, the run's `head_sha` can be main's newer tip;
   printed `GITHUB_SHA` values can also vary by step and are not checkout
   receipts. If checkout, gate SHA and version cannot be correlated, do not
   guess the source. Deploys are not tagged yet.
3. Baseline: `node bin/smoke.mjs https://next.togetherweown.com | tee "$RUN_DIR/smoke-base.log"`.
   Record any existing failures. The rehearsal compares against this
   baseline; it does not require it to be green.
4. In a second terminal, start the probe loop:
   `probe | tee "$RUN_DIR/probe-rollback.log"`.
5. Roll back, with timestamps:

   ```bash
   (
     set -euo pipefail
     : "${N_VERSION:?}"
     # REMOTE MUTATION: staging Worker only.
     echo "T0 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
     npx --no-install wrangler rollback "$N_VERSION" --name two-web-next \
       -m "staging rollback rehearsal" -y
     echo "T1 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
   )
   ```

6. Prove that N serves. After 50 to 60 seconds, run
   `served_versions $((T0 - 4000)) $((T0 + 36000))`, then a second window
   that starts 36 seconds after T0. Record three intervals from T0: the first
   request served by N, the point after which no N+1 request appears
   (settled), and the number of non-200 probes. The probe's `DISC_PATH`
   column shows the same switch from plain HTTP. A window that returns exactly
   100 events hit the cap and can lose its oldest requests; check that the
   switch is still inside it. Then run N's own smoke; the
   HEAD smoke can expect an `/up` shape that N does not have yet:

   ```bash
   (
     set -euo pipefail
     : "${N_SHA:?}"
     mkdir -p "$RUN_DIR/n" && git archive "$N_SHA" bin ci | tar -x -C "$RUN_DIR/n"
     node "$RUN_DIR/n/bin/smoke.mjs" https://next.togetherweown.com | tee "$RUN_DIR/smoke-n.log"
   )
   ```

   Run `served_versions` over the smoke window. Every event must show N.
7. Re-confirm the hold and unchanged live schema/bindings before rolling
   forward with `wrangler rollback "$N1_VERSION"` (the same block as step 5).
   If any intervening release/schema change is detected, stop and follow the
   collision response instead. Otherwise prove N+1 the same way and repeat
   the step 3 smoke; the result must match the baseline. After each mutation,
   save `wrangler deployments list --name two-web-next --json` and record the
   resulting deployment ID (not version ID), target allocation and message.
   Save the final list as `$RUN_DIR/dep-after.json`. The `-m` text is stored in
   the deployment's `annotations["workers/message"]`; the version itself shows
   `Message: -`.

   Compare `dep-before.json` and `dep-after.json` by deployment ID: the new
   IDs must be exactly the two recorded rehearsal deployment IDs, with the
   expected N and N+1 allocations and no other new deployment in the drill
   window. Overlapping entries must retain their recorded timestamps and
   version allocations. Allow oldest entries to roll off the ten-entry
   history window; their eviction is not a collision. For example, ten entries
   before plus two new deployments leaves eight overlapping entries and two
   oldest evictions afterward, not a four-deployment collision. Do not use a
   whole-list or symmetric-difference comparison. Unexpected new IDs or changed
   overlapping entries invalidate the drill and invoke the collision response.
   Missing expected IDs or insufficient overlapping history makes the check
   inconclusive, not pass: stop and ask the release owner for retained history.
   Confirm N+1 at 100% and unchanged schema/bindings, but do not release the hold:
   it must cover the DNS half and final verification in steps 8–14.

**DNS flip to the legacy target and back**

8. Re-confirm the same hold before the DNS snapshot, including the authorized
   DNS operator's acknowledgement that the remaining window covers flip,
   restoration and final checks. No confirmed hold means no DNS drill. For a
   DNS-only drill after a separately completed Worker half, acquire a fresh hold
   with the step 1 owners/mechanisms before this snapshot. Capture the current
   serving version as N+1 and its allocation/live schema/bindings as that drill's
   restoration baseline; do not reuse an earlier drill's pointer or baseline.
   Record the starting state and the legacy target:

   ```bash
   (
     set -euo pipefail
     cfapi GET "/accounts/$CF_ACC/workers/domains?hostname=next.togetherweown.com" | tee "$RUN_DIR/cd-before.json"
     cfapi GET "/zones/$CF_ZONE/dns_records?name=next.togetherweown.com" | tee "$RUN_DIR/dns-before.json"
     cfapi GET "/zones/$CF_ZONE/dns_records?name=staging.togetherweown.com" | tee "$RUN_DIR/legacy.json"
   )
   ```

   Expect one custom domain (`service` `two-web-next`) and one read-only
   proxied `AAAA 100::` record owned by the Worker. Set `CD_ID`,
   `LEGACY_A` and `LEGACY_AAAA` from these files. The legacy records are
   proxied with `ttl` 1 (auto).
9. Run `probe | tee "$RUN_DIR/probe-dns.log"` in the second terminal. The
   signal is the `two-web-next` marker on `/up`, which only Next sends.
10. Re-confirm the hold and unchanged Worker allocation/schema/bindings before
    the DNS mutation; if exclusion or compatibility has changed, stop and use
    the collision response. Flip to legacy. Between the calls the host has no
    record, so keep them in one block:

    ```bash
    (
      set -euo pipefail
      : "${CD_ID:?}" "${LEGACY_A:?}" "${LEGACY_AAAA:?}"
      rec() { printf '{"type":"%s","name":"next.togetherweown.com","content":"%s","proxied":true,"ttl":1,"comment":"staging flip-back rehearsal"}' "$1" "$2"; }
      # REMOTE MUTATION: staging host only.
      echo "D0 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
      cfapi DELETE "/accounts/$CF_ACC/workers/domains/$CD_ID"
      cfapi POST "/zones/$CF_ZONE/dns_records" "$(rec A "$LEGACY_A")"
      cfapi POST "/zones/$CF_ZONE/dns_records" "$(rec AAAA "$LEGACY_AAAA")"
      echo "D1 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
    )
    ```

11. Record the time from D0 to the first probe without the marker, and to the
    start of 10 consecutive probes without it. Also record the status that
    the legacy edge returns. Legacy Traefik has no router for `next.*`, so a
    404 or 5xx is expected and is not an app failure. On the 2026-10-03 run
    the Cloudflare edge answered **522** on `/up` and `/` (the connection to
    the legacy origin timed out; the cause was not established), with
    intermittent 503s in the window. Loss of the `two-web-next` marker, not
    the legacy status, is the flip signal. For production, see "Before the
    production flip" below.
12. Re-confirm the hold and unchanged Worker allocation/schema/bindings before
    restoration, including before the fallback below. If exclusion or live
    compatibility has changed, stop and use the collision response rather than
    blindly reclaiming the domain. Otherwise flip back: delete the rehearsal
    records, then re-attach the custom domain:

    ```bash
    (
      set -euo pipefail
      # REMOTE MUTATION: staging host only.
      echo "B0 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
      cfapi GET "/zones/$CF_ZONE/dns_records?name=next.togetherweown.com" |
        node -e 'for (const r of JSON.parse(require("fs").readFileSync(0)))
          if (r.comment === "staging flip-back rehearsal") console.log(r.id)' |
        while read -r id; do cfapi DELETE "/zones/$CF_ZONE/dns_records/$id"; done
      cfapi PUT "/accounts/$CF_ACC/workers/domains" \
        "{\"hostname\":\"next.togetherweown.com\",\"service\":\"two-web-next\",\"environment\":\"production\",\"zone_id\":\"$CF_ZONE\"}"
      echo "B1 $(date +%s%3N)" | tee -a "$RUN_DIR/times"
    )
    ```

    If the `PUT` fails, `npx --no-install wrangler triggers deploy` re-applies
    the custom domain from `wrangler.jsonc` without uploading code. If that
    also fails, staging has no record: escalate on the incident card at once.
13. Record the time from B0 to the first probe with the marker, and to the
    start of 10 consecutive probes with it. Repeat the step 3 smoke; it must
    match the baseline.
14. Read back as in step 8. Expect exactly one custom domain attached to
    `two-web-next` and only the Worker's read-only record, matching the saved
    DNS/custom-domain baseline except that the custom-domain ID can change.
    Confirm N+1 at 100%, prove the serving version with the `/up` revision marker
    or telemetry as in steps 2/6, and verify unchanged live schema/bindings against
    the baseline using authorized release/migration evidence. Unexpected drift
    or inconclusive evidence invokes the collision response; do not declare pass
    or release exclusion based only on the returned Next marker or smoke.
15. Only after step 14 confirms DNS/custom-domain restoration, the serving
    version, allocation and unchanged live schema/bindings may the authorized
    owners release the hold. Record their release acknowledgements and time in
    the receipt. If verification cannot complete within the held window, stop
    drill mutations and coordinate a safe disposition/hold extension with those
    owners; expiry is not a successful release or automatic recovery authority.
16. Post the timings, version IDs, smoke results and discrepancies on the W16
    card, and keep `$RUN_DIR` until the card is closed.

Rehearsal record:

| Date (UTC) | Step | Command | First request on target | Settled | Non-200 probes |
|---|---|---|---|---|---|
| 2026-10-02 00:53 | rollback `62871bf4` (8cb9cff) to `60663623` (0515ef4) | 5.2 s | +8.9 s | +12.3 s | 0 of 150 |
| 2026-10-02 00:55 | roll forward `60663623` to `62871bf4` | 5.5 s | +6.6 s | +10.7 s | 0 of 90 |
| 2026-10-03 16:35 | rollback `81da0f67` (c07ad6b) to `cd470835` (4b12bef, five deployments back) | 4.4 s | +5.1 s | +5.1 s | 0 of 48 |
| 2026-10-03 16:36 | roll forward `cd470835` to `81da0f67` | 4.0 s | +6.0 s | +8.6 s | 0 of 42 |
| 2026-10-03 18:25 | DNS flip `next.*` to legacy (custom domain deleted, `A`/`AAAA` to legacy added) | 1.6 s | +1.2 s (first probe without the marker) | +11.2 s (10 consecutive without it) | legacy edge answered 522 and intermittent 503, not 200 |
| 2026-10-03 18:25 | DNS flip back (records deleted, custom domain re-attached) | 2.1 s | +3.2 s (first probe with the marker) | +14.7 s (10 consecutive with it) | n/a (smoke result in the notes below) |
| 2026-10-03 20:36 | rollback `59a88ba7` (331122e5) to `da612f07` (bfbaf4d5) | 3.7 s | +4.5 s (last 301 at +1.6 s, first 404 at +4.5 s) | +4.5 s, no alternation | 0 of 137 (both directions) |
| 2026-10-03 20:37 | roll forward `da612f07` to `59a88ba7` | 3.8 s | +9.6 s (last 404 at +8.2 s, first 301 at +9.6 s) | +9.6 s, no alternation | see above |
| 2026-10-04 08:51 | rollback `2e803af9` (487ef4a4) to `44878468` (4c65217e) | 4.7 s | +5.6 s | +5.6 s | 0 of 100 |
| 2026-10-04 08:52 | roll forward `44878468` to `2e803af9` | 3.8 s | +5.5 s | +5.5 s | see above |

Notes from the 2026-10-04 run (probe cadence about 1.3 s; both directions in
one probe loop, 100 probes, none non-200; the whole Worker half took 136 s):

- N+1's source is `487ef4a4`: [deploy run 455, job 111399209102](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37189725072/job/111399209102)
  checks out that `ref`/`HEAD`, logs `Staging gate passed: 487ef4a4…` at
  08:50:28 UTC immediately before deployment, and logs version `2e803af9`
  at 08:50:34 UTC. The run's API `head_sha` (`72c4f435`) and migration-step
  `GITHUB_SHA` environment lines are not source receipts.
- N was the newest deployment whose Worker code differs from N+1: it predates
  the dependency bump (#409) and the numeric `tabindex` change (#469). The
  other 5 of the 7 commits between them change workflow, test or backup files
  only. `/up` returns 200 on both and no public path has a status that
  differs, so only telemetry (`$workers.scriptVersion.id`) shows which version
  served. It shows one switch in each direction and no alternation: first N
  request at +5.6 s, first N+1 request after the roll forward at +5.5 s.
- `ci` was running on `main` for the next commit while the drill ran; no
  `deploy` run was active. The deployment list gained `a58f67e3` and
  `77c4c9b9` only and ended on `2e803af9` at 100%, so the narrower idle rule
  in step 1 held.
- Telemetry lags the request. A window queried 4 s after N's own smoke returned
  0 events; the same window queried about 3 minutes later returned 49 events, all
  N. Query the smoke window at least 60 s after the smoke, or re-query it.
- The smoke now covers 17 routes (`/__smoke_unknown_route__` was added). It
  passed 17 of 17 on N+1 before, on N with N's own `bin` and `ci`, and on
  N+1 after the roll forward.
- `wrangler queues info` (read-only) on `two-sync-event` and
  `two-internal-action` showed one producer and one consumer each, both
  `worker:two-web-next`. Staging `/up` reported `queue.failed` 161 and an
  oldest pending message of 9.7 hours; it stays `healthy` under the thresholds.
- The DNS half was not re-run; it was rehearsed on 2026-10-03 at 18:25 (rows above).

Notes from the 2026-10-03 20:36 run: the discriminator was the plain-HTTP
status of `/events/01arz3ndektsv4rrffq69g5fab.ics` (301 on `59a88ba7`, 404 on
`da612f07`); the only source difference between the two was the lowercase-ULID
redirect fix, with no migration, binding or `wrangler.jsonc` drift. Smoke
passed 16 of 16 on `59a88ba7`, on `da612f07` (its own smoke) and on `59a88ba7`
again. Telemetry windows hit the 100-event cap, and on the roll forward they
showed the versions alternating for about 4 s while the discriminator probe saw
one switch. The first rollback attempt used a mistyped version ID and failed
closed (`100146`, no deployment created); the retry used the full ID from
`deployments list`. The Worker ended on `59a88ba7` at 100%.

Notes from the 2026-10-03 18:25 DNS run (token with Zone DNS edit and account
custom-domain edit; only `next.togetherweown.com` was touched):

- The marker disappeared 1.2 s after the flip and 10 consecutive probes
  without it took 11.2 s; the way back took 3.2 s and 14.7 s. The flip back
  restored the same custom-domain ID (step 14 still says it can change).
- The custom-domain `DELETE` returns an empty body, so a helper that parses
  JSON logs a parse error. The delete still took effect: the marker was lost
  and the legacy records served.
- The legacy `staging.*` origin did not answer `next.*` with a Traefik 404.
  It answered 522 (and intermittent 503) at the Cloudflare edge. The
  rollback timing stands because marker loss was detectable regardless.
- The zone was clean afterwards: one custom domain and the Worker's read-only
  `AAAA 100::` record. Smoke was 16 of 16 before and after.

Notes from the 2026-10-03 16:35 run (probe cadence about 1.3 s; both directions in one
probe loop, 95 probes in all, none non-200):

- N was five deployments back because the adjacent one (`4bac3ea9`, 39b2965)
  differed from N+1 only in e2e and workflow files, which is the same Worker
  code. `cd470835` predates the lowercase-ULID `/e/:key` redirect, so the
  probe path `/e/01abcdefghjkmnpqrstvwxyz12` returned 404 on N and 301 on
  N+1. That showed the serving version from plain HTTP, not only from
  telemetry. No migration, binding or `wrangler.jsonc` difference separated N
  and N+1.
- Rollback switched once, with no alternation between versions. The
  probe saw its last 301 at +3.6 s and its first 404 at +4.9 s. The roll
  forward alternated for 2.6 s (+6.0 s to +8.6 s) before only N+1 served;
  the probe saw its last 404 at +4.3 s and its first 301 at +5.7 s. Both 40
  second telemetry windows returned exactly 100 events, the cap, with the
  switch still inside them.
- The baseline smoke on N+1 passed 16 of 16 routes (the 2026-10-02 `/events*`
  500s are gone), N's own smoke passed 16 of 16 on N, and the HEAD smoke passed 16 of
  16 after the roll forward. Every telemetry event in the N smoke window
  showed N.
- Both rollbacks ran non-interactively with `-y` ("Using fallback value in
  non-interactive context: yes") and created deployments `d252c38a` and
  `2698ae3d`. `dep-before.json` and the final list differ only by those two,
  so no merge deploy landed in the window. The Worker ended on `81da0f67`
  at 100%, the pre-rehearsal version. The whole Worker half took 134 s
  (baseline smoke to final smoke) with 50 s settle waits.
- `deployments list` and `versions list` both return only 10 entries.
- The DNS half was not run in this window. It was rehearsed later the same
  day, at 18:25 UTC (rows above).

Notes from the 2026-10-02 run:

- Both versions send the same `/up` marker, so only telemetry
  (`$workers.scriptVersion.id`) proves which version served a request.
  Requests from one client alternated between versions for about 4 seconds
  before they settled.
- The HEAD smoke failed the same 9 assertions on both versions: `/events`,
  `/events.rss` and `/events.ics` returned 500, and `/up` lacked the fields
  that HEAD expects. N's own smoke passed `/up` and failed only the 8
  events assertions. The failures were present before the rehearsal.
- For proxied records, resolvers only ever receive Cloudflare anycast
  addresses (`ttl` 1, auto). The DNS flip therefore depends on how fast
  Cloudflare applies edge configuration, not on resolver TTL expiry.

## Final import and reconcile

Cutover plan step 2: the final legacy import into production Neon, with the
reconcile report. Run it under the write freeze
([cutover-freeze.md](cutover-freeze.md) in force), with legacy writes paused
and the import destination quiescent. Both snapshots in this section are
production mutations through the authorized operator procedure; the steps
below name only environment variable **names**, never values. Credentials
stay in the environment, never on argv.

Ordered commands (one shared fixed cutoff for every importer and the
verifier; the importers derive it from the same retention window):

```bash
# 1. Snapshot order: users/profiles, events/RSVPs, content/funnel, audit.
node bin/import/users-profiles.mjs --apply
node bin/import/events-rsvps.mjs --apply
node bin/import/content-funnel.mjs --apply
node bin/import/audit.mjs --apply   # add --enable-grants only after admission review
# 2. Reconcile what the importers wrote.
node bin/import/verify.mjs --cutoff <ISO-UTC> --json verification.json --markdown verification.md
```

Connections come only from `LEGACY_DATABASE_URL` and `DATABASE_URL`. The
content/funnel and audit importers also read `LEGACY_DATABASE_SCHEMA` and
`DATABASE_SCHEMA` when the legacy snapshot and the Next schema differ.
`--dry-run` previews with no writes; `--apply` is the only write mode.

Exit codes:

| Exit | Meaning | Operator action |
| --- | --- | --- |
| 0 | Complete match for the configured projection | Proceed to the next cutover step |
| 1 | Data diff or incomplete mapping | Stop. Triage by named key (`missingKeys`, `extraKeys`, `mismatchKeys`, `mappingGaps`); repair with a same-key importer re-run where the update rules permit, or with separately approved backup/repair recovery |
| 2 | Configuration, connection, query or output error | Stop. Fix the tool invocation or environment, then re-run |

Caveat: once traffic starts, rows created natively on Next appear outside
the imported set (`legacy_id IS NOT NULL` on the Next side), never as
extras. Stop rule: a re-run is not an undo — it repairs same-key values
only where the importer update rules permit
([cutover-rollback.md row 4](cutover-rollback.md#production-cutover-capability--reverse-map)).
Wrong identities or keys, extra rows and lost overwritten state need
separately approved backup/repair recovery under writer holds. Archive the
counts-only `verification.json` / `verification.md` with the cutover
evidence; the reports carry keys and counts, never row values.

### Before the production flip

The production rollback is this same flip back to legacy, so the legacy origin
must be able to serve the apex when needed. Staging answered 522, which does
not prove production will. Before the flip, record the legacy record set for
the apex and `www`, and confirm that the apex answers 200 on `/` and `/up`
from legacy. The before-phase gate asserts the apex `/up` identity
(`X-TWO-Origin: two-web`, see [cutover-check.md](cutover-check.md#phase-contract-and-prerequisites));
a 522 or other 5xx from the legacy origin, or a missing marker, means the
rollback path is not proven and the flip does not start.

## 48h post-flip watch

The cutover is not done at the DNS flip: the new site stays under a 48h
watch with the freeze in [cutover-freeze.md](cutover-freeze.md) in force
until the watch exits. Everything in this section is read-only or GET-only:
no production writes, migrations, credential changes or queue purges. Any
Sev-1 goes to containment below and the production rollback pointer, never
to a live fix or a credential swap.

**What to check:**

- Pager: `error.alert` / `queue.failing` delivery for the whole 48h, per
  [runbook-alerts.md](runbook-alerts.md) (redacted Tail receipts; source
  traces stay the diagnostic fallback).
- `GET /up` on the apex: HTTP 200 with `db:ok`, `pending_migrations:0` and
  the existing queue envelope, the same readiness bar as the production
  deploy smoke in
  [.github/workflows/deploy-production.yml](../.github/workflows/deploy-production.yml).
- `node ci/cutover-check.mjs --phase after --target togetherweown.com --json`
  (the [after gate](cutover-check.md#phase-contract-and-prerequisites)):
  unauthenticated, GET-only, no database client. OAuth start/callback
  routes can record throttles, so run it only inside this watch, never as
  a casual probe.
- Lighthouse against the production origin once within 24h, held to the
  repo thresholds in [ci/lighthouserc.cjs](../ci/lighthouserc.cjs) (LCP,
  CLS, server response time); thresholds are never relaxed to turn a
  build green.
  Run `npm run lighthouse:origin -- https://togetherweown.com` or
  dispatch the [watch-lighthouse](../.github/workflows/watch-lighthouse.yml)
  workflow with the origin choice; both are GET-only and take the budgets
  from `ci/lighthouserc.cjs`. A Chrome harness crash (no assertion
  result) is rerun once, never read as a pass.
- Playwright GET-only guest journeys (homepage, static leaves, events
  list, one published event, robots/sitemap): no sign-in, no RSVP, no
  join, no writes of any kind.
  Run them with the dispatch-only
  [watch-guest-journeys](../.github/workflows/watch-guest-journeys.yml)
  workflow (`npm run e2e:watch`, origin pinned by `WATCH_ORIGIN`; a non-GET
  request is aborted and fails the run), never from a controller.

```bash
(
  set -euo pipefail
  curl -sS --max-time 10 https://togetherweown.com/up
  node ci/cutover-check.mjs --phase after --target togetherweown.com --json
)
```

**Cadence:** pager continuously; `/up` every 15 minutes for the first 4h,
then hourly; the full after-gate at flip+1h, +24h and +48h; Lighthouse and
the GET-only journeys once within the first 24h.

**Exit criteria:** 48h elapse with no Sev-1 — no pager storm, `/up` 200
with `db:ok` and zero pending migrations throughout, after-gates green,
Lighthouse and guest journeys within budget. The DevOps & Reliability
Engineer records the exit on the cutover card and lifts the freeze there.

**On a Sev-1** (pager storm, `/up` non-200 or `db:error`/pending nonzero,
a red after-gate, or member-visible breakage): contain per the queue and
outage sections above, then roll back with the one-click
[rollback-production](../.github/workflows/rollback-production.yml)
workflow to the version ID recorded before the release. A Worker rollback
does not undo schema, data or Discord side effects. The 48h clock restarts
after the re-flip.

## Read `/up` without mistaking liveness for readiness

`/health`, `/healthz` and `/db-ping` are **retired**, unregistered diagnostic
paths: GET returns ordinary **404**, not health or DB evidence. The generic 404
page may try optional event suggestions and tolerates their DB failure; it is
not a DB-free diagnostic. See [retired-route fixtures](../test/db-ping.test.ts).

`GET /robots.txt` is DB-free and can check local Worker startup; it does not
prove deployment readiness.
`GET /up` is **readiness**: a required-secret presence check, a read-only DB
ping and web migration-ledger read, plus the unchanged queue object. It has `Cache-Control: no-store`, no session/auth
lookup, and no cookies. No migration is run or repaired by this endpoint.

On staging only, a ready or failing body also carries
`revision: { version_id, commit }` from the `version_metadata` binding
`CF_VERSION_METADATA`. It is informational and never changes the HTTP status.
`version_id` is the Worker Version ID (the `wrangler rollback` argument).
`commit` is the version tag, shown only when it is a full lowercase 40-hex SHA
and `null` otherwise, so an arbitrary manual tag never reaches the public body.
`node bin/revision-check.mjs <origin> [<sha>]` reads it: with a SHA it fails
unless that commit is live, without one it only logs what is live.

DB/schema readiness uses the web stores' `databaseUrl()` selection: nonempty
`DATABASE_URL`, otherwise `DB.connectionString`. If that selected database fails,
readiness fails; it never substitutes the other target. The queue retains its
existing `DB.connectionString ?? DATABASE_URL` selection. When both reads select
the same URL, they share a two-slot client; otherwise each uses a one-slot client
and is independently measured and cleaned up within the same response deadline.

The journal (`drizzle/meta/_journal.json`) is embedded in the Worker at build
time. Only web tags `1000–1999` are checked against exact `created_at` timestamps
in `drizzle.__drizzle_migrations`; bot rows and grandfathered `0000/0001` tags do
not participate. A newer bot row or later web row cannot hide an earlier missing
web migration. An empty ledger counts all bundled web migrations as pending; a
missing, unreadable or malformed ledger reports `null`, never a false zero.
Volatile `clock_timestamp()` in both DB queries avoids Hyperdrive query caching.

DB ping + ledger share a **3-second response deadline**, running in parallel with
the existing 3-second queue deadline. Each ping, ledger and queue read runs in a
short read-only transaction with transaction-local **1-second statement** and
**750-ms lock** limits. After connection acquisition, these limits shrink to the
remaining response budget (with a 250-ms margin). After timeout setup succeeds,
the installed statement limit must still fit the remaining budget, otherwise
no read starts. This also covers a delayed setup reply, without an unbounded
retry/reset loop. Server limits abort active work even when disconnect alone
would leave a lock-waiting backend. Request-owned clients close without waiting to drain;
injected clients retain their own lifecycle. No session/global settings or
migrations are changed. Exception messages, SQL and credentials are never
returned/logged by this health path.

Sources: [PostgreSQL statement/lock timeouts](https://www.postgresql.org/docs/current/runtime-config-client.html#RUNTIME-CONFIG-CLIENT-STATEMENT),
[Hyperdrive transaction-scoped SET](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/),
[Postgres.js transactions](https://github.com/porsager/postgres#transactions).

| DB/schema outcome | HTTP | `db` | `pending_migrations` | Top-level `status` |
| --- | --- | --- | --- | --- |
| DB reachable, every bundled web migration applied | 200 | `ok` | `0` | Queue-derived `healthy` / `degraded` |
| DB reachable, N web migrations missing | 503 | `ok` | N | `degraded` |
| DB reachable, ledger read fails/times out | 503 | `ok` | `null` | `degraded` |
| No usable DB configuration, failed/hung ping | 503 | `error` | `null` | `degraded` |

**Required secrets.** `SESSION_SECRET`, `DISCORD_CLIENT_SECRET` and
`DISCORD_BOT_TOKEN` must be present and nonempty (whitespace-only counts as
empty). If any is missing, `/up` answers 503 with top-level `status: degraded`
and `config: "missing"`, alongside the DB and queue fields above. The body never
names the secret; the Worker log line `Health check found required Worker
secrets missing.` lists the missing names only, never values. A ready Worker's
body has no `config` key. This is a presence check only: a wrong value still
reports ready and fails at sign-in. Fix by setting the secret (an Operator step
for staging/production), not by weakening the probe.

Queue-only degradation or `unknown` **still returns 200 when DB/schema is ready**:

| Queue ledger outcome | Top-level `status` when DB/schema ready | `queue.status` / measurements |
| --- | --- | --- |
| Read succeeds, `pending < 20` | `healthy` | `healthy`, measured values |
| `pending >= 20` (including `>= 100`) | `degraded` | `degraded`, measured values |
| Read rejects or reaches a server/response limit | `healthy` | `unknown`, all seven measurements `null`, `ready_wait_severity: unknown`, `detail: null` |
| No usable queue client/configuration | `healthy` | `unknown`, measurements `null`, `detail: "queue ledger is not configured."` |

The deploy smoke requires **HTTP 200 + `db:ok` + `pending_migrations:0`** and the
existing queue envelope. HTTP 503 (including pending migrations) fails the deploy;
queue-only `unknown` does not. The workflow's `Apply test migrations` step affects
only disposable CI Postgres, **not the staging schema**. A failed readiness smoke
requires a recorded, authorized staging schema/rollback action, not weakening the
probe or running migrations through `/up`.

Tests use offline fixtures or owned schemas on agent-testdb/CI Postgres. Authorized
staging E2E is allowed after verifying the staging target/binding; never use
production DBs or credentials for tests. The contract is [src/up.ts](../src/up.ts):

```bash
env -u DATABASE_URL -u CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB \
  npm run test -- test/up.test.ts test/deploy-smoke.test.ts \
    test/db-ping.test.ts test/runbook-diagnostics.test.ts
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  npm run test -- test/up-db.test.ts
```

Readiness shipped in [#111](https://github.com/TogetherWeOwn/two-web-next/pull/111)
([`ad22be7`](https://github.com/TogetherWeOwn/two-web-next/commit/ad22be7)); this section
matches main [`eed3c8b`](https://github.com/TogetherWeOwn/two-web-next/tree/eed3c8b8976986d6aeb7f97e1b656d7bbbaf85c7)
(2026-10-02). Source: [Drizzle migration log defaults](https://orm.drizzle.team/docs/drizzle-kit-migrate#applied-migrations-log-in-the-database).

`warn_at: 20` and `critical_at: 100` are reported thresholds; the implementation
has **no separate critical status**. `failed`, `delayed`, `reserved` or `total`
alone do not degrade health. `healthy + unknown` is lack of evidence, not DB
recovery, zero backlog or a drain gate. There is no last-known-good measurement.

Measurements from [src/jobs/postgres.ts](../src/jobs/postgres.ts):

- `pending`: `available_at <= statement_timestamp()` and no reservation. All
  availability/age expressions share the aggregate's statement-start clock,
  not the earlier timeout-setup transaction's `BEGIN` time. See
  [PostgreSQL current-time functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
- `delayed`: future `available_at`; `reserved`: non-null `reserved_at`.
  These can overlap, so their sum need not equal `total`.
- `total`: live ledger rows; `failed`: cumulative failed-history rows, not a
  retryable transport backlog.
- `oldest_pending_age_seconds`: age from **creation**, not latest retry time;
  `null` when no pending rows (or when the entire read is unknown). Kept unchanged
  for parity: a due retry can have an old creation age but a short ready-wait.
- `oldest_ready_wait_age_seconds`: statement time minus the minimum current
  **`available_at`** among due, unreserved rows. Future-delayed and reserved rows
  are excluded, including stale reservations. Fractional seconds are preserved;
  `null` means no runnable ledger rows when the read succeeds, not zero on an
  unreadable ledger. No new schema or migration is needed.
- `ready_wait_severity`: additive operational indicator, **not `queue.status` or
  top-level `status`**. `healthy` when age is `null` or <=300 s; `warning` strictly
  >300 s through 1800 s; `critical` strictly >1800 s; `unknown` when the read is
  unavailable, unconfigured or times out. These age tripwires reuse the
  [48h watch specification](48h-watch-spec.md#queue-depth-and-db-errors), not a new
  pager policy or proof that any alert was delivered. Retained `failed > 0` alone
  never changes this indicator.

Ready-wait is **ledger eligibility age**, not proof of domain-claim eligibility
or Cloudflare consumer progress: the ledger is best-effort and a domain claim can
still fence a due carrier. Measuring health never resets `created_at`, expires
reservations, redrives jobs or discards failures. Investigate with the existing
[queue redrive runbook](queue-redrive-runbook.md), not by deleting old evidence.
Queue-only warning/critical/unknown remains HTTP 200 when DB/schema/config is
ready; deploy smoke and uptime/liveness acceptance are unchanged. This field
neither repairs the queue nor grants staging SQL/redrive or production deployment
permission; existing production approval gates still apply.

## Neon / Hyperdrive outage behavior

Do not remove the binding or inject an alternate credential to mask a configured
outage: **missing configuration is not the same as an unreachable database**.
Web stores, `/up` (DB/schema readiness and its queue slice) and jobs prefer
nonempty `DATABASE_URL`, otherwise `DB.connectionString`
([src/db/connection.ts](../src/db/connection.ts)), so `/up` measures the same
queue ledger the producers and consumer write. Jobs retain `HYPERDRIVE` only as a
legacy fallback when both are absent. A selected connection's construction/read
failure never tries another backend or credential. The removed `/db-ping`,
`/health` and `/healthz` routes are ordinary unknown paths (404), not diagnostics.
A successful public fallback is **not** evidence that private reads or writes are
available; do not relax their authentication, persistence or required-audit gates.
Never test production; staging E2E needs verified staging bindings.

The table describes the path that reaches the relevant operation; validation,
authentication, access gates or static asset handling can return earlier.
Uncaught DB errors use the global **500 HTML** handler, even on event JSON routes.
The [parity matrix](parity.md) is a historical snapshot; current source/tests
below, not its older `/up` row, define these outcomes.

| Route(s) | Configured database outage behavior |
| --- | --- |
| `/about`, `/faq`, `/rules`, `/privacy`, `/robots.txt`, `/join` (GET) | Stay **200**, DB-free. |
| `/up` (GET) | **503** `db:error`, `pending_migrations:null`; queue becomes `unknown`. A reachable DB with unreadable/pending web migrations is also 503 (`db:ok`). |
| `/sitemap_index.xml` (GET) | Stays **200** with static entries; event lookup failure is caught. |
| `/discord`, `/auth/discord` (GET) | Stay **302** to invite / OAuth start, DB-free. |
| `/csp-reports` (POST) | Stays **204**, DB-free sink. |
| `/db-ping`, `/health`, `/healthz` (GET) | **404**, same as unknown paths; optional event suggestions tolerate DB failure. |
| `/` (GET) | Stays **200** with guest fallback on session-store setup/migration/read or rotation failure. Unavailable counts are omitted, events show the unavailable state, and failed featured reads are omitted. Missing DB also serves the guest shell. This does not prove an authenticated session or successful persistence. |
| `/auth/discord/callback` (GET) | Session create/store failure **500**; roster-write-only failure is caught. Invalid state/Discord exchange failure redirects **302** before persistence. |
| `/join/discord`, `/join/callback` (GET) | Configured join-store/throttle/attempt/session errors can be **500**. Discord exchange failure separately gives a **503** recovery page; missing DB uses no-op attempt/throttle stores. |
| `/auth/qa/:identity` (POST) | Enabled/authorized session failure **500**; disabled/bad credential **404**. QA is never a production recovery mechanism. |
| `/logout` (POST) | Store construction/migration failure **500**; once resolved, revoke failure is swallowed and cookie deletion still returns **303**. Server-side revocation is then not proved. |
| `/events`, `/events/past`, `/events.rss`, `/events.ics`, `/events/:key.ics`, `/e/:key` (GET) | Uncaught DB/session failure **500 HTML**; missing event DB **503**. Invalid keys can be **404** before DB access. |
| `/events.json` (GET); `/events` (POST); `/events/:key` (PATCH); publish/cancel (POST) | DB/session failure **500 HTML**; missing event DB **503 JSON**. Auth gates can return **401/403** first. Post-commit enqueue failure leaves normal **201/200**. |
| `/events/:key/rsvp` (PUT/DELETE) | Session/transaction failure **500 HTML**; missing event DB **503 JSON**, auth gates **401/403**. Honeypot decoys are DB-free **201/204**, not successful attendance. Post-commit enqueue failure does not change success status. |
| `/profile`, `/members/:user` (GET); member save (PATCH or form-override POST) | Session resolution failure **503**; subsequent read/save failure **500**. Missing store **503**. Default required access-log failure replaces successful reads with **503**; guest **302**, non-member **403**. |
| Implemented `/admin` routes | Session resolution failure **503**, later resource/dashboard query failure **500**; missing resource DB **503**. Default required access-log failure gives **503**; guest **302**, non-moderator **403**. |
| `/api/agent-events` (POST) | Shared web database (`AGENT_DB` when bound, else `DATABASE_URL`, otherwise `DB`): disabled **404**, enabled without any source **503**, service DB failure **500 JSON** `internal_error` (or **503** `ingress_unavailable` when the database is unreachable). No connection failover. Bot observation failure stays a typed unavailable result; post-commit write-back uses the same optional admin carrier. |

Sources: [src/index.tsx](../src/index.tsx), [join routes](../src/join/route.ts),
[event routes](../src/events/routes.tsx), [profile routes](../src/profiles/routes.tsx),
[admin guard](../src/admin/guard.ts), [admin routes](../src/admin/routes.tsx),
[access logging](../src/access-log.ts), [agent ingress](../src/agent-events/route.ts),
[error handler](../src/errors.tsx). The homepage fallback is already present at
[`eed3c8b`, `src/index.tsx:271–277`](https://github.com/TogetherWeOwn/two-web-next/blob/eed3c8b8976986d6aeb7f97e1b656d7bbbaf85c7/src/index.tsx#L271-L277),
not conditional on an unmerged outage fix. Offline evidence:
[session/event failure fixtures](../test/home-events.test.ts),
[counts failure fixtures](../test/home-counts.test.ts) and
[DB-construction/featured failure fixtures](../test/featured-outage.test.ts).
These are local doubles, not deployed outage acceptance.

Pending [#92](https://github.com/TogetherWeOwn/two-web-next/pull/92), inspected at
[`826e77d`](https://github.com/TogetherWeOwn/two-web-next/commit/826e77d535325624b00d01c2a702d0617f26323a),
adds broader sanitized DB-outage 503 responses, homepage session-unavailable UI
and best-effort logout setup. Those changes are **not shipped in this snapshot**;
retain the current private-route 500/503 distinctions above until it merges.

Shared human throttles and profile throttles fail open on store error; the shared
human throttle currently uses only `DATABASE_URL`, not Hyperdrive. Optional
search-log/widget reads fail open but do not protect primary DB reads. Do not
relax `MEMBER_ACCESS_LOG_ENFORCE` to force a recovery: required logging defaults
to fail closed. Diagnose from redacted platform errors/config metadata; a code
rollback may help a code regression, but cannot repair a Neon outage. Escalate
binding/DB recovery to the Director and authorized custodian; never credential-hop.

## Queue containment, drain and failed-job replay

**Current implementation gate:** [src/jobs/worker.ts](../src/jobs/worker.ts)
sends through the signed bot client (`botClientFor`). An environment without
`BOT_ENDPOINT_URL`, `BOT_KEY_ID` and `BOT_SHARED_SECRET` fails every bot job
terminally (`BotTerminalError`, a `queue.failing` alert, no bot request): queue
depth falling there means terminal failure, not successful draining. Check the
three bindings are present before resuming delivery or replaying real messages;
provisioning them is an Operator step. `event.cancel` is also opt-in on the bot
(`TWO_INTERNAL_ALLOW_EVENT_CANCEL`); without it a cancelled-event sync is a
definitive `action_not_allowed` refusal.

For an authorized queue incident, contain delivery without deleting messages:

```bash
(
  set -euo pipefail
  # REMOTE MUTATION: authorized incident containment, not a test.
  npx --no-install wrangler queues pause-delivery two-sync-event
  npx --no-install wrangler queues pause-delivery two-internal-action
  # Remote transport metadata; ledger counts cannot replace it.
  npx --no-install wrangler queues info two-sync-event
  npx --no-install wrangler queues info two-internal-action
)
```

Pause is reversible but does not stop producers or the scheduled handler.
Coordinate producer/writer holds separately; retained messages remain subject to
Cloudflare queue retention. Do not purge, delete/recreate queues, remove
consumers, or disable cron by an unreviewed config change to hide an incident.
After the implementation gate, holds and downstream readiness are explicitly
cleared, the approved drain starts by resuming the **existing** transport:

```bash
(
  set -euo pipefail
  # REMOTE MUTATION: only after the above gates; NOT safe on today's stubs.
  npx --no-install wrangler queues resume-delivery two-sync-event
  npx --no-install wrangler queues resume-delivery two-internal-action
)
```

Use transport backlog plus redacted delivery/failure evidence to judge draining.
Cloudflare transport and the Postgres ledger are separate: inserting a ledger
row does not send, deleting a row does not drain, resetting `reserved_at` does not
release a transport reservation. Consumer ledger transitions are best-effort
and bounded; old messages without `jobId` are invisible to the ledger. Do not
age-delete old rows or clear unique locks as an outage workaround.

### Inspect failed history safely

`queue_failed_jobs` ([drizzle/1007_queue-ledger.sql](../drizzle/1007_queue-ledger.sql))
has `id`, `job_id`, `kind`, `key`, `reason`, `failed_at` only. It has **no payload
and no original bot idempotency key**. There is no repo replay script,
`queue:retry` command, Wrangler message-send subcommand, or operational mutation
entrypoint. The default-off staging preview at
`GET /admin/queue/failed/:id/preview` supplies read-only one-row advice, not replay
or discard authority. Its activation, dedicated principal, audit and custody
prerequisites are in [queue-redrive-runbook.md](queue-redrive-runbook.md#read-only-runtime-preview-disabled-until-separately-authorized).
The sync-event library remains proved in `test/queue-replay.test.ts`. The operator
inspect-list-redrive loop over these rows lives in
[queue-redrive-runbook.md](queue-redrive-runbook.md) (proved in
`test/queue-redrive.test.ts`). Terminal jobs are
acknowledged, not sent to a configured dead-letter queue (none is configured).
Failed-row deletion is diagnostic cleanup, not a replay or a drain.

These bounded inspection commands target the test database only. Do not change
the connection to staging/production for a test/probe. Real incident data
inspection requires the authorized custodian and incident scope, not this drill:

```bash
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
  PGHOST=agent-testdb PGPORT=5432 PGUSER=agent_test PGDATABASE=two_web_next \
  PGPASSWORD='' PGPASSFILE=/dev/null PGSSLMODE=disable \
  psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT job_id, kind, key, available_at, reserved_at, created_at
FROM queue_jobs ORDER BY created_at, job_id LIMIT 100;
SELECT id, job_id, kind, key, reason, failed_at
FROM queue_failed_jobs ORDER BY failed_at DESC, id DESC LIMIT 100;
SELECT key, expires_at, expires_at > clock_timestamp() AS still_live
FROM job_unique_locks ORDER BY expires_at, key LIMIT 100;
SQL
```

For a replay request, preserve the failure row and open a bounded implementation
handoff to the Director with the original authorized message source, destination,
side-effect reconciliation and required replay tool. Do **not** reconstruct an
announcement/role action from a diagnostic key or fabricate an idempotency key.
The reviewed one-row library function (`reconcileFailedJob` in
`src/jobs/replay.ts`) recovers the event identity from the row key and returns
advice after checking dirty source, current-revision refusal and surviving
pending requests. The disabled runtime preview calls only that reconciliation
function inside a consistent read-only snapshot; it never executes the advice.
`replayFailedSyncEvent` remains a library-only mutation helper. It reuses a due
pending request's key or mints a fresh one, then wraps the caller's raw queue
binding and ledger with `trackingQueue` so the new message records its ledger
job ID. No CLI, route or operational Worker caller wires replay or discard.
A later explicit replay requires fresh reconciliation and separate authority.
Only after confirmed recovery should separately approved history cleanup be
considered; this runbook intentionally provides no blind `DELETE`, fabricated
SQL replay, or live replay command.

Message contracts from [src/jobs/types.ts](../src/jobs/types.ts):

| Transport | W13 body fields |
| --- | --- |
| `two-sync-event` / `SYNC_EVENT_QUEUE` | `kind: "sync-event"`, `eventKey`, `idempotencyKey`, optional `jobId` |
| `two-internal-action` / `INTERNAL_ACTION_QUEUE` | `kind: "announcement"`, `action: { channelKey, body }`, `idempotencyKey`, optional `jobId` |
| `two-internal-action` / `INTERNAL_ACTION_QUEUE` | `kind: "role-assign"`, `action: { userId, roleKey }`, `idempotencyKey: null`, optional `jobId` |

The tracking producer supplies `jobId`; it is not the bot idempotency key.
W8 web/RSVP writes and cron use the same tracked W13 sync carrier. The first
attempt snapshots current status/action/payload/revision in `event_sync_attempts`;
retries and recovery keep that request's key and payload immutable. Later
mutations stay dirty until the pending request resolves, then use a new key.
Drafts/past rows do not start requests. Preparation alone is not a request:
first claims atomically recheck the current status/revision, synchronization and
same-revision definitive-refusal eligibility. A stale never-attempted snapshot
becomes `obsolete`, without a bot call or marking the event synced, even if its
preparation waited behind another identity's settlement. The pending slot is
then free for a newer eligible revision. Attempted requests retain their
immutable identity even if the event becomes past. Reconciliation selects those
attempted recovery candidates independently of eligibility to start a new
request, then checks their deadline and remaining budget before sending.
The bot HTTP adapter remains unwired; this is not proof of live Discord delivery.

Sync carriers (including waiting deliveries) settle their ledger and ACK at 6
tries, before transport `max_retries: 10`. Internal-action carriers cap at 5.
Sync requests independently persist `request_attempts` and `next_attempt_at`:
claims durably set eligibility to null **before** bot I/O. Only a committed
result can reopen that fence: backoff (`10,60,300,900,3600`) and authoritative
Retry-After select the next absolute deadline. A failed deadline write retries
that same Date (or exhausted null), never shorter generic backoff. If both writes
fail, the consumer carries the known remaining wait on that delivery, but the
request remains closed across new carriers and reconciliation. The old
300-second uniqueness TTL is not permission to send again. A concurrent carrier
waits 300 seconds without bot I/O; carrier exhaustion never clears the fence.

A worker lost after claiming, or unable to commit its result, cannot automatically
regain request eligibility. Preserve its key/payload/count and reconcile the
remote result in the bounded reviewed recovery below before committing an
appropriate deadline or settlement. This intentional fail-closed condition may
require operator recovery even before six requests; it avoids guessing a wait
shorter than a response that could not be saved. Ordinary transport retries
remain automatic when their backoff write commits. Reconciliation skips
legitimately delayed, null-fenced and exhausted requests even after lock expiry.

A carrier failure is **not** a resolved bot request. Transport loss or a failed
local completion retains a `pending` snapshot, even after all six automatic
request attempts. At that cap, automatic reconciliation pauses that request
(and newer revisions); its null `next_attempt_at` or exhausted count is an
explicit operator-recovery condition. Preserve the snapshot and failed ledger
history. A bounded, reviewed recovery must reconcile remote effects and renew
only the original request's budget/eligibility, **never** its key, action,
payload or revision. Preserve a positive `request_attempts` count: zero means
never attempted, not renewed budget. This runbook does not authorize a live reset or provide a
blind replay command. A `failed` snapshot instead means a definitive refusal:
automatic dispatch of that unchanged revision is suppressed; a meaningful
subsequent mutation is eligible. Retrying an unchanged refused revision likewise
requires an explicit reviewed operator action, not deleting history.

Best-effort successor checks/dispatch time out after two seconds. These timers
do not cancel SQL: ledger and lock traffic use pools separate from the handler,
so a blocked cleanup cannot starve the next message's snapshot/claim. Successor
SQL uses lazy per-operation pools (2-second connect, 5-second statement timeout,
1-second close), not the three pools closed when the consumer returns. The
production queue entry passes `ExecutionContext`; `waitUntil` preserves successor
settlement for at most 30 seconds without delaying ACK/handler return. Rejected
sends and late/failed ledger inserts compensate by their exact `jobId` with a
fresh usable pool, even after handler shutdown; no send starts after cancellation.
An already-started send accepted late retains its tracked row. A send unresolved
past that bounded lifetime, or a failed compensation, remains visible: do not
infer successful cleanup or delete rows by age. Reconcile transport evidence
before any reviewed operator correction; dirty revisions alone cannot remove
an orphan row.

Reconciliation holds its advisory single-flight lock throughout the pass, but
commits close/materialization in a shorter write transaction before queue I/O;
unrelated slow sends cannot retain recurring-parent row locks. Dirty revision
reconciliation remains the delivery backstop. Ledger/locks alone still do not
prove exactly-once remote effects. See [consumer error paths](../src/jobs/consumer.ts).

## Backups and restore drill

[bin/neon-backup.sh](../bin/neon-backup.sh) supports `backup`, `promote-weekly`,
`rotate`, `check` — **there is no `restore` subcommand**. `check` downloads
manifest-listed objects to prove existence, not restorability or row counts.
The [nightly workflow](../.github/workflows/neon-backup.yml) runs at `03:17Z`
and can skip green when `NEON_STAGING_DATABASE_URL` is absent. Green/skipped is
not a successful backup. Its `branch` input changes the object prefix only:
`DATABASE_URL` still comes from `NEON_STAGING_DATABASE_URL`; passing `main`
does not select a production connection. The `target` input selects the
connection: `production` reads `PRODUCTION_BACKUP_DATABASE_URL`, a read-only role.

The job binds the GitHub Environment named by `target` (`staging` for the
schedule and by default). A production dump therefore waits for the
`production` Environment's required reviewers and main-only branch policy
before the secret is readable, and a staging run never has
`PRODUCTION_BACKUP_DATABASE_URL` mapped into any step. Provision
`PRODUCTION_BACKUP_DATABASE_URL` on the `production` Environment only; a repo-level
secret is readable by any job without that gate, so delete it there.
`ci/check-production-secrets.test.mjs` fails any workflow job that reads a
`PRODUCTION_*` secret without binding `production`.

Implementation naming wins over older examples in `docs/db-migrations.md`:
for branch `staging`, the actual manifest is
`neon/staging-staging/MANIFEST.txt`, daily dumps are
`neon/staging-staging-<UTC>.dump`, weeklies append `-weekly-<UTC>.dump`.
Retention is newest 7 dailies + 4 weeklies. Member-data dumps belong **only** in
EU-jurisdiction `two-web-next-backups`, never `paperclip-backups`.

For an approved **operational backup**, not a test, the custodian injects the
intended `DATABASE_URL` and Cloudflare credentials. Do not paste/export a secret
value from a comment or switch to another URL if it fails. These remote commands
pin the approved bucket/jurisdiction and avoid inherited overrides:

```bash
(
  set -euo pipefail
  # REMOTE: only the authorized database and EU member-data destination.
  : "${DATABASE_URL:?Custodian must inject the approved backup connection}"
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
  export PGPASSFILE=/dev/null
  BACKUP_BUCKET=two-web-next-backups BACKUP_JURISDICTION=eu BACKUP_PREFIX=neon \
    WRANGLER_BIN= bash bin/neon-backup.sh backup staging
  BACKUP_BUCKET=two-web-next-backups BACKUP_JURISDICTION=eu BACKUP_PREFIX=neon \
    WRANGLER_BIN= bash bin/neon-backup.sh check staging
)
```

Do not run `rotate` against real archives without retention/deletion approval.
Do not run a real member-data restore into the agent test database. Recovery of
live data needs a separately authorized custodian, an approved private recovery
target, a preserved pre-recovery snapshot, writers/consumers held, source archive
identity/checksum and table-by-table counts, then a recorded binding/connection
switch and rollback. Never overwrite the sole database copy or treat a Worker
rollback as a data restore. Keep dumps inside approved EU custody and do not
attach them to evidence cards.

### Safe local drill (no R2, Neon, staging or production)

First exercise the actual backup script through the existing stub harness:

```bash
: "${PAPERCLIP_RUN_SCRATCH_DIR:?Use the run-owned scratch directory}"
TMPDIR="$PAPERCLIP_RUN_SCRATCH_DIR" bash ci/neon-backup-selftest.sh
```

This tests upload/manifest proof, 7/4 retention, password hygiene and missing
object failure entirely locally. Its fake `pg_dump` payload is **not** a
Postgres archive; this is not a restore test. The following separate real
custom-format round-trip proves `pg_dump`/`pg_restore` on a synthetic fixture
schema only. It never dumps or drops the rest of `two_web_next`; it deliberately
stops if its schema already exists. Use an authorized test-container executor if
this workspace has no PostgreSQL clients/network access. No host installation
or alternative credential is implied.

```bash
set -euo pipefail
: "${PAPERCLIP_RUN_SCRATCH_DIR:?Use the run-owned scratch directory}"
export PGHOST=agent-testdb PGPORT=5432 PGUSER=agent_test PGDATABASE=two_web_next
export PGPASSWORD='' PGPASSFILE=/dev/null PGSSLMODE=disable
# Ignore inherited address/service/options; never use a fallback password file.
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
DRILL_SCHEMA=runbook_restore_drill
ARCHIVE="$PAPERCLIP_RUN_SCRATCH_DIR/runbook-fixture.dump"
COUNTS_BEFORE="$PAPERCLIP_RUN_SCRATCH_DIR/runbook-counts-before.tsv"
COUNTS_AFTER="$PAPERCLIP_RUN_SCRATCH_DIR/runbook-counts-after.tsv"
# Do not overwrite another run's schema or fixture archive.
test ! -e "$ARCHIVE"
test "$(psql -XAt -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_namespace WHERE nspname = '$DRILL_SCHEMA'")" = 0
psql -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA runbook_restore_drill;
CREATE TABLE runbook_restore_drill.items (id integer PRIMARY KEY, label text NOT NULL);
INSERT INTO runbook_restore_drill.items VALUES (1, 'synthetic-one'), (2, 'synthetic-two');
SQL
psql -XAt -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) FROM runbook_restore_drill.items' > "$COUNTS_BEFORE"
pg_dump -Fc --schema="$DRILL_SCHEMA" --file="$ARCHIVE"
pg_restore --list "$ARCHIVE" > "$PAPERCLIP_RUN_SCRATCH_DIR/runbook-fixture-toc.txt"
# Destructive only to the just-created fixture schema, whose contents are above.
psql -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA runbook_restore_drill CASCADE'
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$PGDATABASE" "$ARCHIVE"
psql -XAt -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) FROM runbook_restore_drill.items' > "$COUNTS_AFTER"
cmp "$COUNTS_BEFORE" "$COUNTS_AFTER"
test "$(psql -XAt -v ON_ERROR_STOP=1 -c \
  "SELECT string_agg(label, ',' ORDER BY id) FROM runbook_restore_drill.items")" \
  = 'synthetic-one,synthetic-two'
psql -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA runbook_restore_drill CASCADE'
rm -- "$ARCHIVE" "$COUNTS_BEFORE" "$COUNTS_AFTER" \
  "$PAPERCLIP_RUN_SCRATCH_DIR/runbook-fixture-toc.txt"
unset PGPASSWORD
```

On any failure, stop and preserve private drill evidence; do not switch targets
or auto-drop an unexpected schema. Record which stages actually ran, tool
versions, fixture count `2 → 2` and content comparison. This drill does not prove
that a real R2 archive restores; only a separately approved recovery receipt can.

## Secret rotation pointer (procedure only)

Inventory names/kinds in [README configuration](../README.md#configuration)
and [wrangler.jsonc](../wrangler.jsonc). Use the official
[Workers secrets procedure](https://developers.cloudflare.com/workers/configuration/secrets/)
for the approved mechanism. `wrangler secret put` creates a new deployed version;
it is not a harmless configuration preview. This runbook performs no rotation
and supplies no secret values or rotation commands.

Route a suspected compromise to the Director/CISO immediately; CEO obtains the
owner-reserved approval before creation/deletion/rotation or exporting custody.
The authorized custodian records affected consumers and rollback/recovery plan,
updates the approved target only, coordinates paired web/bot HMAC credentials,
and verifies via approved local fixtures/metadata rather than live DB tests.
Changing `SESSION_SECRET` invalidates signed sessions/state; changing Discord
credentials affects OAuth and guild operations. Never revive a compromised old
secret merely to make a code rollback succeed, and never set QA credentials on
production. Credential refusal is a blocker, not a reason to hunt for another.
