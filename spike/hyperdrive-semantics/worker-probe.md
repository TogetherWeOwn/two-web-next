# W1 local Worker control probe

## Allowed execution path

The current test policy permits **agent-testdb / agent-testredis or CI service
containers only**. Never point this probe at production or staging, including
the Neon staging branch. The original Hyperdrive→Neon acceptance is therefore
not executable under the current policy; local results do not satisfy it.

The checked-in `wrangler.probe.jsonc` binds the pinned agent-testdb target as a
plain `vars` string (`TEST_DB_CONNECTION_STRING`). A Hyperdrive binding is
deliberately **not** used: Miniflare's `HyperdriveSchema` requires a password,
which the passwordless test container cannot satisfy, and no credential may be
introduced to satisfy it. The Worker therefore receives a direct PostgreSQL
connection string; this path **does not run the Hyperdrive origin pooler**. No
Cloudflare account or credentials are needed. Do not deploy this Worker or use
remote dev. The probe creates synthetic tables in a unique schema and drops
that schema when finished.

From the repository root, with dependencies already installed:

```sh
# Offline regressions: config binding boundary + runner startup bound
./node_modules/.bin/vitest run test/worker-runner.test.ts test/hyperdrive-probe.test.ts

# Finite local workerd/Miniflare → agent-testdb control leg
bash spike/hyperdrive-semantics/worker-checks.sh
```

The runner bounds `unstable_dev` startup under a 180 s wall-clock budget (exit
2 on a never-ready startup) and the shell wrapper owns the runner's process
group, TERM/KILLing it on a 600 s expiry so a hung startup cannot be orphaned.
On a ready Worker it verifies a DB-free readiness response, invokes
`POST /spike-run`, asserts three passing checks, and always stops its local
Worker. The checks are:

- (a) `SELECT … FOR UPDATE` contention on an RSVP-shaped event row, then capacity
  refusal after the winning transaction commits.
- (b) Transaction-scoped advisory-lock contention and reacquisition after commit.
  A session-scoped advisory lock can round-trip on direct PostgreSQL, but that
  does not establish portability through Hyperdrive transaction pooling.
- (c) jsonb containment returning the expected row and `EXPLAIN` showing the GIN
  index. This verifies index eligibility, not production query performance.

Record the returned JSON and the runner's Wrangler version as **local control**
evidence. Do not label it Hyperdrive→Neon evidence or invent a Neon branch name.

## Remaining acceptance gap

[TOG-9680](/TOG/issues/TOG-9680) originally requires pass/fail per (a)–(c) through
Hyperdrive to an exact Neon branch. That remains unverified. The CTO must decide
how to reconcile this requirement with the test-container-only policy through
the authorized governance path; this runbook grants no exception. Likewise,
creating/deleting Cloudflare resources or obtaining credentials is not part of
the local test command.

Before any future authorized integration leg, retain the exact branch identity,
Wrangler version, all three results, and schema cleanup evidence. A single GIN
pass or a direct-PostgreSQL control pass is not proof of the full integration.
