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
  production consumer invokes this helper yet. The separate
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
  Production does not consume this new helper yet. Permanent storage and integrated
  trusted cross-run consumption remain unimplemented; an expiring archive or
  arbitrary JSON file proves neither.

## Unimplemented

- Production Kit upload (`web/wrangler.production.jsonc` as a version of the
  existing script, with the web build and dependency install).
- A fail-closed, verified pure-Hono version pointer retained across Kit deploys.
  A version with no marker must not be classified as pure Hono.
- Production integration of the Kit upload and deployment receipt parsers,
  after a verified build and upload and only after successful promotion/smoke.
  The existing Hono bundle inventory, upload and deployed receipts are unchanged.

## Status

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
