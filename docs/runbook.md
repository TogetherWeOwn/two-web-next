# Operations runbook: two-web-next

This is the Cloudflare Worker runbook, not the frozen Laravel/VPS runbook.
Start here for releases, queue incidents and database recovery; use
[log-line alerts](runbook-alerts.md) for fingerprints and
[shared Postgres](db-migrations.md) for migration ownership and backup policy.
The [parity matrix](parity.md) records what is implemented versus still missing.
Cutover/DNS changes are outside this runbook.

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
by `W1_AGENT_TESTDB=1`. Only Vitest receives the
fixed `--exclude test/review-p1-verify.test.ts`; this file has unconditional SQL
cases and a fallback to `agent-testdb` database `postgres`. Unset `DATABASE_URL`
alone is **not** fixture-only. The command accepts no extra arguments, and
reports success as **limited evidence**, not a substitute for exact-head CI with
service-container DB coverage. Appending flags to the full shell-chain `check`
script sends them to its final cutover command, not the earlier Vitest command.

Full `npm run check`, coverage thresholds and required CI gates are unchanged.
Full database verification must explicitly use
`postgres://agent_test@agent-testdb:5432/two_web_next` and the migrated schema,
never that fallback or a live service. Required CI runs the complete suite on
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

3. Normal path: merge to `main` invokes
   [.github/workflows/deploy.yml](../.github/workflows/deploy.yml), using the
   GitHub Environment `staging` gate. It installs dependencies, applies
   migrations **only to its disposable Postgres**, runs `npm run check`, ensures
   `two-sync-event` and `two-internal-action` exist, then deploys. The queue-create
   step currently suppresses errors; it is not permission/provisioning evidence.
   The final `/health` check is liveness only, not DB/queue acceptance.
4. An explicitly authorized manual deployment of the reviewed release uses:

   ```bash
   # REMOTE MUTATION: approved target and release only; not a test.
   npm run deploy
   ```

   This deploys the current checkout. Do not run it from an unmerged working
   branch, and do not bypass the Environment gate to clear a blocked CI release.
   Neither Worker deploy path migrates the live database. Use the separately
   approved [Neon migration workflow](#neon-web-schema-migrations-separate-operator-action)
   before deploying a schema-dependent Worker; coordinate with both bot and web
   owners using `docs/db-migrations.md`.
5. Capture the resulting deployment/version IDs and workflow URL. `/health`
   does not exercise persistence; `/up` reports only limited dependency evidence
   (below). Source behavior and local tests are not proof of live isolation.

### Neon web schema migrations (separate operator action)

[db-migrate.yml](../.github/workflows/db-migrate.yml) is a **remote mutation**,
not a test or part of the default Worker deployment. This workflow's addition
([TOG-11161](/TOG/issues/TOG-11161)) does not authorize its execution. No live
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
  `NEON_PRODUCTION_DATABASE_URL` **only on the production Environment**, using
  the authorized operator's secret-provisioning path. Verify the intended Neon
  project/branch/database and direct endpoint out of band; a hostname alone
  cannot distinguish staging from production. The driver pins port 5432, uses
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
- Verify Neon history retention/PITR eligibility for the target branch and a
  tested recovery procedure before apply. The summary's timestamp is a recovery
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
   **pre-migration Neon PITR timestamp** and release SHA in the job summary
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
verify the recorded timestamp is eligible, and use Neon's documented restore
procedure. Restore can overwrite all databases on the branch and lose later
writes; retain the prior branch as required by that procedure. Reconcile bot,
queues and external side effects separately. Do not run an unreviewed down
migration or assume restoring the Worker restores the database.

**Opt-in deploy hook (off by default):** the workflow exposes `workflow_call`
with `target` defaulting to `staging`; `deploy.yml` currently does **not** call
it. A separately reviewed integration may add a reusable-workflow job before
Worker deploy, then make deploy `needs` that successful job. Use the same merged
`main` revision, pass `target: staging`, and do not pass/inherit DB secrets:
this workflow loads its own Environment secrets. Coordinate concurrency so a
new migration cannot race a schema-dependent release. Never automatically
couple production apply to a Worker deploy or enable the hook just by merging
schema SQL.

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
Worker's routes/domains. It does **not** undo Postgres migrations, data writes,
Discord side effects, queue messages or external-resource changes. Check schema
compatibility first; keep the release workflow from redeploying the bad head.
Record the rollback deployment and previous/current version IDs. Do not claim a
rollback was rehearsed unless there is an execution receipt.

Official references: [Wrangler rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback)
and [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#limits)
(last 100 published versions; resource/class-lifecycle changes can prevent it).

## Read `/up` without mistaking liveness for readiness

`GET /robots.txt` is DB-free and can check local Worker startup; it does not
prove deployment readiness. `/health` and `/healthz` are removed (404).
`GET /up` is **readiness**: a required-secret presence check, a read-only DB
ping and web migration-ledger read, plus the unchanged queue object. It has `Cache-Control: no-store`, no session/auth
lookup, and no cookies. No migration is run or repaired by this endpoint.

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
| Read rejects or reaches a server/response limit | `healthy` | `unknown`, all six measurements `null`, `detail: null` |
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
  npm run test -- test/up.test.ts test/deploy-smoke.test.ts
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  npm run test -- test/up-db.test.ts
```

Source: [Drizzle migration log defaults](https://orm.drizzle.team/docs/drizzle-kit-migrate#applied-migrations-log-in-the-database).

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
  `null` when no pending rows (or when the entire read is unknown).

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
| `/` (GET) | **Not guaranteed 200**: session-store migration/read failures can become **500**. Missing DB gives guest shell; a migration-cached guest may stay 200. Rotation failure alone falls back to guest. |
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
[error handler](../src/errors.tsx).

Shared human throttles and profile throttles fail open on store error; the shared
human throttle currently uses only `DATABASE_URL`, not Hyperdrive. Optional
search-log/widget reads fail open but do not protect primary DB reads. Do not
relax `MEMBER_ACCESS_LOG_ENFORCE` to force a recovery: required logging defaults
to fail closed. Diagnose from redacted platform errors/config metadata; a code
rollback may help a code regression, but cannot repair a Neon outage. Escalate
binding/DB recovery to the Director and authorized custodian; never credential-hop.

## Queue containment, drain and failed-job replay

**Current implementation gate:** [src/jobs/worker.ts](../src/jobs/worker.ts)
uses a real event store but a `notWired` BotClient adapter. The configured W13
consumers cannot currently perform successful live bot work. Do not resume delivery or
replay real messages until the Director has accepted a reviewed adapter fix and
local acceptance evidence. Queue depth falling under these stubs can mean retry
exhaustion and terminal acknowledgement, not successful draining.

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
and no original bot idempotency key**, and there is no repo replay script,
`queue:retry` command or Wrangler message-send subcommand. The operator
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
A future reviewed tool must recover the original payload/key, reconcile whether
the bot already applied it, enqueue via the proper binding and record the new
ledger job ID. Only after successful reconciliation should separately approved
history cleanup be considered; this runbook intentionally provides no blind
`DELETE`, fabricated SQL replay, or live replay command.

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
does not select a production connection.

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
