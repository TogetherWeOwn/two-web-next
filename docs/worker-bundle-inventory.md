# Digest-bound Worker bundle inventory

This is the producer contract for the **production Hono app Worker only**
(`two-web-next-production`, `wrangler.jsonc`, environment `production`). It
complements the [performance budget inventory](performance-budgets.md); it does
not replace that check. Kit/staging, jobs, Tail Workers and the advisory plugin
consumer are outside this pilot.

## Build once, then bind deployment evidence

The lockfile installs Wrangler 4.156.1 and its esbuild 0.28.2 dependency. The
installed `wrangler deploy --help` exposes `--metafile [path]`; an explicit path
avoids relying on the default `bundle-meta.json` placement:

```sh
npx wrangler deploy --dry-run --env production --outdir dist-production \
  --metafile dist-production/bundle-meta.json
node ci/worker-bundle-evidence.mjs create dist-production
node ci/worker-bundle-evidence.mjs verify dist-production
```

The CLI requires `BUILD_SHA` (40 lowercase hex), `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT` (positive decimal strings). CI supplies these, never guesses
from a branch name. A local pilot may explicitly use a fixture run ID and the
checkout SHA; it is not a GitHub run or deployment claim.

The CI `check` job publishes `worker-bundle-build-<sha>-<run>-<attempt>`.
It additionally exercises `wrangler versions upload --dry-run --no-bundle` and
compares the resulting entry bytes to the inventoried file. **This is build-only
evidence, not proof of deployed exposure.**

The production workflow:

1. Checks out the gated source SHA, installs its lockfile, builds once with the
   native metafile and creates the inventory. Evidence tooling comes from the
   workflow tip, including when redeploying an older target. Unsupported older
   toolchains/output shapes fail closed; do not bypass the check for a rescue
   redeploy.
2. Revalidates the entire inventory immediately before upload. Uploads
   `dist-production/worker.js` with `wrangler versions upload --no-bundle`, not
   another build. Wrangler loads the adjacent sourcemap using the preserved
   sourceMappingURL. Assets and bindings still use the production configuration;
   this inventory covers runtime JS, not the asset upload or binding values.
3. Reads Wrangler's native `WRANGLER_OUTPUT_FILE_PATH` JSONL. Requires exactly one
   `type: version-upload`, `version: 1` record with the expected Worker,
   environment and valid version UUID. Writes a sanitized `upload.json`, never
   archives the raw output file. An upload is not a promotion.
4. Runs the existing gradual promotion and ordinary-traffic, version-aware smoke.
   Only after they succeed, requires the promoted UUID to match `upload.json`
   and writes `deployed.json` binding that UUID to the inventory and bundle
   digests. Existing promotion receipts and rollback/watch gates remain intact.
5. Publishes `worker-bundle-production-<sha>-<run>-<attempt>` (30-day retention).
   Failed runs may retain diagnostic **build/upload-only** artifacts; a missing
   deployment receipt is never an absence result. Use the existing successful
   `production-promotion-<sha>-<run>-<attempt>` receipt as an additional check of
   source SHA, run identity and promoted version.

A deployment receipt records successful promotion and smoke at that time. It is
not proof that the version is still live after a later deployment or rollback.
Rollback reuses an existing version; recover that version's original inventory,
not the most recent inventory. Never use an expired artifact as a clean result.

## Versioned artifact contract

All paths use `/`. All hashes are lowercase SHA-256 over **raw file bytes**,
not parsed/reformatted JSON. All sizes/contributions are nonnegative integer
bytes. Inventory ordering is deterministic for a given build/run/toolchain.
The artifact contains these files:

| File | Contract |
| --- | --- |
| `bundle-meta.json` | Unmodified native esbuild metafile, including all inputs, import edges, outputs and per-output `bytesInOutput`. No reachability is invented. |
| `worker.js`, `worker.js.map` | Exact dry-run outputs. Both are hashed; only the JS is the runtime bundle digest in v1. |
| `inventory.json` | Schema `two.worker-bundle-inventory.v1`, always `evidence: build-only`. See fields below. |
| `upload.json` | Optional schema `two.worker-bundle-upload.v1`; proves the verified prebuilt upload's version UUID in this workflow. |
| `deployed.json` | Optional schema `two.worker-bundle-deployment.v1`, `evidence: promoted-and-smoke-verified`; required for deployed-runtime filtering. |
| `README.md` | Wrangler's generated informational file, not a runtime module or integrity root. |

`inventory.json` fields:

- `sourceSha`, `runId`, `runAttempt`, `target`, `environment`: required identity.
- `tools`: exact `node`, `wrangler`, `esbuild` versions. The latter is resolved
  from Wrangler's dependency, not assumed to be a different top-level esbuild.
- `build`: native command, `config` and `lockfile` file records. A file record
  contains `path`, `bytes`, `sha256`.
- `metafile`: file record for `bundle-meta.json`.
- `bundle`: `algorithm: sha256`, `entry: worker.js`, `sha256`: SHA-256 of that
  **single JS module's raw bytes**, not the GitHub zip or sourcemap digest.
- `outputs`: artifact-relative output file records (`worker.js` and map).
- `inputs`: repository-relative file records, plus `packageRoot` (string or null)
  and summed `bytesInOutput`. Inputs absent from output contributions get zero.
- `packages`: `{name, version, manifest}` records, where `manifest` is a hashed
  package.json file record. Multiple installed versions remain distinct by path.
- `externals`: sorted distinct external output import specifiers.
- `unknownExternals`: externals other than recognized Node builtins and the
  supported `cloudflare:sockets`/`cloudflare:workers` platform imports.
- `absenceEligible`: true only if `unknownExternals` is empty.

`upload.json` and `deployed.json` contain `sourceSha`, `runId`, `runAttempt`,
`target`, `environment`, `versionId`, `bundleSha256` and `inventorySha256`.
The latter hashes the raw `inventory.json`, which hashes the raw metafile and
all output files. The deployment receipt must agree with the upload receipt in
every identity/digest field. Unknown schema versions are unsupported, not empty.

V1 deliberately accepts only a single `worker.js` and map output pair. Unknown
additional files/modules, missing or unreadable inputs, noncanonical paths,
escapes outside the checkout, leaf symlinks, empty metafiles, inconsistent
metafile sizes, stale SHA/run identity or changed source/config/lock/package
manifests fail before upload. Virtual/plugin inputs not backed by a readable
file also fail closed. Expanding this contract requires explicit coverage,
including Wrangler's additional-module collection outside esbuild outputs.

## Consumer instructions (vuln-sentinel or another advisory judge)

Do not trust an arbitrary uploaded JSON document or let it select its own
expected SHA/version. Establish the deployment identity independently first.

1. Select a trusted successful `deploy-production.yml` run in this repository.
   Match expected source SHA, production target/environment, run ID and attempt.
   Fetch that run's exact artifact by ID, checking the GitHub artifact digest and
   trusted workflow provenance. The zip digest is a separate transport-integrity
   check; do not confuse it with `bundle.sha256`. Reject expired/missing artifacts.
2. Extract into a fresh empty directory as data. Reject traversal, symlinks,
   duplicate or unexpected files. Never execute the bundle or an artifact script.
3. Require supported inventory/upload/deployment schemas and all identity fields.
   Validate the raw inventory hash against both receipts; validate metafile and
   every output's raw size/hash against the inventory. Require bundle digest to
   equal the `worker.js` hash, upload digest and deployment digest. Check the
   promotion receipt's version against the same UUID. Missing or malformed proof
   yields **unknown**, preserving the advisory for investigation.
4. If the decision concerns *current* deployment, independently match the live
   version UUID (including every active version in a split deployment) to these
   receipts. A source SHA or version tag alone is insufficient. Failed promotion,
   rollback, mixed versions and old receipts do not establish current absence.
5. Match advisory package names against the inventory's package records. Use the
   recorded versions for version-range evaluation. Keep any matching package as
   **present / potential runtime exposure**, even if its contributions are zero.
   npm/scoped paths and pnpm paths use the **last** `node_modules/` segment; the
   package.json name must agree. Do not infer package identity from a substring.
6. Only a valid complete receipt chain with `absenceEligible: true` permits
   **absent-from-runtime-bundle** for a missing package. An unresolved external
   package makes absence **unknown**. Presence is conservative and is **not
   function-level reachability or exploitability**.

Absence only filters **deployed runtime exposure**. It never dismisses
**development/CI or supply-chain execution risk**: build tools, install hooks,
tests and compromised dependencies can execute without shipping in a Worker.
It must not suppress the underlying dependency advisory in those contexts.

### Deterministic sample findings

These are synthetic package findings, not claims that an advisory/CVE exists:

| Sample | Expected pilot result | Meaning |
| --- | --- | --- |
| `sample-bundled-hono`, package `hono` | `present` | Retain as a potential runtime finding; evaluate its recorded version. |
| `sample-absent-vitest`, package `vitest` | `absent-from-runtime-bundle` | Runtime filter only, after valid deployment binding. Vitest still executes in CI. |

`node ci/worker-bundle-evidence.mjs verify dist-production` prints these two
package decisions after full local verification. Fixtures in
`ci/worker-bundle-evidence.test.mjs` prove scoped/pnpm parsing, conservative
tree-shaking, unknown externals, same-size tampering, stale evidence and
wrong-version rejection. CI's native dry run is installation/build pilot proof;
only a successful production run with a valid `deployed.json` completes the
deployed-artifact pilot. Source changes alone do not provide that proof.
