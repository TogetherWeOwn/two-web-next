# Route evidence artifact bootstrap

`ci/route-evidence-artifact-metadata.mjs` is an inert validation building block.
Its synthetic fixtures are not route parity or evidence admission. No workflow
calls it and no completion declaration is enabled by it.

A future trusted consumer must first obtain the expected source SHA independently
from GitHub's PR/event metadata, distinguish it from the workflow orchestration
SHA, and use the run and attempt-specific GitHub APIs. The supplied artifact list
must be the complete, paginated set of matching artifacts for that run, not a
candidate-provided list or a latest-by-name lookup. The expected artifact ID and
digest must come from a trusted producer wrapper, not the artifact itself or a
candidate-controlled output. This helper refuses missing or multiple matches,
unsuccessful producer metadata, a different attempt-specific name, digest, run,
source head or creation window, an expired or oversized artifact, and PR head drift.
It does not prove which job uploaded an artifact: run metadata, timing and a name
are not job authentication. Until the wrapper and GitHub control-plane association
are independently established, a successful return is not trusted provenance.

Remaining integration must use reviewed base-pinned workflow and consumer code,
explicitly check out and verify the candidate source SHA in an unprivileged
producer without persisted checkout or production credentials, and isolate the
trusted wrapper and its outputs from candidate code. The consumer must verify the
producer's successful runner/report steps, authenticate the artifact-to-job and
attempt association, download by immutable ID with compressed and extracted size
limits, verify the digest, and parse reports only as data with the existing strict
adapters. It must bind reviewed input hashes and exact selectors to the evaluated
checkout, retain inspectable evidence, and fail the required aggregate on failure,
cancellation or an unexpected skip. Synthetic end-to-end positive and negative
runs must exercise that boundary before real admission; current reviewed
obligation inventory, route coverage and API-10 retirement remain unresolved.
