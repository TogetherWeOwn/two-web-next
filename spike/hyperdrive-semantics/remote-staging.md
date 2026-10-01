# W1 live staging acceptance through a bounded remote preview

## Authority and evidence boundary

[TOG-10479](/TOG/issues/TOG-10479), resolved October 1, permits
[TOG-10478](/TOG/issues/TOG-10478) to adapt the harness and execute staging acceptance.
CI/unit/integration controls still use disposable containers, never production.
No grant, credential substitution, persistent Worker deployment, or Hyperdrive
configuration change is part of this command. Before activation, the exact PR
head needs green CI, Code Reviewer review/merge and independent security review
of the new preview invocation boundary. Opening a PR is not live verification.

The Neon project `two-web-next` / branch `staging` identity comes from the
[operator provisioning receipt](/TOG/issues/TOG-9836#comment-8f2a94fd-5663-4a0a-9087-42bfe94fae43).
The executor's assigned `CLOUDFLARE_API_TOKEN` reads current Cloudflare metadata:

- Account `209cf7dd678adfb683947dd7874d05af`.
- Actual deployed Worker `two-web-next`, `APP_URL=https://next.togetherweown.com`,
  its single current deployed version, and its unique `DB` Hyperdrive binding.
- Hyperdrive `1d48a54abd3444009b7067c03c63ff9f`, `two-web-next-staging`.
- Exact origin `ep-raspy-math-b1m3quxu-pooler.c-5.eu-central-1.aws.neon.tech:5432`,
  database `two`, role `two_app`.

These values are pinned in `remote-target.ts`. A mismatch/denial stops before
SQL. Provider origin passwords are discarded, never exported to the runner.
This is current Cloudflare binding/origin corroboration of the operator's
staging mapping, **not an independent Neon API project/branch-ID read**. The
runner does not invent those IDs or require another credential to obtain them.
A five-minute freshness check and second origin read immediately before SQL
bound drift; neither proves that an administrator cannot race a metadata read.

The source application's deployed version is provenance, not the executed
preview version. The wrapper refuses tracked changes and untracked files, captures
one committed git revision, and extracts **that revision's Git objects**, not
mutable working files, into a read-only run-owned source snapshot. It checks tree
cleanliness and HEAD again after extraction. Both the Node runner bundle and
Wrangler's Worker bundle use this snapshot; subsequent working-tree edits cannot
change the uploaded Worker at the recorded revision. Installed Wrangler, esbuild
and Postgres versions must match the snapshot lockfile; no install is performed.
No application route/version changes.

## Command (after review and merge)

From a clean execution workspace on Linux with Python 3, with the existing
injected Cloudflare token and Paperclip agent/scratch variables:

```sh
bash spike/hyperdrive-semantics/remote-checks.sh
```

No URL, SQL, schema, account, branch, Worker, check selector or credential is an
argument. The wrapper uses a unique `w1-remote-*` directory in Paperclip's
run-owned scratch. A Linux child-subreaper supervisor launches the runner in a
separate process group and enforces a 600-second budget (including source/build
preparation), with 10 seconds TERM grace followed by KILL and a bounded reaping
wait. The runner's own 480-second preview bound leaves time for preflight and
teardown. Do not wrap the supervisor itself in GNU timeout; its independent
lifetime is what allows teardown after forced SIGKILL of Node. Unsupported
subreaper platforms are refused before any provider access.

The runner generates a dedicated scratch config containing only the pinned DB
binding and ephemeral invocation nonce, with `workers_dev:false`,
`preview_urls:false`, no routes, assets, crons or queues. Wrangler's
remote-development handshake is the existing transport; no new Cloudflare
connection intent or token-management call is made.

`wrangler dev --remote` listens only on `127.0.0.1`, as does its inspector. The
preview is not a permanent public endpoint. A random per-run 256-bit nonce also
protects both readiness and execution; it is sent as an ephemeral preview var,
never printed, published, or uploaded as evidence. Only an empty POST `/run`
can execute the fixed checks, once per preview isolate. Readiness opens no database. Request JSON/query strings
cannot select SQL or targets. Never put this entrypoint into `src/worker.ts`.

Only the assigned Cloudflare token and whitelisted process-environment fields
reach Wrangler. Its cwd and HOME are isolated scratch directories, not the repo
or ambient auth profile. Every invocation passes an explicit mode-0600 empty
`--env-file`. This is necessary: Wrangler 4.143.1's CLI-wide loader otherwise
loads cwd `.env`/`.env.local` even when
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`; that flag only controls dev vars.
No ambient PG/Neon URL, QA token, alternate Cloudflare credential, `.env` or
`.dev.vars` supplies a database target. Actual runtime Hyperdrive fields, never
an arbitrary origin URL, reach Postgres.js. Direct Neon/local hosts and mismatched
roles/databases are refused before driver construction.

## Caching, checks, failure and cleanup

The current staging Hyperdrive has caching **enabled**. This run must test that
existing resource without a write grant/configuration mutation. Fixed reads
include a VOLATILE `random()` projection (advisory lock functions are already
VOLATILE), which Hyperdrive documents as ineligible for caching. The GIN query
retains its containment predicate and unforced index plan. No cached capacity
count or advisory result is accepted as lock evidence.

The shared fixed checks remain: (a) 55P03 row contention and capacity refusal,
(b) transaction advisory single-flight and reacquisition, (c) native jsonb
containment with unforced GIN selection. They create only one UUID-owned
`w1_staging_<32 hex>` schema and synthetic data. Transactions are rolled back
and released in `finally`. The exact schema identity is reported before CREATE.
Cleanup drops only a successfully acknowledged, owned exact schema and
independently counts matching `pg_namespace` rows (must be zero). An unknown
CREATE acknowledgement means `created`/`cleanup: "not_verified"`; it does not
prove non-creation or authorize DROP without ownership evidence. Explicit
42P06/42501 refusals do not establish an owned schema.

Per-check statuses are `passed`, `failed`, or `not_attempted`. Sanitized failures
retain completed checks, `failedStage` (connect/create_schema/setup/a/b/c/cleanup/
close), and teardown failures, even when SQL, DROP, and close fail together.
Every client close is attempted. Partial results, driver/close/cleanup errors are failure.
The unsafe-query helper sets both `prepare:true` and `simple:false`, including
parameterless statements; a real-driver lazy-query regression verifies effective
protocol options without opening a connection.

The runner captures Wrangler output privately rather than echoing provider
errors/tokens. Driver failures expose only a fixed code plus owned-schema and
cleanup state. Wrangler inherits the runner's supervisor-owned process group
(no detached preview session). After any invocation outcome, abrupt Node exit,
or forced timeout, the independent supervisor terminates that group (TERM,
bounded wait, KILL) and reaps orphaned descendants. Killing local processes is
**not database cleanup proof**. SIGKILL of the supervisor itself, host death, or
an incomplete result also cannot prove cleanup. Preserve the exact attempted
schema if available, mark cleanup NOT VERIFIED, and stop before further runs.
Do not wildcard-drop or substitute a direct database credential. Resolve that
specific cleanup through an authorized staging-only route; no generic cleanup
endpoint is implemented here.

Only sanitized `preflight.json` and `result.json` are deliverables; never upload
`wrangler.json`, the invocation nonce, source snapshot, private build logs or
private Wrangler logs. Results live under the unique
`$PAPERCLIP_RUN_SCRATCH_DIR/w1-remote-*/` directory; upload them before the run ends.
The run-owned scratch lifecycle bounds all configs, nonce, logs and snapshots;
none are written into the repository or a persistent HOME.
Record tested git revision, Wrangler/Postgres versions, operator-derived branch
identity, actual binding/origin, per-check pass/fail and cleanup in `findings.md`.
All three live criteria remain NOT VERIFIED until an actual result exists.

## Verification commands (no cloud credentials)

```sh
./node_modules/.bin/vitest run test/remote-staging.test.ts \
  test/remote-runner-isolation.test.ts test/staging-hyperdrive.test.ts \
  test/staging-failure-evidence.test.ts test/postgres-staging-options.test.ts \
  test/hyperdrive-probe.test.ts test/worker-runner.test.ts
W1_AGENT_TESTDB=1 ./node_modules/.bin/vitest run test/staging-fixed-agent-testdb.test.ts
```

The isolation regressions execute only the pinned Wrangler bundle's pure dotenv
functions/CLI loader check with synthetic temp files and a synthetic environment,
not the CLI itself. Disposable Git fixtures prove dirty/drifting-source refusal
and immutable snapshot bundling. Benign local Node descendants prove both the
outer deadline and GNU timeout's SIGKILL of Node leave no survivors **or zombies**.
No cloud credentials, remote preview, or database is used by these regressions.

## Sources (Wrangler 4.143.1; Postgres.js 3.4.9)

- Pinned local `node_modules/wrangler/wrangler-dist/cli.js`, generated from
  `packages/wrangler/src/index.ts` (CLI-wide dotenv check),
  `src/config/dot-env.ts` (`getDefaultEnvFiles`/`loadDotEnv`) and
  `src/dev/dev-vars.ts` (`getVarsForDev`): an explicit env-file replaces CLI
  defaults independently of the dev-vars flag. Inspected offline; the synthetic
  regression extracts these exact pure functions rather than emulating them.

- https://developers.cloudflare.com/hyperdrive/get-started/#run-in-development-mode-optional
  — remote Wrangler executes on Cloudflare against the deployed Hyperdrive;
  local development with a connection URL bypasses the pooler.
- https://developers.cloudflare.com/workers/development-testing/#remote-development
  — temporary remote preview, not a persistent application deployment.
- https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
  — only eligible non-mutating reads; STABLE/VOLATILE functions bypass caching.
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
  — per-request clients, `fetch_types:false`, `prepare:true`.
