# Hyperdrive-leg runbook (run after [TOG-9679](/TOG/issues/TOG-9679) delivers the Neon staging branch)

Never production. Neon staging branch only.

1. Create the Hyperdrive config against the S1 branch (needs the branch
   connection string from S1; token is the `CLOUDFLARE_API_TOKEN` GH secret,
   never pasted here):
   `npx wrangler hyperdrive create w1-spike --connection-string="<S1 branch URL>"`
2. Bind it in a scratch `wrangler.jsonc` overlay (do NOT commit the branch URL):
   `"hyperdrive": [{ "binding": "SPIKE_DB", "id": "<id from step 1>" }]`
3. `npx wrangler dev` a probe Worker using the `pg` driver (≥8.16.3,
   `connectionString: env.SPIKE_DB.connectionString`) that runs, inside one
   `BEGIN/COMMIT` each:
   - (a) `SELECT … FOR UPDATE` on the spike events table + capacity-count insert;
   - (b) `SELECT pg_advisory_xact_lock(<key>)` then a concurrent
     `pg_try_advisory_xact_lock(<same key>)` → expect `false`;
   - (c) the `@>` containment over the spike access-log table + `EXPLAIN` showing
     the GIN index.
   Reuse the SQL in `schema.sql` / `checks.py` verbatim (schema `w1_spike_neon`).
4. Record on [TOG-9680](/TOG/issues/TOG-9680): pass/fail per (a)–(c), exact Neon
   branch name, `wrangler --version`. Any failure = blocking finding for
   W8/W9/W13. Delete the Hyperdrive config afterwards.
