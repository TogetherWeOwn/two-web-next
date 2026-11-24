# Kit cutover and Hono undo

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

For the Ember release set `cutover_profile: ember` with `qualify_cutover: true`.
The regular all-off parity job still verifies the packaged bytes. The isolated
run uploads those bytes with the Ember flag on and checks that document GETs to
Home, Events and Join use Kit. It checks Hono on the remaining smoke routes and
at each undo. APIs, Join OAuth, member and admin routes keep their Hono ownership.

## Protected release and recovery

Follow the [separate release gate](../CONTRIBUTING.md#production-release-gate) and pause automatic promotion. Prepare Hono with `deploy-production` and `cutover_mode: hono`, then record its serving UUID.
Select `ember` for the Ember-qualified proof or `kit` for the all-off proof.
Use the serving Hono UUID as `cutover_undo_version` and the same `sha` and
`cutover_pin`. The gradual rollout and final smoke check the selected renderers.
Undo with `rollback-production`, specifying Hono as `version_id` and Kit as
`expected_current_version_id`. Ordinary promotion requires the full target ledger.
