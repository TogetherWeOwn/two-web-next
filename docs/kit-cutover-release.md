# All-off Kit cutover and Hono undo

The [XFS qualification workflow](../.github/workflows/xfs-qualification.yml)
tests the Kit build with every route family off. It preserves the exact facade,
adapter, and asset bytes from that run together with a pure Hono build compiled
for the same database readiness profile. The packet manifest binds both file
trees to the source SHA, root and Kit configuration digests, migration journal,
run ID, and run attempt.

## Qualify on isolated staging

On `main`, dispatch XFS qualification with `qualify_cutover: true`. The
`isolated-cutover` job uses the staging Cloudflare account and a dedicated
synthetic Neon project. Its staging Environment needs
`KIT_CUTOVER_TEST_DATABASE_HOST` and `KIT_CUTOVER_TEST_DATABASE_URL` for the
`two_web_cutover` control database and its `two_web_cutover_owner` login.
The owner needs to create disposable databases and logins on that dedicated
project. The job creates and removes its own database, login and Worker. The
Worker receives only the disposable login. It has no live routes, Hyperdrive,
queue, tail service or cron bindings.

The job deploys the packet's Hono baseline, uploads Kit to that same script,
then checks ordinary traffic and the Worker version UUID before and after
rollback. Each leg uses the public smoke and checks the observed canonical
ledger, first through `1033` and again through `1037`. The job samples Kit
readiness for one minute at each boundary before restoring the exact Hono
version. Migration `1038` stays deferred. The proof and job logs record
the two UUIDs, readiness and smoke outcomes, observed binding checks and
packet identity. Hosted parity covers the wider Hono route matrix, and the
installer tests cover queue and scheduled exports. The isolated script leaves
external jobs disconnected.

Use the successful run's `run:attempt:manifest SHA-256` from its summary.
A failed run, a run from another ref, or a mismatched attempt, manifest,
source config, module or asset refuses selection. The packet and proof expire
after 30 days. Rerun all jobs to qualify a new attempt.
