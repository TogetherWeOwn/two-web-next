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
version binding/runtime readback, immutable module-byte/config readback and
point-in-time persistent settings/subdomain admission before and after upload.
Stored asset-content verification, version/serving history, continuous exclusion
and installed activation/recovery remain unimplemented. Ordinary
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
assets to version creation and immutable module/config readback, fenced by the
point-in-time settings observations below. Trusted build/producer integration,
stored asset-content admission, global exclusion and complete verified B and
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
It never writes deployments, settings or routes, selects traffic, invokes
candidate code/tooling or retries a partial mutation. Its settings reader below
GETs persistent settings and subdomain flags before any asset/version request,
then repeats those GETs after module readback; it compares their canonical digests
and withholds a receipt on either refusal or mismatch. The provider bearer
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

The allowlisted frozen `two.candidate-version-upload.v3` receipt joins request
proof to UUID, etag, the script-version projection hash, a second canonical
module/config hash and a persistent settings/subdomain digest with before/after
observation times. Its literal `promotable:false` and
`readbackScope:version-modules-bindings-runtime-assets-and-persistent-settings`
convey no activation authority. It contains no ticket, token, verifier JSON,
source bytes, author metadata or serving URL. Etag remains a join between
observations, not a substitute for module comparison. This helper's mock green
is not live qualification; its installed callers, component maps, stored assets,
serving history, capability scope, synthetic-data admission, continuous exclusion
and complete restoration remain prerequisites to any live mutation/selection.

## Persistent settings observations (not installed or activated)

[The read-only observer](../ci/candidate-staging-settings.mjs) uses the same
installed profile/pin, full descriptor/Q, original verifier cutoff and inert
bundle admission as the uploader. It constructs only same-account, fixed-Worker
`script-settings` and `subdomain` GETs. No candidate URL, method, profile, clock or
prepared request is accepted. The bearer never reaches candidate code or a
response-selected endpoint. Each operation has a 30-second overall signal,
10-second request signals, 64-KiB strict UTF-8 JSON success-envelope limits and
monotonic clock/cutoff checks before and after each read. A version upload's
before/after observations also share that uploader's original 180-second signal;
neither an observation nor a post-upload check restarts the credential lifetime.

The pinned shipped provider client's
[script settings](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/scripts/settings.ts)
and [subdomain](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/scripts/subdomain.ts)
APIs establish endpoint/field layout, not live conformance or containment. The
observer's safety envelope is intentionally stricter than those optional fields:
require explicit `logpush:false`, empty tags and tail consumers, explicit disabled
observability/logs with zero sampling, disabled invocation/persistence and empty
log destinations. Require both `enabled:false` and `previews_enabled:false` for
workers.dev. Missing fields, null/default-shaped responses, unknown settings
(including any streaming-tail field), enabled sinks or previews and malformed
responses refuse. No omitted value is interpreted as a safe provider default.
Actual API conformance to this exact envelope has not been established; refusal
must be resolved with evidence, not by silently supplying missing fields.

The frozen observation receipt includes only Q, bundle/profile hashes, the
canonical settings/subdomain digest, observation time and literal
`promotable:false`. It is not an activation token or independent baseline proof.
The uploader checks an initial observation before any mutation and repeats it
after immutable content readback. A refused final observation withholds the
receipt but does not undo an already-created inert version or imply a clean
journal. The independently trusted controller must retain dirty occupancy and
restore B on uncertainty.

Two matching point-in-time observations are **not continuous state proof**:
concurrent change-and-reversion can escape them without enforced global
exclusion. These two endpoints do not enumerate account/zone routes, custom
domains, active tail sessions, all component settings or serving history; no
complete mutable-state admission or restoration is claimed. No workflow invokes
the observer/uploader, no setting was changed, and no live request was made to
qualify these mocked fixtures. Installed authority, exclusion, complete B and
next-ordinary-upload restoration and native Security admission remain required.

## Persistent settings lifecycle (mock-qualified, not installed)

[The lifecycle helper](../ci/candidate-staging-settings-lifecycle.mjs) adds a
narrow settings snapshot/seal/restore transport, using the same installed
profile and complete descriptor/Q admission as the uploader. It has no workflow
caller and grants no version-selection, activation, clean-journal or release
authority. All tests use local mocked HTTP; no live settings were changed.

The canonical, deeply frozen snapshot binds Q, the installed profile digest,
capture time and explicit script-settings/subdomain values. Its digest must be
pinned through the independently authenticated recovery-artifact channel. This is
only a **settings component**, not the complete B/provider baseline digest or
proof that the artifact was retained. The tail list accepts only empty or the
single exact `{service:"two-web-next-alerts"}` consumer already declared by the
[staging Kit configuration](../web/wrangler.staging.jsonc). The
[pinned provider tail schema](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/scripts/tail.ts#L86-L121)
defines its service and optional environment/namespace selectors; this helper
rejects those selectors, production/foreign services, duplicates, aliases and
unknown fields instead of replaying them. Sealing always removes every tail;
restoring the independently pinned snapshot restores only its original list,
after independent B-serving checks before and after every provider call.
Nonempty tags and log destinations, omitted/default/null values and unsupported
observability components (including streaming tails) still refuse. The supported
subset preserves explicit boolean flags and sampling rates in [0,1], including
B's enabled logging and workers.dev flags, without copying arbitrary provider
JSON into a PATCH. This restores a component; it does not attest the tail
Worker's own code/configuration, active sessions, capabilities or containment.

`seal` first re-reads and compares B's current settings against the pinned
snapshot, then PATCHes explicit disabled script sinks and POSTs both subdomain
flags disabled. It validates write responses, independently GETs the settings
and performs a final combined readback. `restore` replays only the admitted,
pinned B component and performs the same write/readback comparisons. Restore is
idempotent and does not need a still-live QA credential; recovery after the
fixed QA expiry cannot renew that credential.

Every provider request is preceded and followed by mandatory **trusted installed**
exclusion and, for seal/restore, dirty-baseline ownership adapters. The latter
must verify the outer recovery manifest/journal's live ownership and its binding
to this exact settings snapshot digest, not just accept a digest-shaped string.
Restore additionally requires independent B-serving admission at each guard,
**before re-enabling any log or preview sink**. These adapters receive the phase,
Q, profile/snapshot digests and the operation's cancellation signal. Candidate
callbacks, caller booleans, an unverified B version ID or a candidate-generated
snapshot are not authorization. These trusted adapters remain to be installed.

Requests use only fixed same-account staging endpoints: GET/PATCH
`script-settings` and GET/POST `subdomain`. They share a 60-second operation
signal and 10-second request bounds; parent cancellation reaches every request
and adapter. Responses reuse the observer's 64-KiB strict UTF-8 JSON/status/origin
checks. Clock rollback, future capture times, lost ownership, B-serving drift,
partial writes, failed readback and uncertain responses withhold the receipt.
There is no write retry, automatic rollback or automatic clean status. A failure
can leave staging partially changed: retain durable dirty occupancy and use
trusted full recovery, never infer clean from a thrown exception.

Receipts contain only phase, Q, profile/snapshot/state digests, time and literal
`promotable:false`. They establish only point-in-time component comparisons under
the supplied adapters. Complete provider/capability/component and stored-asset
admission, actual global exclusion, recovery artifact provenance, serving/history
fencing and verified B/latest-upload restoration remain required. In particular,
restoring these mutable settings or selecting B does not remove a latest-uploaded
candidate or repair the ordinary uploader's binding inheritance.

## Serving-version observation (mock-qualified, not installed)

[The serving reader](../ci/candidate-staging-serving.mjs) supplies a read-only
component for deployment fencing and the settings lifecycle's independent
B-serving assertion. It has no workflow caller, traffic-selection API, journal
cleanup or activation authority. It does not certify complete recovery.

The endpoint layout and latest-first active-deployment contract come from the
[pinned provider client](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/scripts/deployments.ts#L47-L71).
Each observation GETs the staging Worker's deployment list, GETs the exact full
UUID of the first deployment, then GETs the list again. The selected deployment
must have one version at exactly 100%; split/zero-weight extra versions refuse.
The exact GET must match the list's canonical deployment, and both lists must
match. Retained history is bounded to 100 unique deployments in nonincreasing
creation-time order. Historical two-version percentage splits are admitted only
with distinct version UUIDs and a total of exactly 100. Aliases, unknown fields,
malformed/future times, changed responses and unsupported shapes refuse.

A frozen non-promotable snapshot binds Q, the pinned staging profile, deployment
and version UUIDs, a retained-history digest and observation time. Its digest
must be independently pinned in the authenticated outer recovery manifest;
the reader does not supply that provenance. `assertUnchanged` checks the exact
active deployment ID, version ID and retained-history digest. Replacing a version
and selecting it again under a new deployment ID is still drift, even when the
version bytes are identical. `assertRestored` instead checks the pinned B version
against the **controller-pinned restore deployment UUID**, not just any new
same-version deployment. That restore UUID must come from trusted, independently
verified controller mutation evidence, never candidate output. Author and
annotation text is not provenance and does not appear in snapshots.

Every request has trusted installed exclusion admission before and after it;
non-capture assertions also require dirty-manifest ownership bound to the exact
snapshot digest. These adapters remain mandatory and are not installed merely
by importing the helper. A 60-second observation deadline and 10-second request
bounds combine both the reader's parent signal and the enclosing operation's
signal. A settings restore adapter must pass its supplied guard signal through
to `assertRestored`; a fixture integrates these components and refuses restoration
before any sink-enabling write while the candidate version is selected. Recovery
can run after QA expiry without renewing the candidate credential.

This is point-in-time control-plane evidence, not a live routed-request smoke,
complete historical audit, code/config/asset-content readback or proof of
continuous exclusion. The provider endpoint supplies a retained list, not a
paginated all-time ledger. A writer capable of deleting/recreating evidence can
invalidate observational fencing; source-complete actor/drain/capability
containment is still required. Complete B/provider/latest-upload restoration,
safe ordinary upload inheritance, actual installed adapters and independent live
containment/restoration verification remain incomplete. No provider requests or
traffic changes were made by the mock tests.

## Baseline traffic restoration (mock-qualified, not installed)

[The traffic restorer](../ci/candidate-staging-restore-traffic.mjs) implements
only the B traffic-selection step. It is not called by any workflow. Construction
requires the independently pinned staging profile and installed trusted adapters
for exclusion, current dirty-manifest ownership, actual B admission and sealed
persistent sinks. The serving-snapshot integrity helper is shared with the
read-only observer; a caller-supplied digest is not authenticated B provenance.
Those adapters must independently bind the snapshot/version to the original
recovery manifest and remain valid before and after **every** provider call,
including capture and idempotent recovery. Candidate output is never an adapter.

The [pinned provider create contract](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/scripts/deployments.ts#L32-L44)
accepts `strategy:percentage` and a `versions` array. After a list/exact/list
observation, the restorer POSTs only the admitted B UUID at 100% to the fixed
staging script's deployments endpoint. There is no caller-selected endpoint,
percentage, force option or automatic retry. A provider refusal, including a
secret-removal conflict, leaves recovery uncertain; it never triggers a blind
`force=true`. A successful response must identify a new, freshly created
single-version B deployment. Provider timestamps retain their milliseconds;
the upper time check compares whole-second buckets with the seconds-valued
observation clock, while the mutation's lower bound still rejects timestamps
before its start second. The next second is future, not a grace interval. A
separate exact GET must match its canonical identity/time/source/traffic, followed
by the serving reader's independent
list/exact/list admission of that exact deployment ID and B version.

If B already serves, an idempotent retry writes nothing, but still requires the
same authenticated dirty baseline and a second list/exact/list observation at
the exact deployment. A same-version replacement is drift, not success. Every
operation has a 60-second bound and ten-second provider request bounds, combining
parent and enclosing-operation cancellation; recovery does not renew QA expiry.
Failures redact provider/adapter text and emit no receipt or clean status.

Its frozen non-promotable receipt explicitly says `serving-traffic-only`. It
binds Q, profile, baseline-serving digest, verified deployment/version UUIDs and
new serving-observation digest. This is **not complete recovery**, routed smoke,
latest-upload binding repair, settings restoration or a journal-cleaning proof.
No secret is read or inherited by this step. It cannot construct B-prime: restoring
B's traffic still leaves any latest-uploaded candidate bindings in place. The
version-pinned B-prime upload, complete code/config/assets/components verification,
normal-uploader inheritance verification, actual installed adapters and independent
live containment/recovery admission remain required. The mock tests make no live
provider request or traffic change. Production workflows/configuration stay unchanged.

## Original-B producer observation (mock-qualified, not installed)

`readBaselineArtifact` in [the fixed-origin GitHub reader](../ci/candidate-staging-github.mjs)
reads a **separate** retained baseline archive, not candidate-provided producer
metadata. It first verifies the installation-pinned source manifest, including
`.github/workflows/deploy.yml`, at the controller's exact revision. It joins the
same-repository main-branch producer run, its explicit first attempt, the complete
installed job/step contract, the artifact listing and an independent exact-ID
artifact read. The current run is read again after artifact retrieval, so a new
attempt during observation refuses. Failed, skipped, cancelled or incomplete
runs/jobs/steps and missing, foreign, expired or mismatched archives refuse.
All requests are read-only, repository-local and credentialed only at the fixed
GitHub API origin. Returned source is never evaluated.

The installed contract, source-manifest digest and version selection must come
from trusted controller state, not the candidate ZIP. The producer source must
match the controller revision; older source revisions refuse rather than fall
back to an unverified deployment. Artifact metadata does not identify its
`run_attempt`, so this adapter admits **only attempt 1** and refuses reruns. A name
containing an attempt number is not independent attempt provenance. Supporting
reruns requires another authenticated channel, not removing that refusal.

The frozen observation is explicitly `producer-metadata-only` and
`promotable:false`. It does **not** download or admit archive bytes, prove the
baseline UUID actually serves, attest the source closure's completeness, establish
provider/settings/component/stored-asset completeness or satisfy recovery
retention. Those independent joins and continuous exclusion remain mandatory
before candidate mutation; no workflow calls this adapter yet.

**Concrete integration refusal:** existing deployments without an independently
retained recoverable module/asset archive and producer record remain ineligible.
A version tag, successful deploy run or local manifest hash cannot substitute for
that missing channel. The staging-only retention wiring below is part of this
installer, not evidence that an eligible deployed baseline already exists. No
live baseline was read to establish this source-level refusal. Complete provider,
serving, artifact and journal joins remain unfinished implementation, not a new
scope or credential authorization wait.

### Normal staging byte retention (wired, not live-qualified)

[Normal staging deployment](../.github/workflows/deploy.yml) now captures Wrangler's
actual web upload form using `deploy --outfile`, and its separate JSON-lines deploy
output using `WRANGLER_OUTPUT_FILE_PATH`. Both live only in a private runner-temp
directory. The original deploy target, tag, route flags and credential scope stay
unchanged. Retention tooling and its complete import closure come from the
workflow-pinned control checkout, not the deployed source checkout, which may
predate this helper. Both revisions are recorded separately. Retention preserves
normal deploy reruns and records their explicit attempt; that does not remove the
reader's independent attempt-1 admission restriction. Production workflows and
configuration are untouched.

[The bounded sanitizer](../ci/candidate-staging-baseline-retain.mjs) does not run
retained code. It accepts only the fixed staging Worker/custom-domain deploy
output and explicitly numbered producer attempts, matching the exact source tag. It
retains the serialized `_worker.js` module and optional source map with their
content types and SHA-256 hashes, plus a descriptor-pinned traversal of the Kit
assets. The shipped adapter's exact `.assetsignore` text is required; arbitrary
ignore rules and unknown control files refuse rather than invent an asset set.
Module names, sizes, file counts, form/metadata sizes and aggregate retained bytes
are bounded. Links, duplicate modules, unsupported types and malformed output
refuse with one fixed error.

Upload metadata is **never serialized** into the retained artifact. In particular,
the form's asset JWT, binding values and package metadata are discarded. The raw
form and deploy output are removed in the sanitizer's `finally` and by the
deploy shell's `EXIT` trap on success or failure. The sanitizer runs after Wrangler
with provider credentials explicitly removed from its environment. Hard runner
termination still relies on destruction of that ephemeral runner; an exit trap
cannot run after a hard kill. No raw capture or runner-temp wildcard is an artifact
input.

The first immutable artifact contains only `baseline.json` and flat numbered
regular files. Its manifest binds repository, source/workflow revisions, run and
attempt, the Wrangler-reported version UUID, logical module/asset paths, content
types, sizes and byte hashes. Only after that upload returns its artifact ID and
archive digest does a separate step assemble and upload `producer.json`, binding
them to the manifest and byte-root digests. Both uploads use the pinned artifact
action, fail on absent files and retain for 30 days. Missing or expired evidence
is a refusal, not a request to use latest. Reruns remain refused by the current
producer reader; artifact names alone establish no per-attempt authority.

These records say `retained-bytes-only` or `producer-join-only` and
`promotable:false`. The version ID is an observed CLI result, **not** independent
provider/serving proof. The installed controller must still authenticate both
artifact channels and source closure, rehash every byte, compare immutable
provider code/config/assets and actual serving state, and bind the result to
exclusion and the dirty journal before candidate mutation. Source-map recovery
conformance, asset-service ZIP compatibility, stored-asset readback, complete B
admission and the controller remain unqualified. Existing mock reader passes and
local dry-run compatibility do not establish a successful live producer run,
recovery retention, activation clearance or native Security approval.

## B-prime request construction (offline, not installed)

[The baseline constructor](../ci/candidate-staging-baseline-upload.mjs) prepares
an inert JSON request for a new B-prime version. It makes no provider request,
reads no secret, selects no traffic and grants no journal-cleaning authority.
Restoring original B traffic alone leaves the candidate as the latest uploaded
version, so the ordinary uploader could still inherit its missing secrets and
leftover QA verifier. This constructor is one part of repairing that state,
not proof that the state has been repaired.

The input is an original-B web-component manifest, its **independently pinned**
canonical digest, and separately obtained module/asset buffers. The manifest
binds Q, the installed staging-profile digest, B's full UUID, capture time,
entrypoint, runtime, placement, original build tag, explicit binding inventory,
asset policy and sorted file records. Every supplied byte is copied and rehashed
against those records; missing/extra/replaced files, path/case aliases, sparse
arrays, unsupported fields/types and aggregate bounds refuse. File limits remain
4096 entries and 16 MiB total decoded module plus asset content. Module bytes
are only base64-encoded as data, never imported, executed or resolved.

The supported subset preserves the current staging compatibility date/flag,
original 40-hex build tag and targeted `aws:us-east-1` placement. Public text
bindings are restricted to the eight names in the staging Kit configuration;
Hyperdrive names are only DB/BOT_DB and queue producers only the two fixed
staging names. Unsupported retained variables/components refuse; they must not
be silently dropped when producing the manifest. No service/production target,
extra runtime policy or `QA_RUN_AUTH` binding can enter this request. A matching
profile or baseline hash proves identity, **not** account/resource scope,
synthetic-data isolation, completeness or original-B provenance.

Only secret binding **names and types** are admitted. Secret text, key material,
renames and caller-provided inheritance sources refuse. Construction replaces
each secret record with `{name,type:"inherit",version_id:<original B UUID>}`;
non-secret bindings are explicit. There is no `latest` fallback or implicit
binding retention. The
[pinned Workers API contract](https://github.com/cloudflare/cloudflare-typescript/blob/v5.2.0/src/resources/workers/beta/workers/versions.ts#L1366-L1390)
supports the full version pin. The classic script endpoint does not, so the
request targets only `/workers/workers/two-web-next/versions?deploy=false`, never
the classic upload endpoint or immediate deployment. The body carries B's modules,
runtime, tag and placement, not mutable script settings/tails/subdomain policy.

Asset-bearing B additionally requires a completion ticket joined to Q, B's
manifest digest and its exact asset-record root. This is a shape/integrity check,
not signature/provenance verification. The guarded recovery asset transport below
creates that session from the admitted B bytes; a future version sender must
consume its ticket internally. The candidate uploader retains its fixed QA expiry;
recovery asset transport does not issue, replace or renew QA credentials.
Module-only B requires a null ticket and no assets config/binding. Asset policy
is explicitly Worker-first. The JSON body contains an asset capability and module
bytes: never log, persist or publish it. Only the frozen digest/identity proof is
public; it explicitly says `inert-baseline-request-only` and `promotable:false`.

The pinned SDK defines the Workers JSON create/modules/assets/inherit shape;
the shipped Wrangler 4.156.1 parser establishes targeted placement conversion
from the staging configuration. That older SDK's placement type lists only smart
mode: **targeted placement acceptance by this Workers endpoint is unobserved**,
not inferred from the classic client's behavior. Refusal needs provider evidence,
not silently dropping placement or switching to `latest` inheritance. All current
tests are offline fixtures, not cross-API conformance or live recovery evidence.

The installed authenticated original-B manifest producer/download/channel,
complete immutable B/provider/component/stored-asset admission, installed guarded
asset/version senders, independent B-prime module/config/assets readback, B-prime traffic
selection and latest-upload/ordinary-uploader inheritance verification remain
required. Recovery must run under exclusion and authenticated dirty occupancy,
leave occupancy dirty on uncertainty, and restore mutable sinks only after
independently admitted baseline code serves. This helper supplies none of those
adapters, no activation authority and no complete recovery receipt.

## B recovery assets (mock-qualified, not installed)

`createCandidateBaselineAssetUploader` in [the asset transport](../ci/candidate-staging-assets.mjs)
reuses the existing fixed-endpoint session/bulk/single protocol, rather than
running Wrangler or candidate tooling during recovery. Both the asset transport
and B-prime constructor use the same copied-byte original-B manifest admission.
The transport uploads only asset records, retaining their exact public paths,
and returns an in-memory ticket joined to Q, the baseline digest and asset root.
It never uploads a Worker version, selects traffic or marks occupancy clean.

Every provider request requires trusted installed exclusion, dirty-baseline
ownership and authenticated original-B admission **before and after** its
response. Those adapters receive the frozen Q/profile/baseline/asset-root context
and enclosing abort signal; they remain installation prerequisites, not supplied
by a candidate artifact. Guard failure or cancellation emits only a fixed error,
with no retry, ticket or provider details. Cached assets still require both
session guards; module-only B makes no provider request and returns no ticket.

Recovery can run after candidate QA expiry without renewing that credential or
accepting a caller verifier/clock/ticket/endpoint. It has a separate 120-second
operation deadline, 10-second request bounds and parent cancellation propagation;
provider asset capabilities must still pass their own expiry/bucket checks. The
API bearer stays at session creation, asset capabilities only at the fixed upload
endpoints. Tickets and request bodies are private transport state, never public
artifacts. Existing candidate uploads retain the fixed verifier deadline.

This is mock-qualified transport, not authenticated baseline production,
continuous exclusion, stored-asset readback, complete B-prime recovery or native
Security clearance. No workflow calls it and no live asset upload has run.

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

This journal is **not** a lock, a provider restore adapter or proof of the
baseline contents. The core workflow fencing below is only a partial actor map,
not complete global exclusion. The restore, verify and exclusion adapters must be installed
trusted code, never candidate callbacks. A pinned GitHub creator/App is a minimum
transport check, not independent controller provenance: other writers sharing
that principal must be contained before use. The source/run provenance, recovery
artifact producer/download/admission, provider observations, next-upload comparison,
complete published recovery receipt and normal-actor workflow wiring remain
required. A digest-shaped proof supplied by a candidate is never sufficient.
No live journal API or provider operation was used to qualify this helper.

## Core normal-actor fencing (partial; not activated)

The ordinary deploy, staging-e2e, ZAP and origin-quality workflows now share
`staging-application-exclusive`, with `cancel-in-progress:false`. Deploy holds
it for its whole workflow, including staging mutations and smoke. Its existing
job-level `deploy-staging` lock is retained, preserving legacy mutual exclusion
with the staging rollback mutation job. Staging-e2e holds the global key at
workflow level through scope, public/authenticated journeys and both reusable
children. Failed/cancelled/skipped/foreign/non-main completion events and non-main
dispatches select distinct rejected-run groups **before** concurrency admission,
so they cannot replace an eligible pending deploy. Reusable ZAP/quality callers
also reject non-main refs before entering the global key. GitHub can still replace
an eligible pending member with a newer eligible member; `cancel-in-progress:false`
protects the running interval, not a durable FIFO queue. The existing test commands,
case set, budgets and promotion identities are unchanged. This changes staging
scheduling, not production selectors.

ZAP and origin-quality acquire the same global key on standalone dispatch or
schedule. Their reusable-only `staging_lock_inherited` input defaults to false;
the trusted staging-e2e caller explicitly sets it to true while holding its
continuous lock. Inherited children use distinct per-run groups, never recursively
acquire their parent's global key. The read-only preflight workflow acquires no
lock itself. Any additional caller must establish the same whole-call exclusion;
the input is not a lock certificate or authorization for a candidate caller.

[The normal-actor guard](../ci/candidate-staging-clear.mjs) reads the complete
bounded journal with the existing reader and public pinned GitHub Actions bot/App
identities. No status, or any status other than the admitted restoration success,
refuses normal work. Unknown/malformed/foreign-principal records, incomplete
pagination and transport/authentication failures refuse, without retries or an
alternate token. It only GETs metadata, writes nothing, restores nothing and logs
no remote error/payload. A clear observation is not a lease on future state.

The guard accepts only main-branch runner context for this repository, never a
dispatch-selected ref/profile/identity. Its separate three-file Node-builtins-only
source closure is checked out at immutable `github.workflow_sha`, with persisted
Git credentials disabled, not at the deployed source SHA. Deploy runs it before
dependency installation or any live staging operation. The other core workflows
put it in a prerequisite job, so a failed guard skips the entire probe/test job,
including steps with `!cancelled()` failure-reporting conditions. Only
`deployments:read` is added; there is no new write-capable journal principal.

### Auxiliary staging-only actors

Seven additional workflows hold the same whole-workflow exclusion and require
that read-only reusable guard before any of their original jobs can run:

| Workflow | Existing operation (unchanged) |
| --- | --- |
| `staging-smoke` | Real staging bot internal-action smoke |
| `staging-role-bootstrap` | Fixed staging role existence check and constant DDL |
| `staging-importer-dryrun` | Counts-only importer and verification dry run |
| `staging-catalog-preflight` | Read-only staging catalog transaction |
| `staging-census` | Scope verdict, then counts-only session census |
| `explore-staging` | Scheduled or dispatched guest browser exploration |
| `error-rate-gate-rehearsal` | Staging live analytics and simulated refusal |

Main-only dispatch/schedule eligibility is checked both before entering the
shared group and on the guard job. Rejected refs/events use unique per-run groups
and skip the dependent job graph; they cannot displace eligible pending work.
Existing trigger sets are unchanged (only the explorer is scheduled). Census
keeps its original scope/relevance condition: the guard precedes scope, not a
parallel path around it. Original commands, inputs, secrets, targets, timeouts,
runner choices and even failure-reporting step conditions are pinned unchanged
by regression tests. Guard failure skips each entire dependent job, including
its `!cancelled()` artifact step. No inherited-lock input or new write principal
is added. These actors' former distinct groups had no other workflow callers;
the shared non-cancelling interval replaces their per-tool serialization.

### Mixed-target database actors

`db-migrate` and `db-backup` retain their existing non-cancelling workflow-level
`web-migrate-${{ inputs.target }}` and `db-backup` groups. Their single staging
job additionally holds `staging-application-exclusive` from before its first
step until every database/backup operation completes. Only exact staging targets
on main acquire that shared group; backup's omitted target still means staging.
Non-main staging and unknown targets cannot run the job or displace a pending
member of the shared group. Production uses a separate per-run job group, skips
all three new guard steps and keeps its original operations and legacy lock.

The guard checks out only the same immutable three-file source closure, sets up
Node 24 without dependency caching/install, and performs its read-only journal
check before the original checkout, provisioning probe or dependency install.
Migration's original shell-only ref/enable/hold gate still runs first, before
any checkout. Guard failure prevents all original downstream steps through
implicit success conditions; none has an explicit status-function override.
Original triggers, environment bindings, holds, selectors, commands, secret
mapping and timeouts are hash-pinned unchanged. Only deployments-read is added.
There are no in-repository reusable callers of these database workflows; a new
staging caller must not already hold the same shared key (that would deadlock).
No caller-supplied inherited-lock bypass is introduced.

### Staging rollback and rollback drill

Standalone main staging rollback holds the shared key for its entire workflow.
Its mutation job retains the legacy `deploy-staging` key and runs the same trusted
three-step read-only occupancy check before its original checkout, dependencies,
credentials, provider reads or rollback. Preflight remains a credential-free
GitHub gate. Non-main staging refs use per-run rejected groups and cannot run
preflight or the dependent mutation job. Production keeps its original outer
`rollback-production` group, inner `production-worker-mutation` key, gates,
steps and notification path; all new guard steps skip on production.

The staging drill holds one continuous interval across its plan, both reusable
rollback legs, restoration and final verdict. The read-only occupancy prerequisite
precedes the plan; each leg rechecks occupancy before its existing operations.
Both calls pass the reusable-only `staging_lock_inherited:true`, selecting a
per-run callee group rather than recursively acquiring the parent's shared key.
That input is unavailable on manual dispatch, defaults to false and is not an
ownership certificate. In-repository callers are exhaustively pinned: only the
continuously locked drill inherits staging exclusion; the production automatic
rollback caller does not pass it and is unchanged.

The drill's former thirty-minute `--staging-busy` poll is removed: queued deploys
and journeys now wait behind its own shared key, so waiting for those queued runs
would self-deadlock. Continuous exclusion replaces that point-in-time busy check,
not the original version/ref/CI/secret/identity-smoke gates. The restored-version
guard and the requirement that traffic move in both legs remain unchanged.
Original workflow graphs are hash-pinned after removing only the new fence and
that obsolete poll. No production workflow or target selector is changed.

### Mixed-origin watches and staging soak

`watch-guest-journeys` and `watch-lighthouse` retain their original workflow-level
watch groups. Only the main-branch, manual staging-origin job additionally holds
`staging-application-exclusive` for every step. The same trusted three-step
occupancy guard runs before original checkout, dependencies or browser probes.
Apex and www watch jobs stay outside shared staging exclusion, skip all guard
steps and keep their original tools, budgets, targets, timeouts and reporting.
Job admission explicitly allows only those two production origins or eligible
staging: unknown origins, including staging URL aliases with a trailing slash or
port, cannot fall through to an unfenced probe. Tool-level target validation is
still unchanged. Non-main staging cannot run or displace pending shared work.
Failure-reporting artifact/summary steps may run after guard failure, but all
network probes and installs retain implicit success conditions and cannot run.

The production workflow's `staging-soak` job alone holds shared exclusion while
reading staging versions and analytics. Its unconditional trusted occupancy guard
precedes all original steps, including staging credential access. The workflow's
legacy `deploy-production` group, original preflight, selectors, staging measurement,
outputs, production checks/mutations/holds and rollback path remain unchanged.
Only this staging observer gains deployments-read; production jobs do not.
No parent or reusable child reacquires its shared key. These staging scheduling
changes are not changes to production serving, selection or deployment behavior.

The existing `rum-web-vitals` reader is unchanged and outside this application
staging key: its [documented contract](rum-web-vitals.md) binds the production
account and production site tag; its query selects that site, not staging Worker
versions. This is a **source-contract classification, not a live configuration or
capability observation**. Changed or mixed site bindings require reclassification
before activation. The isolated `gradual-promote-proof` harness targets its own
synthetic Worker, not this application's staging Worker; its generated
`env.production` names that synthetic target and is not production deployment
configuration. Shared account/capability admission is still required separately.

**Incomplete exclusion:** this source-backed set of workflow fences is not proof
of complete actor coverage or installed global exclusion.
Pre-install in-flight runs, console writers and other-repository actors are not
contained by these changes. Source/environment protection, complete actor
coverage, independent principal/data admission and drain evidence remain required
before any candidate mutation. A short list of fenced workflows must not be
presented as global exclusion. The candidate controller, build sandbox,
authoritative producer channel, activation and verified B/next-upload recovery
are still uninstalled/inactive. No live journal or staging request has exercised
these workflow changes.

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
