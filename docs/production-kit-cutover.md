# Production Kit cutover: delivered slice

This page records only what is delivered. The production deploy still builds and
uploads the Hono Worker; nothing in `deploy-production.yml` uploads the Kit
build yet.

## Observed verification

[Actions 42495258968](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42495258968)
at `8c19ae5c8c38da45d3f61974fa2424d2f40b6b67` completed with **failure**.
Main lint/type/coverage and Node 22 each passed 26,757 tests (676 skipped);
all auxiliary jobs passed. The startup diagnostic stopped at its build stage,
but the retained canonical journal specifically records a successful build
return followed by **failed byte capture**. It has no receipt or frozen bytes.
Later frozen rehearsal, built fatal and production parity steps were not reached;
missing artifacts do not establish runtime verdicts.

Authenticated startup and build archives matched their metadata digests. A
bounded data-only reproduction of the 320 raw server/client/Cloudflare files
passed canonical file/group validation. No downloaded code was executed. This
does not reproduce the original directory topology: artifact upload omits empty
directory entries and does not establish the source filesystem's alias state.
The precise failing invariant is therefore **unknown**, not repaired or waived.
The journal now records only a fixed failure classification, never arbitrary
exception text, paths, generated contents or child output. Empty directories,
aliases and incomplete groups still fail; unknown exceptions remain unclassified.
New diagnostic and retained source-observer/authority fixtures await exact-head
Actions. No local suite, lint, build, install or deployment ran.

[Actions 42478341249](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42478341249)
at `a8f26bb2d9e93e7cbd831901ce15fb075a19361a` completed with **failure**.
Main lint/type/coverage passed 26,757 tests (676 skipped); Node 22 and all
auxiliary jobs passed. Kit typecheck/build, same-byte rehearsal, snapshot creation,
and the real frozen-input rehearsal passed, including serialized config and
prepared-input checks. Their fixture groups passed 24/24, 20/20, 42/42 and 29/29.
The built fatal fixture and all 3,313 all-off production parity vectors passed;
route and pre-hook asset-header comparisons had zero differences or exceptions.
These are prior-head fixture results, not operational qualification.

The later gradual-promotion acceptance step passed six tests and failed one:
its whole-file override count included a new documentation comment in the
unmodified shared-action mirror. Count non-comment source instead, retaining the
exact three-gate requirement and every quoted-override assertion. Added controls
prove a comment does not count and an additional executable override still does.
Focused reproduction of that one failing test failed before and passed after.
No action bytes, production guards or thresholds changed. The retained native
identity and canonical-tree helpers are not covered by this older-head run;
replacement exact-head Actions must verify them and this repair. No local full
suite, lint, build, install, account probe or deployment ran.

[Actions 42472988388](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42472988388)
at `f3de951a239df18c61c090148cfd104d53881f96` completed with **failure**.
Main lint/type/coverage passed 26,757 tests (676 skipped); Node 22 and all
auxiliary jobs passed. Kit typecheck/build, checked-tool/config/classifier,
same-byte rehearsal and snapshot creation/verification passed; all 35 snapshot,
20 multipart and 27 frozen-rehearsal fixtures passed. The real frozen rehearsal
then refused unexpected multipart membership. Built fatal and production parity
were not reached; missing artifacts are consequences, not runtime verdicts.

The authenticated build archive contains an adjacent `build/worker.js.map`.
Lock-SRI-verified Wrangler 4.156.1 source confirms `buildWorker` calls
`loadSourceMaps` unless `uploadSourceMaps === false`, then
`createWorkerUploadForm` attaches those maps as extra parts. The frozen rehearsal
now explicitly passes `--upload-source-maps=false` for its finite single-module
profile. The complete build map remains in the frozen archive; parser rejection
of extra modules/maps is unchanged. Both rehearsal and prepared-input invocation
records bind this choice. The focused invocation regression failed before the
repair and passed after; the real corrected Wrangler rehearsal is unverified.
The production uploader remains unchanged. Any future uploader consuming this
intent must preserve its explicit source-map choice or qualify a revised profile.
Serialized-config checks and the prepared-input descriptor are newly published
with this repair and remain **untested in Actions**. No corrected frozen
rehearsal, full parity or overall CI PASS is claimed; recovery gates are unchanged.

[Actions run 42468936442](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42468936442)
at `a888daf9358a5a7f20a71325a271bd40f60b8bc2` failed the snapshot fixture step:
34 passed and one failed. Its drift fixture replaced a script name in a comment,
not the actual config field. The fixture now targets the quoted `name` field,
requires a changed input and checks the specific config-contract rejection.
Focused local reproduction of that single test failed before and passed after
the repair. No production validation was weakened. Main lint/type/coverage
passed 26,757 tests (676 skipped); Node 22 and all auxiliary jobs passed. Kit
typecheck/build, checked-tool fixtures (40), asset classifier (17), source-config
fixtures (11) and same-byte rehearsal passed. Snapshot creation, frozen rehearsal,
built fatal fixture and full production parity were not reached. Missing fatal
and parity artifacts are consequences, not runtime verdicts. Retained finite-output
and multipart checks still await their first Actions execution. Syntax and
whitespace checks passed; no local suite, lint, build, install or deploy ran.

[Actions run 42464735477](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42464735477)
at `f6908d1c1f9abc02445f88107ca03522914d43d4` failed the Node 22 lint step
on formatting in `kit-frozen-inputs.mjs`, `kit-wrangler-tool.mjs` and its fixture
file. Tests did not execute in that leg. The exact reported layouts are repaired
without behavior, assertion or gate changes. Scope, docs-links and bundle-budget
passed; the main check, accessibility and Lighthouse were still running at
inspection. No new full-suite, installed-tool, snapshot or parity pass is claimed.
The adopted shared-action mirror was not among the reported formatter failures.
Syntax and whitespace checks passed locally; replacement Actions must verify the
correction. No local suite, lint, build, install or deployment ran.

[Actions run 42461060087](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42461060087)
at `7cba241d11a8ffa51932199a54d6df60b4a73a71` failed both test legs at lint.
Five local files and the byte-identical central `pre-promotion-check.mjs` mirror
failed formatting. The local layouts are repaired; the reviewed format-compatible
producer is now adopted at immutable v0.9.1 below. All five published files were
independently verified; only the verifier's formatting differs. No lint exclusion
or locally edited action fork is introduced. Tests, Kit build, classifier,
source-config and parity steps were not reached on that head; missing artifacts
are consequences, not runtime verdicts. The new frozen-input helper and fixtures
below have not run. Syntax, whitespace and workflow YAML parsing passed locally;
no local suite, lint, build, install or deployment ran.

[Actions run 42456798269](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42456798269)
at `457b6d5e7fa813852a469b3cc7f986d22520546f` also failed overall. Main coverage
passed 26,757 tests (676 skipped); Node 22 and auxiliary jobs passed. Kit
build/typecheck, same-byte rehearsal, built fatal fixture and all 3,313 production
parity vectors passed, with zero route/asset-header differences or exceptions.
The repaired deployment-gate selftest passed 168/168. The later notification
selftest passed seven and failed one: its staging-only exclusion assertion did
not account for the added production dry-run exclusion. The contract now pins
both exclusions on the actual notify job. Focused local reproduction of that one
previously failing test passed; no local full suite ran. New mirror, source-config
and asset-classifier results remain unobserved until replacement exact-head Actions.

[Actions run 42452358177](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42452358177)
at `bc4826fe5192aab93e89b6c2ffa3e97aa0af4999` completed with an overall failure.
Main and Node 22 each passed 26,757 tests (676 skipped). Kit typecheck, build,
same-byte upload rehearsal and the built fatal-response fixture passed. The
production-config comparison passed all 3,313 vectors with zero differences and
zero approved exceptions; the pre-hook asset security-header comparison also
reported zero differences. These are local-fixture Actions results, not deployed
production qualification or independent Security/QA acceptance.

The retained [build archive](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42452358177/artifacts/13607448082)
now includes both dry-run and replay output trees and the rehearsal receipt. It
is still build-only evidence, not Wrangler-selected asset evidence or durable
recovery custody. The run later failed two deployment-gate source assertions:
credential-reference counts had not included native pure-Hono capture, the
read-only dry-run report and archive verification. The count contracts are
updated to account for those exact steps while retaining environment isolation;
corrected overall CI remains unobserved. Earlier unobserved-result notes below
describe implementation-time evidence, not a green overall gate.

## Delivered

- `ci/kit-canonical-capture.mjs` now wraps the awaited adapter build within the
  existing startup diagnostic. With the workflow's explicit capture directory,
  it freezes all three trees immediately after the build operation returns,
  before upload serialization or profiling. The command, timeout, output cap
  and single execution remain unchanged. A failed build attempts byte retention
  but rethrows its original error, even if capture also fails. A successful build
  with failed capture still fails. An explicit journal boundary distinguishes
  this capture from a direct caller-requested snapshot.
  The following `always()` finalizer verifies the original frozen snapshot,
  identity and receipt, never recopies possibly mutated raw output. If the build
  never reached the capture boundary, it records unavailable without copying
  stale trees. A later startup failure preserves the snapshot but still fails
  the finalizer. Raw/partial output and the journal remain in the existing
  always-run bundle archive. No startup, budget, parity or production guard is
  suppressed. New fixtures and real wiring are **not yet run**.
  This is **same-source CI diagnostic retention**, not admitted B collection,
  accepted D or complete build-process provenance. The source-separated
  candidate/collector interface, candidate-owned execution and independently
  bound process/tool/image/input and final archive identities remain unfinished.

- `ci/kit-canonical-source.mjs` supplies a source-identity boundary for future
  separate Actions checkouts. Both full commit SHAs are explicit; only the fixed
  baseline B commit/tree has a mapping. Floating/default identities, unknown cells,
  equal or nested collector/candidate roots, dirty checkouts, unsupported tree
  members and altered tracked bytes/modes refuse. Every tracked file is compared
  with its pinned Git blob and recorded with SHA-256, including candidate-owned
  locks, configs, checkers, budgets, fonts and generator inputs. This also detects
  changes hidden from Git status by index flags. Collector and candidate receipts
  retain separate commit/tree/parent/file inventories; B's source patch is empty.
  A separate post-install observer requires the same unchanged tracked source,
  both real dependency directories and only the expected ignored generated CSS
  module plus those directories. It records bounded, non-empty generated-module
  and hidden npm-lock snapshots against the candidate's own generator/CSS and
  manifest/lock input hashes, then repeats the source and snapshot checks. Extra
  ignored env/build overlays, missing files and symlinked inputs fail. These are
  observations only: dependency contents and actual generator execution remain
  explicitly unverified. This observer is not installed-source execution or
  build-environment proof, and its new fixtures have **not run**.
  A source-bound authority loader now imports the candidate's own pinned
  `ci/bundle-inventory.mjs` in place, using a commit-specific module URL. It
  rechecks the entire source inventory after evaluation and exposes only frozen
  path/group constants plus the source and authority-file digests. Missing,
  altered, aliased, malformed or unsupported inputs refuse; module import errors
  are sanitized. This loads candidate code, not downloaded artifact data. The
  retention primitive still validates its canonical path/group contract. The
  loader does not execute the candidate checker, prove installed dependencies or
  runtime integrity, or supply the separated build caller. Its eight new test
  registrations use the existing Actions suite and have **not run**.
  The candidate startup loader similarly retains exact source digests for the
  startup module, runner module and bounded budget. It imports the candidate's
  existing serializer/profiler functions in place, validates its interface and
  budget, then rechecks source bytes after module evaluation and validation.
  It does not copy the CLI, invoke its build, collect profiles or inspect the
  runtime; execution remains explicitly unverified. Import/validation errors
  are sanitized, and changed or aliased source inputs refuse. Eight new fixture
  registrations use the existing Actions invocation and remain **unrun**. This
  is preparation for a single-build caller, not that caller or dependency proof.
  The real B-to-D positive binding is not
  exercised by the hermetic fixture repositories, which cannot recreate B's SHA.
  No checkouts, installs, builds, dispatches or collection are performed by this
  library. It is not wired to a candidate collection invocation yet. The eventual
  workflow still needs reviewed immutable D, the separated checkout/interface,
  actual build-process/tool/image/run provenance, immediate failure-retaining
  capture and independent archive identity verification. Fixtures are authored
  and wired for Actions, not locally executed; no working D or admitted B/P is
  claimed.

- The existing `ci/kit-upload-rehearsal.mjs` now also exposes bounded canonical
  byte-retention primitives. They copy all original files from the complete Kit
  server, client and Cloudflare trees, preserving repository-relative paths and
  hidden/non-budget members. An explicitly supplied canonical inventory selects
  the separate Worker/server-JS/client-JS/client-CSS budget subsets. Every file
  has raw size, independent `gzipSync(bytes)` size and SHA-256; groups and full
  membership have exact counts/sums. The snapshot reader recomputes these rows
  and rejects extra/missing/corrupt files, changed receipts, unsafe names,
  symlinked files/ancestors, empty trees/directories and authority drift. Exclusive
  creation does not overwrite an earlier capture. Node/zlib identities describe
  only the process doing the measurement.
  Fixtures are wired into Actions but **not run**. This is an unqualified byte
  primitive, not a working independently pinned collector: there is no separated
  candidate dispatch, admitted collection or performance-cell acceptance yet.
  The existing production rehearsal v1 receipt and uploader are unchanged.
  Remaining integration must independently separate collector and candidate
  sources, bind candidate-owned locks/config/checker/budgets and actual build
  process/tool/image/run provenance, capture immediately before diagnostics can
  change output, retain original failure statuses, and verify final archive
  membership/digests and artifact identity. Neither the current branch nor a
  helper receipt qualifies a baseline cell; required code/Security/QA/Actions
  review must accept the actual immutable collector before collection.

- `ci/kit-frozen-upload.mjs` prepares native identity association for the frozen
  input descriptor. It recomputes the descriptor from the supplied verified inputs,
  checked tool and serialized envelope, then requires exactly one native upload
  record for the expected script/default environment, no name override, a lowercase
  UUID and a matching named-version UUID/SHA-run-attempt tag. The existing required
  secret-name check also applies. Record-count/native-response bounds and fixed
  diagnostics prevent native binding values from entering the returned projection
  or error messages. Fixtures and Actions wiring are added but **not run**.
  This is a library helper, not an upload or native reader. The future trusted
  caller must invoke the checked uploader with those exact frozen inputs and
  obtain authenticated named-script readback; arbitrary JSON or matching tags
  alone do not establish that execution. No production workflow consumes the
  helper yet. Custody, successful-main attestation, current-environment
  qualification, non-versioned setting preservation and recovery gates are not
  established by this association.

- `ci/kit-frozen-intent.mjs` constructs a digest-bound prepared-input descriptor
  only after the rehearsal rechecks the snapshot, checked Wrangler and serialized
  module/config. The retained rehearsal receipt includes its SHA/run/attempt,
  target, snapshot/tool/Worker/asset-input/serialized-config/multipart digests and
  portable intended upload paths, no-bundle flag, default environment and absence
  of a name override. A final digest binds the complete descriptor. The constructor
  also checks lock agreement and the serialized module identity, with fixed
  diagnostics. Fixture tests and the integration assertions are wired but unrun.
  This descriptor is **not an executed upload**, authenticated provenance, a
  complete runtime/environment qualification or a grant to upload. The production
  uploader does not consume it yet; intent-to-native-UUID/tag association and all
  custody/qualification/release guards remain unfinished. The recorded hashes
  associate already-verified objects; arbitrary supplied JSON is not verification.

- `ci/kit-frozen-rehearsal.mjs` adds a second, dry-run-only `versions upload`
  that consumes the reverified snapshot's built Worker, source config and complete
  adapter directory. Explicit absolute entry/config/asset paths avoid original
  source inputs and generated-config discovery. The `--assets` override changes
  only the directory; the reviewed binding and Worker-first policy remain in the
  config. Installed-tool lock digests must match the frozen locks. The child gets
  a fresh cwd, HOME, XDG config and temp directory, with an explicit environment
  containing no inherited credentials, Node preloads or Wrangler overrides.
  Execution is bounded to two minutes and 1 MiB captured output; no child output
  or auth/log cache is retained as evidence. Snapshot and tool are rechecked after
  exit, and the emitted Worker must equal the frozen bytes. The output directory
  must contain exactly `worker.js` and Wrangler's non-empty README (at most
  64 KiB), both regular files; extra files, hidden members, subdirectories and
  symlinks fail. The receipt records both file sizes and digests. This finite
  emitted-file contract matches the retained pinned-Wrangler replay. Additional
  fixture controls cover unexpected modules/maps/directories and malformed README
  entries. The rehearsal also requests Wrangler's supported `--outfile` into a
  private, unarchived path. `ci/kit-multipart-modules.mjs` requires exactly the
  metadata part and one byte-identical `worker.js` module with the reviewed MIME
  type. It rejects extra parts, unexpected headers/framing and malformed or
  oversized metadata; only metadata digests and bounded binding names/types enter
  the receipt. Raw metadata is unlinked on success, child failure or parse failure.
  `ci/kit-multipart-config.mjs` additionally compares the serialized compatibility
  date/flags, exact binding objects and values, keep-bindings categories, tail
  declarations and empty annotations against the reverified frozen source config.
  Unknown semantic fields, missing/extra/inherited bindings and changed values
  fail with fixed diagnostics, never raw binding diffs. The sanitized receipt
  names the checked fields and hashes their normalized contract. Optional package
  instrumentation is shape-bounded separately and explicitly unverified, with no
  values copied to the receipt. This checks only fields serialized by the dry
  run, **not** synchronized assets/control policy, actual inherited remote values
  or non-versioned setting preservation. A serialized tail declaration is not
  proof that the active tail consumer is preserved; observability is omitted by
  this Wrangler upload path. New fixtures and integration remain unrun. Only the
  digest-bound receipt and dry-run output directory enter the existing Actions
  archive. Fixtures and the real rehearsal are wired but **unrun**. This is not a native
  upload, selected-asset metadata, remote readback, complete normalized config,
  transitive/runtime attestation, custody or recovery qualification. Dry-run skips
  asset synchronization, so it cannot validate the live asset manifest/guards.
  Production upload and the required-but-absent recovery verifier are unchanged.

- `ci/kit-wrangler-tool.mjs` compares the root installed Wrangler package's exact
  published file membership, sizes and SHA-256 digests against the checked-in
  `ci/kit-wrangler-package-pin.json`. The pin was computed without extraction or
  execution from the 4.156.1 registry archive after verifying its SHA-512 SRI
  against both lockfiles. The 30 published regular files include the actual
  `bin/wrangler.js` launcher and `wrangler-dist/cli.js` runtime. Both locks must
  retain the version, resolved URL, integrity and entry mapping; installed package
  identity/entry mapping, unsafe paths, symlinks (including ancestors), unexpected
  directories and missing/extra/changed files fail. Actions invokes that checked
  launcher directly through Node for the production Kit build and same-byte
  rehearsal, avoiding npx resolution/acquisition, and compares tool/lock receipts
  before build, before replay and after replay. Inherited NODE_OPTIONS/NODE_PATH
  must be empty in both steps. Fixtures and real-package checks are wired but
  **unrun**; the installed package is absent from this source worktree.
  npm's root nested `node_modules` subtree is explicitly excluded: it contains
  separate transitive packages, not published Wrangler files. This is NOT their
  integrity proof, Node runtime attestation, complete effective-environment
  evidence, protection against a concurrent install, or proof of a production
  upload. The trusted job must exclude concurrent package writers. No dependency
  was installed/updated; production upload is unchanged. Future upload-intent
  integration must bind these receipts and the remaining dependency/runtime/env
  evidence rather than treating a version string or this package check as the
  whole toolchain qualification.

- `ci/kit-frozen-inputs.mjs` creates a new, exclusive local snapshot of both
  dry-run output trees, the complete adapter tree and six fixed source inputs
  (both source configs, wrapper, headers and lockfiles). It reuses the finite
  asset/source-config contracts, checks Worker/replay equality, rejects unsafe
  paths/symlinks/non-regular files and bounds file counts and bytes. Copied files
  are 0444 and directories 0555; exact file/directory membership, digests, context
  and modes are recomputed after locking. Copies are not links. Source changes
  during copying fail; the job must still exclude concurrent input writers.
  Actions fixture/snapshot/verification and artifact retention are wired but
  **unrun**. The owner can reverse these modes; they are neither WORM nor custody.
  An archive transport may discard modes and must restore and reverify them
  before any future use. This snapshot is build-input evidence only, not
  Wrangler-normalized config, executable integrity, an upload intent/native UUID,
  attestation, durable recovery retention or current-environment qualification.
  Production upload does not consume it yet.

- The production promotion caller pins the unmodified central action at
  `97cadcb231e55fad95cbc6468be078ecef571bc2` (`v0.9.1`). The complete five-file
  hermetic mirror includes its README and pre-promotion runner, with raw hashes
  and the normalized manifest hash appended to the existing SHA mapping. The
  delivered analytics helper includes the independently reviewed observation-budget
  correction. The isolated synthetic proof workflow retains its older pin.
  The production caller explicitly requires the fresh per-mutation verifier, but
  does not yet configure one: the shared runner refuses before the first 5%
  mutation. This is an intentional fail-closed intermediate state, not a working
  recovery verifier, custody qualification, production acceptance or release-ready
  pipeline. The existing build-archive verifier is not substituted for fresh
  custody/attestation/current-environment qualification. The same runner boundary
  executes immediately before 50% and 100% once the real verifier is integrated;
  rollback and changed-secret/resource guards remain required.

- `ci/kit-source-config.mjs` checks the all-off Kit source configuration against
  an explicit projection of the root pure-Hono production configuration. Unknown
  top-level/environment fields, extra Kit overrides, family enablement and changes
  to the declared compatibility, asset routing, bindings, jobs or tail fail the
  source contract. Actions retains `source-config.json` with both raw config
  digests and separately declared non-versioned routes/tail/triggers. Its fixtures
  and real-config invocation are wired but have not run. This is source-config
  evidence only: it does not establish Wrangler-normalized defaults, actual CLI
  overrides/environment, strict native binding/secret inheritance or preservation
  of current live settings. Frozen snapshot, invoked-tool verification and
  archive-to-upload association remain separate unfinished requirements.

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
renamed as native asset selection. The November 8 technical decision retains
unmodified Wrangler 4.156.1 `versions upload`: a native manifest receipt is not a
requirement. The replacement proof is a complete frozen archive, independently
checked finite file/ignore/config semantics, archive-to-intent-to-native-UUID
association, authenticated successful-main provenance and custody, exhaustive
asset verification, and both actual on-demand staging recovery drills. This is
input/process and qualified-recovery evidence, not remote byte readback. No
custom uploader, private Wrangler imports or hash-algorithm replica is selected.

The first source slice, `ci/kit-complete-assets.mjs`, independently classifies the
current adapter directory into public URL/member/size/SHA-256/MIME rows, Worker
inputs, raw control inputs and ignored build-only rows. It accepts only the exact
adapter 8.0.2 literal ignore bytes, with no source prefix. Unknown patterns,
negation, unexpected nested special names, symlinked ancestors/tree entries,
non-regular files, URL aliases, case collisions and unknown MIME extensions fail.
The basename/subtree rules apply to `_worker.js`, `_routes.json`, `_headers` and
`_redirects`; a nested special name outside the declared root Worker subtree is
rejected rather than silently classified. Root `_headers` and optional
`_redirects` are semantic inputs, never served-file claims. JSON has no charset;
only text MIME types gain UTF-8, following the pinned upload helper. The published
Wrangler asset helper uses the bundled mime 4.0.7 table, including
`image/vnd.microsoft.icon` and `application/manifest+json`.

Actions runs the new hermetic negative controls and records
`public-assets.json` beside the existing rehearsal evidence after the real
adapter build. These changes are not yet tested. The classifier does not freeze
inputs, verify the effective production config or executable, produce an upload
intent, or qualify recovery. Before/after hashes alone are not a read-only upload
snapshot. The pure-Hono profile remains separate and unimplemented. No counts
are hardcoded as file allowlists. Unsupported layout/ignore changes require a
reviewed profile, not an ignore rewrite or general gitignore implementation.

Still required before upload acceptance: observed snapshot/negative-control
results and an uploader that consumes only the reverified snapshot, effective
module/config/control semantics, invoked Wrangler/lock integrity, digest-bound
intent and guarded native version/tag
readback, then attested successful-main custody and actual recovery drills.
Pinned upload may patch service/environment tags; non-versioned routes, tail,
jobs, schedules and settings need current identity/preservation evidence rather
than assumed multipart preservation. No account probe or upload is authorized by
this source slice. Production still uploads Hono.

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
