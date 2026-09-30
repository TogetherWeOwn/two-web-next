# W1 local Worker control probe

## Allowed execution path

The current test policy permits **agent-testdb / agent-testredis or CI service
containers only**. Never point this probe at production or staging, including
the Neon staging branch. The original Hyperdrive→Neon acceptance is therefore
not executable under the current policy; local results do not satisfy it.

The checked-in `wrangler.probe.jsonc` uses a placeholder Hyperdrive ID and
`localConnectionString` pointing at `agent-testdb`. Wrangler's local binding
passes a direct PostgreSQL connection string to the Worker; it **does not run
the Hyperdrive origin pooler**. No Cloudflare account or credentials are needed.
Do not deploy this Worker or use remote dev. The probe creates synthetic tables
in a unique schema and drops that schema when finished.

From the repository root, with dependencies already installed:

```sh
# DB-free routing, connection-target refusal, and error-handling regressions
./node_modules/.bin/vitest run test/hyperdrive-probe.test.ts

# Finite local workerd/Miniflare → agent-testdb control leg
bash spike/hyperdrive-semantics/worker-checks.sh
```

The runner binds a loopback port, verifies a DB-free readiness response, invokes
`POST /spike-run`, asserts three passing checks, and stops its local Worker in
`finally`. The checks are:

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
