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

## Protected release and recovery

A separate release task follows the [production release gate](../CONTRIBUTING.md#production-release-gate).
The ordinary protected deploy continues to select Hono. Pause automatic
promotion for the two explicit cutover dispatches and the cutover hold.
Use the same full `sha` and `cutover_pin` for both dispatches. The release
workflow verifies the approved ledger against the actually serving version
under the production mutation lock. The ordinary migration confirmation
input cannot override this check.

1. Dispatch `deploy-production` with `cutover_mode: hono` to prepare the
   staged compatible undo on the existing production script. Record the UUID
   from its successful protected promotion and watch.
2. Dispatch `deploy-production` with `cutover_mode: kit` and
   `cutover_undo_version` set to that live Hono UUID. The gate verifies its
   source, packet annotation, UUID, bindings and readiness before uploading
   the exact staged Kit files without rebuilding. The existing gradual
   promotion, ordinary traffic smoke, and watch still apply. Record both
   UUIDs and the production promotion receipt.
3. For manual undo, dispatch `rollback-production` with
   `environment: production`, `version_id` set to the recorded Hono UUID,
   and `expected_current_version_id` set to the promoted Kit UUID. The
   protected workflow checks the live version and the target's required
   secret names, then verifies ordinary traffic on the restored Hono UUID.
   Automatic rollback uses the same recorded version pair.
