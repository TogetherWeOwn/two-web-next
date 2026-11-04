# Candidate staging admission foundations

The premerge qualification installer is **incomplete and not activated**. The
[admission helpers](../ci/candidate-staging-admission.mjs) are offline predicates,
not a deploy command, an installed controller, live qualification evidence, or
permission to expose staging resources to candidate code. The existing staging
and production deployment selectors remain separate and unchanged.

## Implemented predicates

- `candidateIdentity` accepts only a PR number, exact lowercase head SHA, and
  selected CI run/attempt. The trusted main-only launcher supplies repository,
  tooling, checkout and workflow identities. It produces the same fixed-order
  descriptor and SHA-256 Q used by the run-scoped auth verifier. It freezes the
  identity instead of following a moved head.
- `admitCandidatePullRequest` checks the independently retrieved repository and
  open PR: numeric repository identity, matching non-fork head/base repositories,
  base main and exact selected head. Call it again before mutations and final
  evidence; a prior successful call is not a lease on GitHub state.
- `completeCandidatePages` requires all numbered pages with consistent totals,
  at most 500 rows across five 100-row pages, and unique numeric IDs. The reader
  must not filter to successful runs before calling it. Empty evidence is not
  evidence of a successful job or an available baseline.
- `admitCandidateCi` joins a single selected run, before/after run observations,
  every expected job and every expected executed step on the exact head/attempt.
  Pending, failed, cancelled, timed-out, skipped, duplicate, missing and replaced
  evidence refuses. A trusted full-execution contract is required; a candidate
  workflow, candidate-authored job list or green aggregate cannot supply it.
- `admitCandidateBundle` joins immutable artifact metadata and an independently
  obtained trusted producer receipt to Q, CI and build attempts. It hashes flat
  decoded file bytes, verifies canonical per-file/root digests, caps them at
  16 MiB/4096 files, and rejects unsafe paths, collisions and non-file entries.
  Only the Worker entrypoint, compiled chunks and public assets are admitted.
  Bytes are data: this function never imports or executes candidate modules.

Diagnostics use fixed refusal codes, not untrusted API messages, filenames or
bundle contents. No helper reads credentials, calls a remote API or opens a DB.

## Required caller boundaries — not implemented by these predicates

The controller must establish the provenance of its installed source, complete
policy/test dependency closure and producer receipts independently. Passing a
candidate's manifest as a trusted producer receipt defeats that boundary;
matching hashes alone do not attest source provenance. CI dispatch/workflow
source provenance and baseline execution ledgers also need independent checks.

The bundle predicate is **not an archive parser**. A trusted decoder must verify
archive bytes against the selected immutable digest and reject malformed or
ambiguous archives, links, path aliases and expansion bombs before producing its
flat file list. No credential-bearing tool may discover candidate package,
configuration, plugin or script files. No raw credential belongs in the bundle,
receipt, workflow output, argument list or cache.

Still required before an installed qualification can pass: secret-free build
sandboxing, bounded complete API readers, trusted inert version upload,
independently admitted staging-only deployment and synthetic-data capabilities,
global exclusion, durable dirty occupancy, complete provider serving-history
proof, the unchanged full authenticated live suite within one original deadline,
and immediate idempotent baseline restoration including safe next-upload
compatibility. A pass must be withheld on any missing proof, drift, interrupted
run, failed restoration or incomplete sanitizer. Candidate evidence must remain
non-promotable and cannot replace normal main staging/production receipts.

## Local verification

```sh
npm run test:candidate-staging
```

This fixture-only suite is included in the local complete check and in the
required CI `check` job. A wiring test asserts those invocations and the `ci-ok`
dependency. Fixtures are refusal/provenance proofs, not live containment or
application acceptance. Repository-wide disposable-DB verification follows
[Contributing](../CONTRIBUTING.md#verify-a-change-before-opening-a-pr).
