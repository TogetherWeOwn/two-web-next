# Gradual-promotion proof harness

Manual exercise of the pinned central gradual-promote action against one
isolated synthetic Worker. It proves a full 5% -> 50% -> 100% sweep and,
in a separate run, automatic rollback to the recorded pre-promote version
after a genuine stage-health failure. It never touches the staging or
production Workers, any database, or any custom domain.

## Pinned identities

| Thing | Value |
| --- | --- |
| Action under test | `TogetherWeOwn/.github/actions/gradual-promote@1dcce452d9066c02e4ab3d99931edf75d50388d7` (unchanged; invoked once from the proof workflow) |
| Caller workflow | `.github/workflows/gradual-promote-proof.yml` (`workflow_dispatch` only, `main` only) |
| Synthetic Worker | `two-gradual-promote-proof` on workers.dev |
| Fixture | `ci/gradual-promote-proof/fixture.mjs` (no imports, no data bindings) |
| Config | generated at run time by `ci/gradual-promote-proof/proof-lib.mjs` and saved in the evidence artifact as `config-original.json` / `config-candidate.json` |
| Smoke checker | the real `bin/smoke.mjs` (18 GETs per attempt, 6 attempts per stage gate) |
| Credentials | the staging `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets under the `staging` GitHub Environment. The production secret names are never referenced |

The action hardcodes `--env production` for its deployment list and
version deploys, and runs rollback with `--name` and no environment flag.
The generated config sets the top-level name and `env.production.name` to
the same synthetic Worker, so both halves resolve to the isolated target.
`proof-lib.mjs` refuses any config that adds routes, custom domains,
queues, Hyperdrive, services, assets, tail consumers, triggers, or any
other environment.

## What each run does

1. Target lock: `confirm_worker` must repeat `two-gradual-promote-proof`
   exactly; the resolved domain must match
   `two-gradual-promote-proof.<account-subdomain>.workers.dev` (read from
   the Cloudflare account subdomain API, read-only). Live Worker names
   and `togetherweown.com` hosts refuse before any mutation.
2. The generated proof config replaces `wrangler.jsonc` in the ephemeral
   runner checkout (the action runs `npx wrangler` from the workspace
   root with no `--config` flag). The committed config is never edited.
3. A fresh healthy baseline version (`proof-original-<run>-<attempt>`) is
   uploaded and deployed at 100%; its version id is the captured original.
   On the first ever run, one plain deploy creates the synthetic Worker
   before that baseline.
4. The candidate (`proof-candidate-<run>-<attempt>-<mode>`) is uploaded
   and deployed at 0% alongside the original at 100%. Cloudflare applies
   a version override only to a version in the current deployment, so
   0% (Cloudflare's documented smoke-test pattern) is what makes the
   override probe below reach the candidate at all; no live traffic
   moves. In `rollback` mode its `/up` answers 503; in `success` mode it
   is healthy. The fixture mode is derived from the run mode, so the two
   cannot be mixed up.
5. Pre-promote attribution: the probe requires the
   `x-proof-version-id` header (from the version-metadata binding) to
   equal the candidate id under the version-override header, and the
   real smoke checker requires `/up` `revision.version_id` to equal
   the same candidate id. The smoke checker must agree with the run
   mode (pass for `success`, fail for `rollback`). A healthy rollback candidate stops the run
   before the action, because its forced failure would be fake. Every
   live probe in the workflow retries 6 times, 5s apart, and records
   each attempt, because a deployment change can take a couple of
   seconds to reach every edge.
6. The 0% split collapses back to the captured original alone at 100%
   (asserted by readback), because the action records its rollback
   target from the live deployment and refuses to start from a split.
   This pre-action reset to the run's own baseline is the workflow's
   only redeploy; after the action runs, only its own rollback may move
   traffic.
7. The pinned action promotes 5% -> 50% -> 100%, running the real smoke
   checker (pinned to the candidate by version override) at every stage.
8. Independent readback (always): the final deployment must be the
   candidate at 100% after a successful action, or the captured original
   at 100% after a failed one; the live probe must be served by that same
   version; and the action's `rollback-version-id` / `promoted-version-id`
   outputs must equal the captured original and candidate ids.

There is no post-action restore step in the workflow (only the
pre-action baseline reset in step 6). In a rollback run the action step
is expected to fail and the job stays red: that failure plus the
readback is the evidence that restoration was the action's own automatic
rollback, not manual cleanup.

## Exact commands for the executor

Run the healthy sweep first, then the forced-failure run. Wait for each
run to finish (the workflow serializes itself with a concurrency group).

```sh
gh workflow run gradual-promote-proof.yml --ref main \
  -f mode=success -f confirm_worker=two-gradual-promote-proof
gh run list --workflow gradual-promote-proof.yml --branch main --limit 1
gh run watch <run-id> --exit-status   # success run must exit 0

gh workflow run gradual-promote-proof.yml --ref main \
  -f mode=rollback -f confirm_worker=two-gradual-promote-proof
gh run watch <run-id> --exit-status   # rollback run must exit non-zero (preserved failure)

gh run download <run-id> -n gradual-promote-proof-success-<run-id>-<attempt>
gh run download <run-id> -n gradual-promote-proof-rollback-<run-id>-<attempt>
```

## Evidence schema

Each run uploads `gradual-promote-proof-<mode>-<run>-<attempt>` with:

- `evidence.json`, schema `gradual-promote-proof/v1`: pinned action,
  run mode, Worker, domain, repository, workflow SHA, run id/attempt,
  the original and candidate `{versionId, tag}`, the action outcome,
  the expected final version for the mode, the final deployed version,
  and `sightings` (every deployment's per-version traffic share in
  creation order, so the 5% and 50% stages are visible after the run).
- `pre-deployments.json`, `baseline-deployments.json`,
  `candidate-zero-deployments.json`, `pre-action-deployments.json`,
  `post-deployments.json`, `post-versions.json`: raw
  `wrangler ... --json` readbacks.
- `config-original.json`, `config-candidate.json`: the exact generated
  configs (synthetic Worker, fixture entrypoint, no data bindings).
- `probe-original-live.jsonl`, `probe-candidate-override.jsonl`,
  `probe-final-live.jsonl`: version-attribution probe records, one JSON
  line per attempt (attempt number, status, served version
  id/tag/label/mode, whether an override was requested; a network-error
  attempt records `error` with a null served version instead; the probe
  stops at the first attributed attempt and fails only after the last).
- `smoke-candidate-override.txt`: the pre-promote real-checker output.

Acceptance for the pair of runs: the success run is green with the
candidate at 100% and 5/50/100 sightings; the rollback run is red with
`actionOutcome: "failure"` and the captured original back at 100%
(`finalDeployedVersionId` equals `expectedFinalVersionId` equals the
original version id), with the final live probe served by the original.

## Manual restore (only if readback fails)

If a run ends with the readback asserting the wrong version at 100%,
the synthetic Worker may be left split or on the candidate. That state
is contained (no data, no custom domain), but restore it deliberately
and record it as manual cleanup, never as rollback evidence:

```sh
npx wrangler rollback <original-version-id> --name two-gradual-promote-proof --yes
npx wrangler deployments list --env production --name two-gradual-promote-proof --json \
  | node ci/gradual-promote-proof/proof-lib.mjs --assert-deployed --version <original-version-id>
```

The next dispatched run also re-establishes a fresh baseline at 100%
before invoking the action, so a wedged proof Worker never blocks a
later proof. Deleting the synthetic Worker between exercises is an
operator choice, not part of the proof.

## Preflight gaps to confirm before the first dispatch

The harness is preparation only; it was verified hermetically
(`node --test ci/gradual-promote-proof/proof.test.mjs`: fixture against
the real checker, config and target-lock refusals, workflow pins). The
following live facts cannot be proven from source and must be confirmed
by the executor against the existing machine contract before
dispatching. Nothing here asks for new permissions; if any item fails,
report the gap instead of broadening access.

1. The Worker name `two-gradual-promote-proof` is unused in the
   Cloudflare account, or is already this proof's Worker from an
   earlier run (never some other workload).
2. The staging `CLOUDFLARE_API_TOKEN` can edit Workers scripts and read
   the account's workers.dev subdomain. The workflow fails closed if
   the credentials are absent; a token scoped to other scripts only
   will fail at the first wrangler call, before any traffic moves.
3. The `staging` GitHub Environment admits this workflow (its
   protection rules apply to the dispatch as they do to staging
   deploys). Version overrides themselves are documented Cloudflare
   behaviour, applied only to a version in the current deployment; the
   harness deploys the candidate at 0% to satisfy that rule, and the
   retried pre-promote attribution probe proves the workers.dev URL
   honors the header on the day: if the override ever falls back to
   live routing, the probe fails before the action runs rather than
   letting a sampled canary masquerade as a pinned one.
