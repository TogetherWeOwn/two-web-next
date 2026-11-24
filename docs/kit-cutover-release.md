# All-off Kit cutover and Hono undo

The [XFS qualification workflow](../.github/workflows/xfs-qualification.yml)
tests the Kit build with every route family off. It preserves the exact facade,
adapter, and asset bytes from that run together with a pure Hono build compiled
for the same database readiness profile. The packet manifest binds both file
trees to the source SHA, root and Kit configuration digests, migration journal,
run ID, run attempt, and the Hono compiler define and Wrangler pin.

On `main`, dispatch XFS qualification with `qualify_cutover: true` to keep
the packet from that exact attempt for 30 days. Parity replays the packaged
Kit bytes. Isolated staging must exercise the separately compiled Hono undo
bytes before protected deployment selection.

The `isolated-cutover` job runs on the same main dispatch. It needs
`KIT_CUTOVER_TEST_DATABASE_HOST` and `KIT_CUTOVER_TEST_DATABASE_URL` in
the staging Environment for a dedicated synthetic Neon project with the
`two_web_cutover` control database and `two_web_cutover_owner` login.
It runs public smoke and exact-version undo on both ledger states, then
removes the run-owned Worker, database, and expiring login.
To retry, select **Re-run all jobs** so staging uses a packet from that attempt.

## Protected release and recovery

After the [separate release gate](../CONTRIBUTING.md#production-release-gate),
pause automatic promotion. Use the same full `sha` and
`cutover_pin` (`run:attempt:manifest SHA-256`) for both dispatches.

1. Dispatch `deploy-production` with `cutover_mode: hono`. Record the serving
   UUID after its protected promotion and watch.
2. Dispatch with `cutover_mode: kit` and `cutover_undo_version` set to that UUID.
   Admission verifies the staged packet, approved live ledger, and Hono source,
   UUID, annotation and required secrets before uploading the exact Kit bytes.
3. For manual or same-SHA undo, set `version_id` to Hono and `expected_current_version_id` to
   Kit in `rollback-production`. Automatic rollback uses the same pair.

Ordinary promotion from a cutover version requires the complete target ledger.
