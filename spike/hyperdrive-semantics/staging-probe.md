# W1 separate staging E2E harness — preparation, not activation

## October 1 continuation

The CTO/CEO gate [TOG-10479](/TOG/issues/TOG-10479) is resolved: live staging
acceptance is allowed. The cancelled coordination chain is not a new access gate.
See [remote-staging.md](remote-staging.md) for the separate runnable, ephemeral
`wrangler dev --remote` path and its actual evidence boundary. The preparation-only
library and stronger Neon-provider-receipt validator described below remain intact;
they are NOT the entrypoint used by that preview runner. No Neon provider read is
claimed by the new Cloudflare-only collector. The three live results are still
NOT VERIFIED until that reviewed runner executes and records them.

## Boundary and status

The 2026-09-30 clarification permits gated staging E2E. Unit/integration controls
remain on agent-testdb/agent-testredis or CI containers. `probe-worker.ts`, its
local target predicate, pinned driver options and Wrangler config are unchanged.
No direct PostgreSQL or Miniflare result proves the live edge pooler.

`staging-probe.ts` is a **non-routable library**, not a deployed Worker. It has no
`fetch` handler, HTTP endpoint, deployment config or command accepting a URL,
SQL, schema, per-check selection or production fallback. Do not mount it on
`/spike-run` or another public route. Nothing in this PR provisions credentials,
grants access, changes an existing binding or deploys anything.

[TOG-10983](/TOG/issues/TOG-10983) owns preparation only;
[TOG-10479](/TOG/issues/TOG-10479) retains the CTO gate;
[TOG-10478](/TOG/issues/TOG-10478) owns future live (a)/(b)/(c) runs.
All three live results remain **NOT VERIFIED**. W8/W9/W13 remain unapproved.

## Executor-specific preflight — before any SQL

The intended executor must use **their own existing permitted, authenticated
read transport**, recording non-secret principal subject, agent ID, transport,
permitted verbs and observation time. Logical receipt verbs are
`workers.settings.read`, `hyperdrive.read` and `neon.branch.read`; these names
normalize evidence, not grant provider permissions. If a read is missing/denied,
stop, record NOT VERIFIED and retain an owned prerequisite blocker. No new
connection intent, token minting, grant, export, borrowing or credential
substitution is authorized. An operator's old successful call is not evidence
of this executor's current access.

Collect current read-only provider records, retaining redacted provenance:

1. **Worker settings/deployed version:** discover the actual Worker name and
   version UUID, and its `DB` Hyperdrive binding ID. Never infer the Worker name
   from a Hyperdrive name/hostname or local Wrangler file.
2. **Hyperdrive resource:** exactly `two-web-next-staging`, ID
   `1d48a54abd3444009b7067c03c63ff9f`, caching disabled, origin hostname,
   database and database role. Never retain its origin password/connection URL.
3. **Neon project/branch/endpoint:** project name `two-web-next` and actual
   project ID; branch name `staging` and actual branch ID (not default branch);
   endpoint's branch ID and hostname; matching database and database role.
   Verify origin host/database/role against these provider records, not a naming
   convention or direct database query.

`StagingPreflight` describes those **non-secret** normalized records.
`requireStagingPreflight` checks their consistency, executor identity and freshness
(maximum five minutes; no future timestamps) without opening a database. It is
**NOT** an authentication mechanism or a live metadata collector: anyone can
fabricate JSON. Do not treat a passing fixture or hand-written receipt as provider
proof. The actual collector/transport, authenticated provenance and Worker
selector cannot be implemented or claimed until that existing route is verified.
Re-read after every deployment/binding/branch change and before invocation.

The future approved **private** entrypoint must get `DB` from its actual Workers
runtime and `CF_VERSION_METADATA.id` from the runtime version metadata binding,
not request JSON. The runtime version must equal the observed deployed version.
Hyperdrive exposes a runtime-only generated host but **does not expose its resource
ID**; that ID and origin mapping come from the authenticated control-plane reads.
The runtime host alone never proves Neon project/branch isolation. If this
version/binding evidence cannot be supplied, the library refuses before the driver.
No public execution surface may be activated without its actual independent
security/access gate. Integrating a private invocation transport is also separate,
authorized work; this module is not an authorization bypass.

## Fixed checks and cleanup

Only the actual runtime Hyperdrive host/port/user/password/database reach
Postgres.js. Ambient `PG*` variables and arbitrary connection URLs are not used.
Clients are per invocation, `max:1`, `fetch_types:false`, `prepare:true` (including
all fixed `unsafe` calls), five-second connect/statement and two-second default
lock timeouts. Warm both clients with a fixed `SELECT 1` before reserving them:
Postgres.js 3.4.9 with `fetch_types:false` left fresh `reserve()` pending in the
offline direct control; warming resolved that failure.

The checks use a newly generated `w1_staging_<32 hex UUID>` schema and synthetic
rows only. They test (a) real 55P03 row-lock contention then capacity refusal,
(b) transaction-scoped advisory-lock contention then reacquisition after commit,
and (c) containment row count plus unforced EXPLAIN GIN index selection. Session
advisory lock portability and production query performance are not claimed.

Each reserved transaction is rolled back/released in `finally`; the exact schema
is dropped only after this invocation successfully created it. All clients are
closed, even if one close fails. A driver/cleanup error produces a redacted
failure, never a success. A successful result requires all three checks **and**
confirmed schema cleanup. Offline helper results have no Hyperdrive path label;
only the guarded runtime wrapper adds that label.

Timeout/interruption is **not** cleanup proof: an external hard kill can prevent
`finally`. On a future failed live run, retain the exact generated schema from
private execution evidence; record cleanup NOT VERIFIED and use the already
approved private cleanup route to drop that exact owned schema after verifying
ownership. Never wildcard-drop schemas or provide a public cleanup SQL endpoint.

## Bounded offline preparation commands

With existing dependencies, from the repository root:

```sh
# Mocked target/refusal/cleanup regressions; no database or cloud credentials.
timeout --kill-after=5s 60s ./node_modules/.bin/vitest run \
  test/staging-hyperdrive.test.ts test/hyperdrive-probe.test.ts test/worker-runner.test.ts

# Explicit DIRECT agent-testdb control; not a Worker/Hyperdrive/Neon acceptance.
# Fixed host=agent-testdb port=5432 user=agent_test db=agent_test, empty password.
timeout --kill-after=5s 60s env W1_AGENT_TESTDB=1 ./node_modules/.bin/vitest run \
  test/staging-fixed-agent-testdb.test.ts
```

The optional DB suite is skipped by default, has 30-second individual test bounds,
and verifies zero remaining rows for each exact created schema, including forced
setup failure. No `.env`, Neon URL or inherited database credential is consumed.

**Live execution command: NOT AVAILABLE/NOT VERIFIED.** There is no verified
existing private invocation route in this prerequisite. Do not invent an endpoint
or pass a credential to a guessed command. After its real route and all gates
clear, the parent must record the exact existing private invocation command,
wrap it with a 600-second limit/10-second kill grace, and record Worker/version,
Neon project/branch, Wrangler/driver versions, all three outcomes and cleanup.
SQL timeouts alone do not guarantee a Worker/network wall-clock bound.

**Prepared rollback:** this PR activates nothing. Revert its eventual reviewed
squash SHA through the normal reviewed revert process if the library must be
removed. No Worker/Hyperdrive/Neon deletion is needed. Any future deployment must
first record its existing previous Worker version and exact private rollback
command under the parent; those identities are currently NOT VERIFIED.

## Sources and pinned stack

Installed lockfile versions: Postgres.js 3.4.9, Hono 4.13.11, Wrangler 4.143.1,
Vitest 5.0.2. Official sources consulted 2026-10-01:

- https://developers.cloudflare.com/hyperdrive/get-started/ — real runtime binding,
  local-development limitations; local connections do not exercise origin pooling.
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
  — per-request clients, `fetch_types:false`, **`prepare:true`**. Current docs warn
  that `prepare:false` can hang/fail with transaction pooling; the existing direct
  local control's setting must not be copied into the staging harness.
- https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
  — `env.CF_VERSION_METADATA.id` is the actual executing Worker version UUID.
- Installed `@cloudflare/workers-types/index.d.ts`, `Hyperdrive` interface — runtime
  host/port/user/password/database and `connect()`, **no resource ID**.
