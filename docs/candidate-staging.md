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

## Read-only GitHub evidence reader

[The reader](../ci/candidate-staging-github.mjs) constructs only repository-local
GET requests to GitHub's fixed API origin. It has no arbitrary-URL method, does
not follow API-provided links, refuses redirects and authentication failures
without retry, and bounds each request to ten seconds and 2 MiB of decoded JSON.
Errors discard remote messages, URLs and source text. Every response stream is
closed, including on a size or status refusal.

`verifyCi` obtains full unfiltered run listings before and after explicit
run/attempt/job reads, validates both observations with the installed contract,
and rechecks the live PR as the final operation. A result is a bounded
observation, not a lock on future GitHub state. `readArtifact` joins the complete
build-run listing and immutable artifact-ID detail; it does not attest the build
attempt, producer, download bytes or execution by itself.

`verifyInstalledSources` requires a manifest digest independently anchored by the
reviewed installation, verifies its controller revision, and reads each named
file at that immutable ref. Nonrecursive Git trees reject links, submodules and
ambiguous/missing entries before content reads. Content must agree on byte size,
canonical base64, Git blob SHA-1 and SHA-256. Bounds: 128 named files, 512 KiB per
file, 4 MiB total source, 64 trees and eight path components. Returned buffers are
inert. This verifies the **named** closure only; it cannot establish that a
caller-supplied manifest is complete or trusted. No installed manifest, launcher
or credential-bearing execution is supplied by this reader.

## In-memory archive decoder

[The ZIP decoder](../ci/candidate-staging-archive.mjs) first checks the independent
selected archive SHA-256 and a 16 MiB compressed-input cap. It returns regular
file buffers, never filesystem entries or executed modules. Central and local
records, names, modes, sizes, CRCs and optional signed streaming descriptors must
agree. Local records must cover the exact data region with no prefixes, gaps,
overlaps or suffixes. Deflate output has a hard allocation limit and cannot hide
trailing compressed data. The shared bundle-path allowlist, case-collision guard,
4096-entry cap and aggregate 16 MiB expanded limit apply before decompression.

The producer must emit this narrow ZIP profile: store or deflate, regular files,
ASCII paths, optional UTF-8 flag and signed data descriptors, no comments or
multipart/ZIP64/encryption/alternate-name features. Only timestamp and UID/GID
extra-field types are accepted, as inert metadata. Unsupported archive features
refuse rather than being interpreted by another extractor. This is not yet a
trusted build producer, artifact downloader or provenance attestation.

## Immutable artifact download and bundle admission

[The artifact reader](../ci/candidate-staging-artifact.mjs) connects the read-only
GitHub metadata reader, bounded archive decoder and bundle predicate. The caller
supplies an immutable build/artifact selection and a producer receipt obtained
**separately from trusted tooling**, not from the downloaded archive. Inputs are
snapshotted before the first request. The reader checks the same-repo live PR and
complete artifact listing/detail before download and again afterward; a moved
head or deleted/expired/replaced artifact refuses the result.

Only the fixed repository artifact-ID ZIP endpoint receives the GitHub bearer.
Its single manual 302 may target only `productionresultssa<number>.blob.core.windows.net`
or the legacy `pipelines.actions.githubusercontent.com`, over HTTPS with no URL
credentials, non-default port or fragment. Other storage origins require a
reviewed adapter update, not a wildcard or alternate credential. The signed URL
is used once with a newly constructed request: no Authorization, cookies or
referrer, no cache and no second redirect. No signed URL is returned or logged.
Each request has a ten-second deadline; all metadata/download/readback work shares
a sixty-second deadline, which caller cancellation can shorten but not replace.
The binary stream is limited to 16 MiB after decoding, rejects truncation and
unsupported content types/statuses, and is closed on failure. SHA-256 precedes ZIP
decoding and the independent per-file/root join. Only inert buffers and bounded
selection/digest observations are returned; errors discard API, URL and code text.

This is not a trusted build producer or a provenance attestation. Its metadata
reads cannot independently establish build-attempt freshness, workflow source,
CI completion, sandbox containment or the producer receipt's authority. Installed
controller admission must establish those separately. It supplies no filesystem
extraction, module execution, version upload, global lock or live qualification.
Only mocked HTTP fixtures have exercised this path.

## Durable occupancy journal and recovery boundary

[The journal](../ci/candidate-staging-occupancy.mjs) implements a narrow GitHub
Deployment transport, exercised only with local HTTP fixtures. It creates a
non-production, non-transient `candidate-staging-occupancy` record at trusted T
before the caller may mutate staging. The immutable payload joins Q, C, T,
controller run/attempt and a digest-pinned baseline restoration artifact. That
artifact's declared expiry must retain at least fourteen days at creation.
The caller must independently verify the artifact exists, its retention and
contents, and that exact B is restorable **before** calling `begin`.

No status means dirty. Failure, cancellation, timeout, expiry and lock release
never imply clean. All actors must call `assertClear` while holding the same
external staging exclusion. A complete journal scan checks all records in that
environment, not just the current run or successful records. Missing/malformed
records, unexpected author/App identities, incomplete pages, duplicate IDs and
unsupported status ordering refuse. Both deployment and status histories require
an observed terminal short/empty page, bounded to 500 rows each. A sixth empty
sentinel is required at exactly 500. At capacity, creation refuses before POST,
so it cannot strand an unreadable record 501. Exceeding the read bound refuses;
records are not silently pruned or deleted. All calls have ten-second request
deadlines, 2 MiB JSON limits, and a shared sixty-second deadline per journal
operation. A caller cancellation signal can shorten but never remove that bound.
There is no alternate-credential retry, including after a lost write response.

`begin` reads back its immutable record and the complete dirty set before
returning. A competing record or replayed Q refuses. Recovery requires sole
unresolved ownership, reacquired external exclusion, an idempotent trusted
baseline restore, and independent provider-state, smoke and next-upload evidence.
It rechecks exclusion between phases. A previously cleaned or superseded session
cannot restore an old B over a later run. Failed restore/verification leaves the
record dirty; status-write uncertainty requires readback, not a blind retry.
`markRestored` binds a fresh allowlisted proof to Q, deployment ID and the original
baseline digest, writes only a non-promoting status (`auto_inactive: false`), and
verifies both that exact status and absence of any other dirty occupancy.

This is **not** an installed lock, a provider restore adapter or proof of the
baseline contents. The restore, verify and exclusion adapters must be installed
trusted code, never candidate callbacks. A pinned GitHub creator/App is a minimum
transport check, not independent controller provenance: other writers sharing
that principal must be contained before use. The source/run provenance, recovery
artifact producer/download/admission, provider observations, next-upload comparison,
complete published recovery receipt and normal-actor workflow wiring remain
required. A digest-shaped proof supplied by a candidate is never sufficient.
No live journal API or provider operation was used to qualify this helper.

## Required caller boundaries — still not installed

The controller must establish the provenance of its installed source, complete
policy/test dependency closure and producer receipts independently. Passing a
candidate's manifest as a trusted producer receipt defeats that boundary;
matching hashes alone do not attest source provenance. CI dispatch/workflow
source provenance and baseline execution ledgers also need independent checks.

The bundle predicate is **not an archive parser**; the separate decoder above
provides that bounded byte boundary. The artifact reader connects download,
decoding and bundle admission, but the installed controller must still supply
independently attested producer evidence and verified build-attempt freshness.
No credential-bearing tool may discover candidate package,
configuration, plugin or script files. No raw credential belongs in the bundle,
receipt, workflow output, argument list or cache.

Still required before an installed qualification can pass: installed source and
baseline policy provenance, secret-free build sandboxing, authenticated artifact
download/producer integration, trusted inert version upload,
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
