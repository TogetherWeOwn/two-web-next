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

## Kit bundling and inert packaging (not installed)

[The bundler](../ci/candidate-staging-bundle.mjs) closes the actual staging Kit
entrypoint's generated imports into a single `worker/worker.mjs` module. It uses
the existing locked esbuild with fixed options, no plugins, no discovered
candidate tsconfig or build config, no source maps and no persisted build
metafile. Only `node:` and `cloudflare:` imports may remain external; warnings,
unsupported imports/loaders, empty output, additional outputs and a Worker over
16 MiB refuse with a fixed diagnostic. Neither compiling a source file nor
hashing its output attests its provenance or makes that source trusted.

**Run the bundler only inside the secret-free candidate build sandbox.** Module
resolution reads candidate files and dependencies. The helper does not supply a
sandbox, restrict the filesystem or enforce its own wall-clock timeout. The
installed wrapper must pin source/toolchain, strip credential and build-override
environments, remove host/control-file/socket access and bound the whole build.
It must terminate the entire candidate sandbox before the next phase. Never
import this bundler into credential-bearing uploader/controller tooling.

[The separate inert collector](../ci/candidate-staging-package.mjs) consumes the
compiled Worker buffer and a stopped sandbox's read-only Kit asset tree. It uses
only Node builtins and the admission module, not esbuild or candidate package
resolution. Linux descriptor-relative traversal pins directory ancestors;
no-follow/nonblocking opens, regular-file/single-link checks, stable metadata and
exact-length reads refuse links, special files, replacements and truncation.
It copies all bytes, rejects path/case aliases and hidden files, and bounds depth
(16), visited nodes (8192), admitted files (4096) and total module/asset bytes
(16 MiB). Holding the complete tree read-only and stopping all candidate
processes remain **caller prerequisites**, not facts proved by these checks.

Only the exact regular root `_worker.js`, `_headers` and `.assetsignore` files
are discarded, never interpreted as routing/header/ignore policy or published as
assets. The generated `_worker.js` must exist; nested controls, case aliases,
`_redirects` and `_routes.json` refuse. Public files retain their paths beneath
`assets/`; no server source, candidate manifest or build tooling is discovered
there. Worker-first serving configuration still comes from the trusted upload
constructor, never these control files.

The trusted wrapper may assemble a `two.candidate-build.v1` producer receipt
from these files only after immutable artifact ID/digest metadata is known.
The finalizer rehashes canonical sorted records, joins descriptor/Q, CI/build
run and attempt, numeric repository/head and unexpired artifact, reuses bundle
admission, and freezes the receipt. The 1-MiB producer-manifest ceiling matches
the artifact reader; the final public qualification receipt has its separate
smaller budget. This is **receipt assembly, not attestation**. A matching receipt
inside a candidate archive has no authority. Independent installed workflow,
source, sandbox exit, selected-attempt freshness, publishing and receipt-channel
provenance must still be established by the controller. No workflow currently
invokes this code or grants it artifact-writing authority.

The repository's actual Kit build has been compiled and collected locally,
without a credential environment or deployment: 93 files, 3,709,462 total bytes,
including a 3,276,936-byte bundled Worker and three discarded control files.
That observed fit is not live runtime, artifact-service ZIP compatibility,
provider conformance, sandbox-containment or authenticated-suite acceptance.

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

## Explicit-binding web upload request construction

[The request constructor](../ci/candidate-staging-upload.mjs) builds an inert
multipart **version-create** request for the existing staging web Worker. It
makes no network request, runs no candidate code or build tool, reads no files,
and activates no version. It does not yet support jobs, tail or separate Kit
components. Only local fixtures have exercised its output.

Its account/resource profile must come from the installed trusted closure and
match an independently pinned SHA-256, never a digest supplied alongside a
candidate's chosen profile. The target Worker name and API origin are fixed;
production and preview Worker names refuse even with a matching digest. Only
`DB`/`BOT_DB` Hyperdrive IDs and numeric public Discord application/guild IDs are
accepted from that profile. The profile hash proves byte identity, **not** that
an account token is staging-scoped or a Hyperdrive resource is synthetic-only.
Security must independently admit those capabilities before use.

The constructor rehashes and copies the admitted bundle, verifies its Q, root,
paths, counts and sizes, and constructs module parts only from regular Worker
bytes. It uses the reviewed compatibility date/flags and explicit bindings for
the canonical staging origin, public run verifier and version metadata. The
verifier must match the full descriptor/Q, the issuer's fixed 25-minute lifetime
and the original unexpired cutoff. No secret/inherit/service binding or arbitrary
metadata override is accepted. `keep_bindings: []`, `keep_assets: false` and empty
tail-consumer lists are explicit; no baseline binding/config is copied into the
request. This is request construction, not proof of provider omission semantics.

Static assets require a completion ticket from the separately trusted asset
transport, joined to Q and the canonical SHA-256 record roots of the whole bundle
and its asset subset. The constructor checks its shape and joins, **not** its
signature, remote scope, freshness or issuance. It does not upload assets or
mint this ticket. Module-only uploads require a null ticket and cannot implicitly
retain B's assets. Asset routing is Worker-first, with no candidate-provided
headers, redirect rules or asset configuration. The form contains an asset
upload capability: never log, publish or persist it. The separate allowlisted
proof contains only immutable identities, hashes, original times and literal
`promotable:false`, not the ticket, verifier JSON or module bytes.

The form is mutable transport state, not an authority token. The installed
sender must submit the exact constructed metadata/module bytes and bind provider
readback to the request proof before activation. It must independently establish
live head/CI/build/producer provenance, asset-ticket provenance, global exclusion,
dirty occupancy, preview-route disablement, baseline restoration and next-upload
compatibility. The isolated sender below now joins assets, creation, a narrow
version binding/runtime readback and immutable module-byte/config readback.
Persistent Worker settings, stored asset-content verification, version/serving
history and installed activation/recovery remain unimplemented. Ordinary
Wrangler upload remains unsuitable because it retains secrets by default; this
constructor does not make a live candidate safe merely by omitting those secrets.

## Trusted static-assets transport (not installed or activated)

[The asset adapter](../ci/candidate-staging-assets.mjs) constructs and sends the
fixed staging web Worker's asset-session request, then only the requested
allowlisted asset hashes. Nothing invokes it from a workflow yet; all transport
verification uses mocked responses. It never selects or deploys a version, runs
candidate code, reads candidate configuration or discovers dependencies in the
candidate bundle. It and its dependency tree must be installed from trusted T.

Admission reuses the version constructor's profile pin, full descriptor/Q,
verifier/deadline and independent bundle rehash/copy checks. Manifest paths and
sizes come only from those copied asset bytes. Hashes follow the installed
Wrangler protocol: BLAKE3 of base64 bytes plus extension, truncated to 32 hex
characters. The existing lockfile's `blake3-wasm` and `mime` dependencies are
reused without installation or a dependency change. MIME lookup uses the locked
`mime` 1.6 lookup table, not Wrangler's bundled newer table; future installed
producer/manifest admission must establish parity for actual file types. Unknown
extensions use the protocol's `application/null` sentinel; `text/*` types include
Wrangler's UTF-8 charset metadata in both protocols. Control paths
`_worker.js`, `_headers` and `_redirects` refuse rather than acquire routing or
source-publishing semantics. Equal byte/type hashes deduplicate, never ambiguous
collisions. A module-only bundle creates no session and returns a null ticket.

The provider API bearer is sent only to the fixed session endpoint. Bucket
requests use only the session capability, at the fixed same-account asset upload
endpoint; no remote URL or redirect is followed. Provider-selected bulk mode
uses base64 multipart files; single mode uses raw-byte Blobs. Every requested
hash must exist in the admitted manifest, appear only once, and belong to a
nonempty bounded bucket. Uploads are serial, with no retry or renewed QA expiry,
a 120-second overall signal, 10-second request signals, a 176128-byte response
bound derived from the maximum hash/bucket count and capability/envelope overhead,
strict JSON success envelopes, and monotonic wall-clock/original QA-deadline
checks before and after requests. Stream errors, failed/cancelled requests,
malformed or missing completion capabilities and any failed bucket refuse a
ticket, even if an earlier bucket succeeded. Capability expiry/shape is checked;
decoded claims are not signature verification. Authority is the adapter's
fixed-origin provider response, not a candidate-supplied JWT. Conflicting
completion capabilities refuse rather than choosing one silently.

Only a fully successful transport returns an in-memory ticket joined to Q and
the entire bundle/asset SHA-256 roots, directly consumable by the inert version
constructor. The ticket is a capability, not a public receipt: never log, persist
or publish it. Provider response/error text is replaced by a fixed refusal.
Client protocol fixtures and hash joins are not provider readback, capability
scope validation, synthetic-data admission, restoration evidence or native
Security clearance. A failed upload can leave inert content-addressed assets;
the installed controller must already hold exclusion and durable dirty occupancy
before calling this mutating adapter. The isolated sender below now connects
assets to version creation and immutable module/config readback. Trusted
build/producer integration, persistent Worker/asset-content admission, global
exclusion and complete verified B and
next-ordinary-upload restoration remain unimplemented. No live use is permitted
merely because these isolated fixtures pass.

## Trusted version transport and immutable readback (not installed or activated)

[The version adapter](../ci/candidate-staging-version.mjs) owns its installed
profile and independent pin at construction; invocation accepts only identity,
admitted bundle and public verifier. It validates bounds and snapshots the full
identity, build metadata and module/asset bytes before its first await. Caller
mutation cannot change the account, profile, original expiry or uploaded code
between asset and version operations. It creates its own asset transport and
consumes its completion ticket internally: callers cannot inject tickets,
prepared forms, URLs, profile overrides or clocks. Only mocked transport has
exercised this helper; no workflow calls it.

The adapter constructs the explicit-binding form itself, sends exactly one
version-create POST, then GETs the fixed script-version endpoint at the returned
canonical UUID and the immutable Worker-version endpoint with `include=modules`.
It never calls deployments, settings, routes or preview APIs, selects traffic,
invokes candidate code/tooling or retries a partial mutation. The provider bearer
goes only to fixed same-account API endpoints; asset buckets still receive only
their session capability. Metadata responses require bounded 64-KiB JSON success
envelopes; the module response has a separate 24-MiB ceiling for base64 plus
bounded paths/configuration from the admitted 16-MiB bundle. Both enforce strict
UTF-8, no redirect or foreign final URL, 10-second request signals, a shared
180-second overall bound and monotonic original credential-cutoff checks across
all phases. Any failure yields only a fixed redacted error, never a partial receipt.

Independent GET admission joins UUID, creation-response etag, candidate tag,
exact compatibility date/flags and the exact requested binding set. Binding
order may differ; unknown types, retained secrets, duplicates, missing values,
extra fields/resources and unrequested runtime fields refuse. The deliberately
narrow response contract currently accepts only `script`, `script_runtime` and
`bindings` resources, with just compatibility date/flags under runtime; a future
or actual provider response outside this projection refuses rather than silently
ignoring it. The shipped Wrangler version client establishes the endpoint and
resource layout, not live provider conformance to this stricter contract.

The second GET uses the documented
[immutable Worker-version API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/),
with the same full UUID and fixed staging account/Worker name, never `latest`, a
UUID prefix, a candidate URL or the mutable script `content/v2`. It requires the
exact entrypoint and complete module set. Each module has an exact name/MIME and
canonical standard-base64 encoding; decoded bytes must equal the independently
admitted pre-await snapshot, not just an etag. Missing/duplicate/extra modules,
case/path aliases, altered chunks and noncanonical encodings refuse. Module
order is immaterial. Runtime, bindings and tag are checked again independently.
Only absent or explicitly inert version defaults are accepted: no containers,
limits, placement, migrations, extra exports, caching or unrequested fields.
Any routable version URL refuses. Asset config must be exactly Worker-first;
headers/redirect/HTML rules refuse. A returned asset ticket must match the one
submitted, but that comparison is **not** remote asset-content proof. Live
cross-API conformance and actual disabled-preview state remain unproven.

The allowlisted frozen `two.candidate-version-upload.v2` receipt joins request
proof to UUID, etag, the script-version projection hash and a second canonical
module/config hash, with literal `promotable:false` and
`readbackScope:version-modules-bindings-runtime-and-asset-config`. It contains no
ticket, token, verifier JSON, source bytes, author metadata, serving URL or
activation authority. Etag remains a join between observations, not a substitute
for module comparison. These GETs are not persistent Worker settings, stored
asset-content, tail/streaming consumer, preview-route disablement, serving
history, capability scope, synthetic-data or baseline-restoration proof. All
those checks, installed controller/journal/exclusion wiring, component maps,
trusted build provenance and native Security admission remain prerequisites to
any live mutation/selection. This helper's mock green is not live qualification.

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
