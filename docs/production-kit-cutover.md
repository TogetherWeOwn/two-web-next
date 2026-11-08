# Production Kit cutover: delivered slice

This page records only what is delivered. The production deploy still builds and
uploads the Hono Worker; nothing in `deploy-production.yml` uploads the Kit
build yet.

## Delivered

- `deploy-production.yml` has a `kit_route_family` dispatch input (`hono`,
  `archive`, `archive-static`; default `hono`). Schedule and `workflow_run`
  promotions always use `hono`. Preflight validates the value with
  `ci/kit-route-flags.mjs` and exposes `kit_route_family`, `kit_archive` and
  `kit_static` as job outputs. No step consumes them, so the input changes
  nothing that deploys.
- `rollback-production.yml` takes `dry_run` (default `false`, also on
  `workflow_call`). A dry run keeps the environment, gate, version id,
  credential, live-version guard and target-secret checks, prints what a real
  run would do, and stops: no `wrangler rollback`, no smoke, no dead-letter
  capture, no notification, no versions deploy, no migration. It still waits for
  the `production` Environment approval because the checks need production
  credentials.
- `test/kit-production-operations.test.ts` pins these source facts, with no
  runtime claim: `web/wrangler.production.jsonc` only produces to the two
  production queues and declares no consumers and no crons; the root
  `wrangler.jsonc` still points at the Hono entry `src/worker.ts`, which exports
  `fetch`, `queue` and `scheduled`, and its production env is produce-only;
  `wrangler.jobs.jsonc` `env.production` (`two-web-jobs-production`) is a
  separate Worker with no routes that consumes those same queues and owns both
  crons; the production Tail `ALERT_ROUTES` equals the Hono route inventory
  (no Kit route ids), and `/about`, `/faq` and `/rules` keep the same Hono route
  label whether served directly or through the Hono catch-all dispatch.

- The production Kit config enters through `web/worker.js`, which delegates
  once to the unchanged adapter-generated Worker, then runs
  `protectKitWorkerResponse`. Kit can render its fatal `error.html` or rebuild a
  response after the hook has returned. This outer boundary restores missing
  security headers without retrying the request. Complete Hono, Kit and asset
  envelopes pass through unchanged, including their CSP, cache policy, cookies
  and renderer label. Incomplete responses get the shared path/method policy,
  no-store, origin/renderer labels and a safe request id; HTML errors carrying
  the exact existing fallback style receive its existing hash allowlist. The
  template, style bytes and allowlist are unchanged. Synthetic regression cases
  and an Actions built-Worker fatal fixture are verification sources, not a
  recorded PASS or independent Security approval.

- Actions rehearses the production-config Kit `versions upload` with `--dry-run`
  and `--no-bundle`, then requires its output Worker to equal the dry-run build
  byte for byte. The build metafile and both output directories are retained for
  14 days, keyed by source SHA, run and attempt. This is build-only evidence, not
  an upload/deployment receipt or a non-expiring rollback pointer. The new
  `ci/kit-upload-rehearsal.mjs` receipt binds the compared Worker bytes, metafile,
  complete adapter asset-build tree (including control files), production config,
  wrapper and both lockfiles to the source SHA, run and attempt. It rejects missing
  required build files, empty or changed Worker bytes and symlinked tree entries.
  This tree is not Wrangler's uploaded-asset selection; no version identity or
  package-absence eligibility is claimed. The existing Hono inventory, upload and
  deployed receipts remain unchanged. Receipt generation and its negative-control
  tests are wired into Actions; a result has not yet been observed.

- `ci/kit-upload-evidence.mjs` recomputes that receipt before accepting it,
  rejecting stale SHA/run/attempt, changed bytes and added or removed build files.
  Its native-upload receipt parser requires one Wrangler upload record for the
  production script, no named environment or name override, and a version UUID.
  The deployment parser binds the promoted UUID to that upload and the full local
  build digests. Fixture tests cover both parsers; neither is consumed by the
  production workflow yet. These are distinct Kit schemas, not an expansion of
  the Hono inventory's package-absence eligibility. A native version record plus
  local digests is not remote byte readback or proof of Wrangler's asset selection.

- `ci/pure-hono-rollback.mjs` defines a separate rollback-pointer evidence
  contract. Its CLI first recomputes the original Hono inventory, then requires
  the matching smoke-verified deployment receipt, the native version UUID and
  exact SHA/run/attempt tag, and the existing required-secret-name check. It
  rejects Kit source inputs, Kit/Svelte packages (including tree-shaken inputs),
  unknown runtime externals and inventories without the Hono entry/package.
  The sanitized record includes the original bundle/inventory digests and
  `expiresAt: null`; exact verification rejects added fields or any expiry.
  The production workflow now invokes `capture` only after its Hono bundle is
  bound to the smoke-verified promoted UUID. Capture reads that exact UUID from
  `two-web-next-production` using a bounded, captured Wrangler subprocess, then
  validates its tag and required secret names. Only the sanitized pointer enters
  the existing 30-day bundle archive; native binding values and child-process
  output are neither printed nor archived. The lookup and workflow fixture tests
  are wired into Actions but their result is unobserved. No native version has
  been read or target classified for this change. The inventory can be reverified
  after capture adds its exact non-runtime pointer sidecar; additional runtime
  files still fail closed, and the pointer needs its own separate verification.
  The exported `verifyPureHonoProvenance` checks authenticated GitHub run/artifact
  metadata for the expected repository, main-only production workflow, successful
  supported event, exact run/attempt and candidate-keyed archive name. It binds
  the artifact's workflow SHA to the producer's workflow tip, which may differ
  from the promoted candidate SHA. Its negative-control tests are prepared, not
  observed passing. `ci/pure-hono-archive.mjs` now composes that validator with
  authenticated, bounded GitHub run/artifact reads and a digest/size-checked zip
  download. Only the fixed GitHub API receives the bearer token; the allowed
  HTTPS artifact host receives no token and cannot redirect. Failed credentials
  do not retry, and errors never echo remote bodies, signed URLs or tokens. The
  destination is created exclusively after byte verification, with no extraction
  or execution. Fixture tests are wired into Actions, not observed passing. No
  production-deploy step invokes this helper yet. The separate
  `ci/read-pure-hono-archive.py` reads only the exact flat Hono archive members in
  memory, rejecting duplicate or unsafe names, special files, encryption,
  unsupported compression, CRC failures and oversized expansion. It never extracts
  or executes archive files. `ci/pure-hono-archive-contents.mjs` checks those member
  hashes against the inventory, metafile, upload/deployed receipts and supplied
  rollback pointer, then requires a fresh native version object through the existing
  tag/secret checks. It consumes the authenticated transport receipt; historical
  source/dependency input verification belongs to that trusted successful producer,
  not this consumer. Its result is an authenticated-producer archive receipt, not
  independent source recomputation, remote byte readback or permanent retention.
  The Python child gets no inherited environment credentials or downloaded cwd.
  Fixtures are wired into the existing Actions evidence step; results are unobserved.
- `ci/verify-pure-hono-archive.mjs` composes authenticated download, bounded archive
  inspection and a fresh named native version read. It pins the pointer's UUID to
  the separately requested rollback UUID before any download, requires a new empty
  private directory and writes only an exclusive private verification receipt.
  The pointer file is bounded to 16 KiB and must be a regular non-symlink file;
  downloaded files never become code, working directories or subprocess arguments.
  Errors and child output are sanitized. Injected collaborator and CLI-refusal
  fixtures are wired into Actions; they have not run.
  `rollback-production.yml` optionally accepts `pure_hono_pointer` (JSON) and
  `pure_hono_artifact_id` together. Supplying either requires both and restricts the
  evidence check to production; it runs after credential validation but before the
  live-version guard, target-secret check, dry-run report or rollback. The verified
  receipt alone is archived for 30 days, not the downloaded archive or native body.
  Existing callers that supply neither keep the ordinary rollback path and all its
  guards. This makes cross-run verification available for the requested pure-Hono
  rollback dry run; it is not a mandatory Kit promotion gate or an observed drill.
  No verification or native lookup has run against production for this change.
  Permanent storage remains unimplemented: an expiring archive or arbitrary JSON
  file proves no retained rollback capability.

## Unsupported acceptance boundary

Cloudflare's [rollback contract](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
limits rollback to the 100 most recently published versions. No supported
indefinite pin for the original pure-Hono UUID has been established. This limits
rollback eligibility; it does not establish when stored version bytes are deleted.
A successful lookup today, an annotation, a saved UUID or `expiresAt: null` cannot
prove indefinite deployability. Re-upload creates a new UUID, so durable bundle
storage alone cannot satisfy an indefinite original-UUID rollback requirement.

The cutover cannot be accepted against that literal requirement. The acceptance
owner amended it to durable, qualified pure-Hono recoverability, with technical
acceptance of revision 2 recorded on November 8, 2026. The first revision was
rejected; the second separates native rollback eligibility from the standing
archive-recovery requirement. This is an effective specification, not operational
acceptance, storage implementation authority or production permission.

Every promotion must fail closed unless the archive is retrievable, its expected
successful-main workflow attestation and all file digests verify, and archive-to-
new-UUID recovery is qualified for the target script and current environment.
Original-UUID eligibility is recorded separately: only `eligible+compatible` makes
it the first-choice path. Explicit ineligibility or incompatibility selects the
qualified archive path without failing that gate. Unknown eligibility never
counts as eligible; missing, unknown or stale archive qualification blocks
promotion. The historical UUID remains recorded permanently, not promised
indefinitely deployable. Each production recovery still needs its own Release
Manager decision.

DevOps owns custody. The specified mechanism is a content-addressed prefix in the
existing R2 store, protected by a prefix-scoped indefinite bucket-lock rule, with
main-only writes, read-only recovery/qualification and no routine delete rights.
[R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
prevent overwrite/deletion while the rule exists; rules are removable, not
irrevocable WORM. Account support, actual grants/token scope, cost and terms are
unverified. Existing DB-backup storage does not prove recovery-prefix custody.
Expiring Actions artifacts and mutable release attachments do not satisfy it.
No secret values enter recovery archives. Any new spend, new/rescoped credential
or security weakening requires its existing separate decision before proceeding.

Qualification binds one archive digest, the target script and an environment
snapshot: complete assets and headers, effective config, schema/data contract,
binding/resource identities, authorized secret names/presence, routes, triggers,
jobs, tail consumer and runtime. Relevant changes invalidate qualification before
the next promotion. Native changed-secret/resource guards remain; re-uploading
bytes under a new UUID does not cure incompatibility. Both initial isolated,
on-demand staging drills remain required while the staging original UUID is
eligible, with parity/security/smoke before, during and after, recorded identity
and digests, and cleanup. A dry run is not a drill.

Retirement requires the acceptance owner's recorded decision, technical acceptance
of any replacement, applicable security/release gates and retention/qualification
of the replacement before removing the old lock/archive, with a release-log
record. Custody, complete archives/attestation, compatibility and both drills are
still unverified, so the operational archive gate remains failed. Production
stays Hono. Independent Actions, parity and source preparation continue; existing
QA/Security, exact-head checks, migration/rollback guards, gradual rollout/watch
and Release Manager gates remain. Calendar waiting is not reinstated.

## Wrangler asset-selection evidence boundary

Pinned Wrangler 4.156.1 does not compute or emit its selected asset manifest in a
`versions upload --dry-run`. Its
[versions upload helper](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.156.1/packages/deploy-helpers/src/deploy/versions-upload.ts)
calls `syncAssets` only when assets exist and `dryRun` is false. The
[asset helper](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.156.1/packages/deploy-helpers/src/deploy/helpers/assets.ts)
builds the path-to-hash/size manifest inside that call and sends it to the asset
upload session. Dry-run multipart output therefore supplies no native selected-
asset manifest either. This source inspection is not an upload or account probe.

The rehearsal's complete adapter tree is useful build evidence but cannot be
renamed as native asset selection. No supported dry-run selection-output contract
has been established. Do not add a speculative `.assetsignore` parser, infer
selection from debug listings or perform a real upload merely to fill this gap.
Upload evidence integration still needs an exact selection/provenance mechanism
and its applicable authorization; neither this note nor the recovery-spec
amendment supplies that capability.

## Unimplemented

- Production Kit upload (`web/wrangler.production.jsonc` as a version of the
  existing script, with the web build and dependency install).
- Mandatory qualification and custody integration for the accepted pure-Hono
  recovery contract, with original-UUID eligibility recorded separately. A
  version with no marker must not be classified as pure Hono.
- Production integration of the Kit upload and deployment receipt parsers,
  after a verified build and upload and only after successful promotion/smoke.
  The existing Hono bundle inventory, upload and deployed receipts are unchanged.

## Status

[Actions 42449149027](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42449149027)
at `c39afac1ce1e6c921f2cd0e1bf62308d9fba9884` failed one architecture-document
module-map assertion in both main and Node 22 suites: the new
`src/kit-worker-dispatch.ts` entry was missing. Each suite reported 26,756 passed,
one failed and 676 skipped tests. Lint and typecheck passed; scope, docs-links,
bundle-budget, accessibility and Lighthouse passed. The map now includes that
entry without changing the assertion. Corrected results are pending. Kit build,
fatal, rehearsal and full parity were not reached; missing-artifact errors are
consequences, not runtime verdicts. No complete corrected replay archive is
available from that run.

[Actions 42443536920](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42443536920)
at `fcd64cb306de8c1ac177f10865e4ff2091b65932` passed the main lint/type/coverage
step, Node 22 compatibility, Kit typecheck, production-config build/rehearsal and
built fatal-response proof. Both suites reported 26,722 passed / 676 skipped.
The full production comparison failed: 3,313 vectors, 258 differences and zero
approved exceptions. All 57 generated-asset header paths passed. The differences
are Hono-owned admin/member data redirects rewritten by Kit after the hook, plus
Discord fixture reads on `/events` and `/`. The production entry now bypasses Kit
only for Hono-owned production data requests, using the existing ownership
manifest and the unchanged Hono handler. Ordinary documents and Kit-owned data
still enter the adapter. The parity harness assigns its healthy-empty Discord
seam onto the original environment so both ambient Kit and Hono reads see it.
Corrected runtime results remain unobserved; the comparison is not weakened.

The [retained archive](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42443536920/artifacts/13603722222)
has SHA-256 `ba0379b4116596db275b91f65f1725f0c0c0c75b7a0d4a611b3bec91609c5bae`.
All 97 adapter-tree and four dry-run member hashes match the rehearsal receipt.
The two replay members are absent despite the successful executed rehearsal.
Build/replay output and artifact inputs now share workspace-relative storage,
avoiding the container's mismatched host `runner.temp` paths; corrected retention
has not been observed. This expiring archive is not permanent rollback storage.

The optional rollback archive consumer validates the requested UUID separately
from the pointer, checks authenticated archive contents and native version
identity, and writes a sanitized private receipt before the existing rollback
guards. It is not yet a required Kit promotion gate. Production still uploads
Hono. Permanent retention, Kit deployment integration, drills, complete parity,
independent review and all exact-head release gates remain unfinished. No staging
or production workflow or rollback drill has run for this change.

### Earlier producer results

Branch-dispatch [Actions 42438575212](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42438575212)
at `98ca49a7438853e9460951252709c03e036047a5` passed the main lint/type/coverage
step, Node 22 compatibility and Kit typecheck (zero errors/warnings). It failed
before the production-config Wrangler dry run: the container's default `sh`
rejected `set -o pipefail`. Both production dry-run/replay steps now select Bash
explicitly, with a regression contract; the corrected result is not observed.
Its retained adapter archive contains `_worker.js`, `_headers`, `.assetsignore`,
`version.json` and immutable assets, but no production dry-run outputs or upload
rehearsal receipt. It is not complete cutover/rehearsal evidence. No fatal-response,
production parity or upload-rehearsal PASS is recorded here. No staging or
production workflow or rollback drill has run for this change.

The subsequent [Actions 42442355577](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42442355577)
at `cbd9d3e9118521fbbde367c118c2d18378e8a762` failed the main and Node 22 lint
gates on formatting in three rollback-evidence files. Scope, docs-links,
bundle-budget, accessibility and Lighthouse passed. Tests and Kit build/rehearsal,
fatal-response and production parity steps were not reached. The reported layouts
are corrected without changing behavior or assertions; corrected results remain
unobserved. Its artifact list contains no complete adapter tree or rehearsal receipt.
