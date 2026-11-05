# Staging attestor closure — review artifact, not an entrypoint

Operational E1 remains **NO-GO**. The installed/default-ref trusted-tooling
contract does not adopt premerge code as a secret consumer. No credential-use
amendment, effective resolution epoch, reader grant or dispatch is established by
this patch. Normal CI and all deployed workflows are unchanged.

## Exact review subject

- `ci/candidate-staging-attestor.mjs`: builtin-only structural preflight, single
  account-token identity observation and screened, non-promotable receipt logic.
  There is no CLI, environment lookup, default network transport or installed
  caller. Tests provide only synthetic subjects and injected transports.
- `ci/candidate-staging-attestor-ci.yml.txt`: the **complete proposed bytes** of
  registered `ci.yml`, retained outside `.github/workflows` with a non-workflow
  extension. It is not automatically copied, generated into place or dispatched.
  It contains prospective credential wiring and therefore must stay inert until
  separately admitted. Do not rename/copy it to install it as a review shortcut.
- `ci/candidate-staging-attestor-closure.json`: SHA-256 identities for the helper,
  proposed workflow and unchanged installed CI/deployment-chain inputs. The
  `actions` map gives immutable upstream Git revisions, not an assertion that the
  remote Action source was fetched/reviewed in this patch. The manifest excludes
  itself to avoid a circular hash; its repository commit identifies the packet.
- `ci/candidate-staging-attestor.test.mjs` and
  `ci/candidate-staging-attestor-workflow.test.mjs`: secret-free refusal,
  cancellation, redaction, replay, mode separation and downstream contracts.
  The existing candidate-fixture PR Actions lane includes both files, even on a
  draft. It needs no new workflow dispatch, secret, environment or provider call.

Review the repository commit **and** manifest bytes. The supplied `controlSha`,
`closureHash` and `useGrantHash` are comparison/evidence inputs. Their shapes or
hash equality cannot authenticate a grant, author, record, complete filesystem,
Action source or effective exclusion. The code intentionally never emits
`operationalAdmission:true`, a qualifying result or independent R acceptance.

## Prospective invocation and effect boundary

The proposal adds one manual `mode` choice to the existing registered CI, with
normal CI as the default. Every original job, including the aggregator and jobs
with explicit status functions, gains an attestation-mode exclusion. The excluded
aggregator also gets a distinct attestation-only check name: a skipped `ci-ok`
must not satisfy GitHub's required CI check. Other job fields are preserved
apart from copied historical tracking labels redacted in comments. Ordinary PR,
push, schedule, merge-group and normal manual
semantics stay the same. The attestation mode has a distinct run-ID concurrency
group, does not cancel another invocation and refuses main, non-dispatch events,
wrong repository, moved workflow/checkout SHA, wrong ref/run/job or reruns.

A future adopted invocation must freeze the exact non-main control ref to the
independently accepted commit, not merely accept a branch name. Native GitHub
context and the declared pinned checkout input are compared with the separately
established invocation record. `checkoutSha` is populated from `github.workflow_sha`;
it is **not an independently measured checkout HEAD**. The unnecessary inline Git
subprocess has been removed, not moved into another credential-bearing step.
Actual checkout provenance remains an independent admission obligation. These
comparisons are not a remote GitHub provenance reader; the adopted workflow,
protected injection and independent invocation evidence must supply that trust.
There is no arbitrary endpoint/secret-name input.

The proposed job uses a fresh GitHub-hosted runner, pinned checkout/setup-node,
one sparse builtin-only helper, no dependency install, candidate checkout/build,
shared cache, deployment tool, database, OIDC or policy-reader credential.
Repository credentials are not persisted by checkout. The only proposed subject
source is the existing staging environment secret, directly injected into one
step. There is **no implemented fallback** to another subject, token family,
secret source or endpoint. However, GitHub's native same-name secret fallback
cannot be detected by this helper: actual continuous environment-entry existence,
protected injection and precedence are external admission gates, not inferred
from the absence of fallback code.

The inline Node body imports only the reviewed helper, whose sole import is
`node:crypto`. Neither launches a child process: no Git executable, inherited
Git configuration, credential helper, askpass or alternate credential can become
an extra subprocess consumer from that body. The workflow fixtures enforce the
single Node heredoc/import closure and exercise its success and refusal paths
with synthetic subject/alternate credentials and poisoned Git environment paths.
They execute only the inline body with mocked helper/transport boundaries in a VM;
no real environment, credential, subprocess or network is used by those fixtures.
This is not a sandbox or proof of runner/bootstrap isolation: the shell, Node
startup, pinned Actions and actual protected injection still require independent
exact-closure admission. No ambient-environment sanitization is claimed.

The mandatory injected transport performs one fixed account-owned-token verify
GET, with redirect refusal, omitted ambient credentials, no retry, a ten-second
request bound and the original nonrenewing maximum 120-second invocation window.
Denial, malformed identity, body overflow/invalid encoding, cancellation or expiry
consumes that local handle and returns a fixed error. Only the returned nonsecret
ID/status are projected; raw provider bodies, headers, JWTs/capabilities and
subject-derived hashes are never emitted. There is no policy or domain read.

The proposed workflow emits only a **pending-reconciliation subject observation**.
It does not call `finishAttestation` or claim post-use reconciliation already
happened. The in-process finishing API checks a genuinely produced observation
against externally supplied closing records and makes that pair terminal on
success **or rejection**. It cannot authenticate those records, persist a
cross-process receipt channel or perform the separate policy-reader join.
Those caller/evidence obligations remain explicit review/use-admission gaps,
not functionality silently substituted by fixtures or mutable configuration.

## Missing controls — not passing defaults

Before any use, independent reviewers and the proper decision-makers must settle:

1. Exact-closure premerge trust adoption, one-use authority, frozen ref/run/attempt,
   protected-environment eligibility and allowance. Source review alone cannot
   replace the installed-T/default-ref contract or authorize early merge.
2. Actual subject account/family and separately authorized metadata-reader
   identity and existing Account API Tokens Read grant. Unknown or user-owned
   family refuses; no dual-audience probe or new credential is proposed.
3. R: effective exclusion of **every** secret/configuration/invocation writer over
   queue-to-completion, attributable audit reconciliation, continuous intended
   entry and exclusive precedence, protected injection and causal same-ID join.
   An unresolved path, mutation/change-and-back, denied read or ambiguity refuses.
   Equal timestamps or hashes cannot prove exclusion or immutable secret version.
4. A protected, independently authenticated source for the envelope and its writer
   controls. The proposal shows a repository variable as an **unadmitted input**,
   not a trust root. Anyone able to rewrite it could satisfy structural checks;
   this patch does not claim otherwise. No operator coding or settings change is
   authorized by retaining this proposal.
5. Independently retained observation provenance, fresh closing records and the
   actual same-ID effective policy snapshot. The supplied policy identity/grant
   fields are required inputs, not a performed policy read. The pending workflow
   output is not a completed R/policy receipt or staging-only capability proof.

No mechanism here establishes canonical attachment generation/history, enforced
staging-only mutation permissions, synthetic bindings, full actor exclusion,
native controller-loss restoration/expiry or zero recurring idle cost. E2–E5,
complete unchanged authenticated tests, original bearer **and** session expiry,
restoration, independent implementation review and exact-head release gates stay
separate. No resource, credential, permission, spend or production change occurs.

## Downstream and production-path analysis

The installed `deploy.yml` is the only current `workflow_run` consumer of `ci`.
Its deployment job requires an upstream **push** on main from this repository;
a successful manual attestation run is rejected even if labelled as main.
The proposed attestor additionally refuses main. `e2e-staging.yml` consumes
`deploy`, and `deploy-production.yml` consumes `e2e-staging` (with its existing
manual/scheduled paths unchanged). No deployment, promotion, rollback, selector,
required check, environment protection or normal production operation is edited.
The fixture enumerates CI consumers so a new chained consumer requires review;
this is source analysis, not a measured live admission/production result.

REA angle: reuse the registered CI surface, pinned sparse-control checkout and
existing secret-free candidate fixture lane; no new service or control plane.
