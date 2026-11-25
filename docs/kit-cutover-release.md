# Kit cutover and recovery

## Database handoff

Complete the protected [migrator permissions repair](../.github/workflows/db-permissions-repair.yml)
and its production watch first. Install the
[readiness projection](db-migrations.md#install-or-remove-the-readiness-projection)
while direct ledger access still works. Use the
[protected release steps below](#protected-release-and-recovery) to dispatch
`deploy-production` with `cutover_mode: hono`, the approved compatible
Hono SHA and its qualification pin, and both undo inputs empty. Verify that
version serves 100% of traffic and reads through the projection on `1033` before
applying [serving ledger isolation](../.github/workflows/db-serving-ledger-isolation.yml).
Verify the effective access for the serving Web and jobs roles and finish the
isolation watch. Apply the approved web schema advance separately through
[`db-migrate`](../.github/workflows/db-migrate.yml). Hand off to Ember after
the database releases and their watches pass. Record the serving Worker commit
and UUID, the canonical ledger prefix through `1037` with `1038` deferred,
healthy `/up`, and the database recovery receipts. A cutover changes the serving
Worker version. Use the [database recovery procedure](runbook.md#migration-rollback-and-recovery)
for a database regression.

Select a cutover build that preserves the code already serving after the
database handoff, including the shared queue and scheduled handlers. Qualify a
replacement build if the original candidate would undo a live fix.

## Match the staging evidence to the release

Select the intended release candidate SHA. While it is the tip of `main`,
dispatch [XFS qualification](../.github/workflows/xfs-qualification.yml) from
`main` with `qualify_cutover: true` and the intended `cutover_profile`. The
protected workflow builds the `main` SHA resolved at dispatch. Start
isolated qualification in parallel with ordinary shared staging qualification
where possible.

Parity runs with all Kit route families off and replays the packaged Kit
facade, adapter and assets. The packet also includes a separately compiled pure
Hono build. The manifest binds both file trees to the source SHA, configuration
and journal digests, run ID and attempt, and the Hono compiler define and
Wrangler pin.

The `isolated-cutover` job runs on the same main dispatch. It needs
`KIT_CUTOVER_TEST_DATABASE_HOST` and `KIT_CUTOVER_TEST_DATABASE_URL` in
the staging Environment for a dedicated synthetic Neon project with the
`two_web_cutover` control database and `two_web_cutover_owner` login.
It checks the exact serving UUID, readiness and route smoke at each transition,
then removes the run-owned Worker, database and expiring login.

| `cutover_profile` | Isolated rehearsal | Expected renderer evidence |
| --- | --- | --- |
| `all-off` | Hono → all-off Kit → same Hono UUID on both `1033` and `1037` | Public smoke stays on Hono throughout. |
| `ember` | Hono → Ember → same Hono UUID on both `1033` and `1037` | Kit serves Home, Events, Join and the same-origin Events calendar fragment on Ember. Admin and guest profile admission stay on Hono. |
| `admin` | Admin-off Ember → admin-on Ember → same admin-off Ember UUID on `1037` | Ember pages stay on Kit. Admin ownership switches to Kit and back to Hono. The synthetic checks cover default denial, operator bearer and browser session separation, and ownership after undo. |

In the [route smoke](../bin/smoke.mjs), Kit sends `x-two-renderer: kit` and
Hono omits the header. Guests must still get HTTP 404 for both `GET /members`
and `GET /members/`. Keyed profile lookup at `/members/:user` keeps its existing
access rules. Use the [frozen URL assertions](../test/frozen-url-method-ownership.test.ts)
for the retired directory contract.

Record the successful isolated job and cleanup, the proof's ledger states and
version UUIDs, and the packet and proof from the same run attempt. Those
artifacts are retained for 30 days. The production `cutover_pin` has the form
`run_id:run_attempt:manifest_sha256`, using the manifest digest from the proof.
To retry, select **Re-run all jobs** on the original dispatch. GitHub keeps
the original SHA and ref, and isolated staging uses the new attempt's packet.

Pair the isolated packet evidence with the
[shared staging deploy, smoke, E2E and soak](../CONTRIBUTING.md#merge-and-production-staging-evidence)
by matching the packet manifest's `sourceSha` to the deployed `sha` in the
scoped staging E2E receipts. The Actions run header can show a different SHA
because it records the workflow trigger. If `main` has advanced, reuse an
already valid matching packet or retry an existing dispatch for that SHA and
profile. If neither yields a valid packet, qualify a successor through the
same process.

Match the `sha` and `deployedAt` in the staging E2E before and after receipts
to the commit tag and upload time of the Cloudflare Worker version identified
by `/up`'s version UUID. This distinguishes separate uploads of the same SHA.
Use Cloudflare deployment history for that UUID and the staging E2E completion
time to verify the version served through the required soak. A replacement
before the soak finishes leaves the prior candidate unqualified. The isolated
job exercises the exact packaged bytes, the selected renderer profile and
its undo.

On pull requests that touch its qualification inputs, the
[XFS qualification job](../.github/workflows/xfs-qualification.yml) runs the
[installed Worker browser fixture](../ci/fixtures/kit-ember-cutover-browser.mjs).
It keeps Ember Home open in Chromium while the same loopback origin switches
from installed Kit output to the Hono entry point with its `public/` asset tree.
It reads a hashed stylesheet the browser loaded from Ember and checks its
immutable cache policy and build bytes. Fresh requests from the still-open
document must get a non-cacheable, `nosniff` 404 for the old stylesheet and the
same logo bytes that Ember served before the switch. Reloading Home must
return the Hono document. Use the hosted job log for this result. For a
manual rehearsal, get the serving version and public-route smoke results
from `kit-cutover-proof-<attempt>` in the isolated cutover job.
Existing browser cache entries can outlive the switch, and the fixture tests
fresh requests without depending on edge asset retention or browser cache
eviction.

## Protected release and recovery

Follow the [production release gate](../CONTRIBUTING.md#production-release-gate)
for each separate production operation. Approved PRs can keep merging to
`main` while production uses the exact approved candidate.

1. Pause automatic promotion with `PRODUCTION_AUTO_PROMOTE_DISABLED=true`
   for the protected switch. Dispatch
   [`deploy-production`](../.github/workflows/deploy-production.yml) from
   `main` with the full approved 40-character `sha` and its `cutover_pin`.
   Leave `migrations_applied` off. The cutover reads the actual ledger.
2. For all-off Kit or Ember, first select `cutover_mode: hono` with both undo
   inputs empty. After protected smoke and the watch pass, verify the prepared
   Hono UUID is serving 100% of production traffic. Use the **same** `sha` and
   `cutover_pin` to select `cutover_mode: kit` for all-off or
   `cutover_mode: ember` for Ember. Set `cutover_undo_version` to that live
   Hono UUID and leave `cutover_undo_digest` empty. The workflow checks the
   Hono version tag and its annotation for this packet's manifest digest.
3. After Ember reaches 100% and its production watch passes, record the
   serving Ember UUID and commit, the accepted Ember manifest digest,
   `KIT_ROUTE_EMBER_PAGES=true`, and `KIT_ROUTE_ADMIN` false or absent. Include
   Hono admin smoke and the watch receipt in the handoff to the admin release.
4. For admin, select `cutover_mode: admin` with its own approved `sha` and
   admin-profile `cutover_pin`. Set `cutover_undo_version` to the live admin-off
   Ember production UUID and `cutover_undo_digest` to that Ember packet's
   separately approved manifest SHA-256. The workflow verifies the live
   fallback's commit, tag, digest annotation, production `APP_URL` and Ember
   and admin bindings. The serving ledger must be `1037`. Use the UUIDs
   recorded from live production traffic for the undo inputs.

The protected workflow moves traffic through 5%, 50% and 100%, checking
health and renderer ownership. Confirm the promoted UUID and commit in
`/up`, retain the smoke result and watch health and errors for at least
30 minutes. In admin mode the protected live probe also confirms anonymous
operator requests are refused. The operator panel uses the separate
[bearer admission and secret procedure](operator-overrides.md#admission-and-custody).
Before resuming automatic promotion, confirm the approved next artifact keeps
the intended renderer ownership. Ordinary promotion requires the full target
ledger and uses its own build path.

On regression, use [`rollback-production`](../.github/workflows/rollback-production.yml)
from protected `main` with `environment: production`. Set `ref` to a supported
scripts SHA with green main push CI, as described in the
[rollback runbook](runbook.md#production-one-click-workflow). Set
`expected_current_version_id` to the promoted production UUID being undone.
For Ember or all-off Kit, set
`version_id` to the paired Hono UUID. For admin, set it to the recorded
admin-off Ember UUID. Verify the restored UUID and commit, database readiness,
and the fallback renderer ownership. The admin undo returns Admin to Hono
while keeping Ember's public pages on Kit.

## Optional offline Ember input readback

Before constructing the Ember workflow inputs, compare the selected candidate
and serving Hono undo recorded in the reviewed release evidence. Add this
section once to the evidence packet as a Markdown heading and text block,
keeping the field names and order. Enclose any archived examples in a fence.
Use the approved Ember qualification SHA and pin for the candidate fields.
Use the protected Hono dispatch's SHA and pin for the next two fields. Copy
the UUID from the recorded 100% serving readback into `hono_serving_version`.
Copy the version ID, tag and message annotation from that version's recorded
metadata into the last three fields.

````markdown
## Ember release input readback

```text
candidate_sha=<approved Ember SHA>
candidate_pin=<Ember run:attempt:manifest SHA-256>
hono_sha=<protected Hono dispatch SHA>
hono_pin=<protected Hono dispatch pin>
hono_serving_version=<recorded serving Hono UUID>
hono_version_id=<Hono version metadata ID>
hono_tag=<workers/tag>
hono_annotation=<workers/message>
```
````

```sh
node ci/read-ember-release-evidence.mjs < release-evidence.md
```

The command prints the mode, candidate SHA, pin, Hono undo UUID and bound
manifest digest after checking that the recorded values agree. It reads up to
512 KiB of local evidence. Keep `cutover_undo_digest` empty for Ember. Follow
the protected release steps for live verification, approval and dispatch.
