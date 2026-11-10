# Plans

Approved approaches, with what is implemented versus what remains and the exact
verification route. Status words mean:

| Word | Meaning |
| --- | --- |
| Proposed | Written down but not accepted; implies no commitment. |
| Approved | Accepted direction or scope; authorizes design and gated delivery, not an outcome. |
| Implemented | Code is on `main`; not proof of production activation. |
| Verified | Evidence exists that it serves in production (after the release gate). |

A merged pull request is not proof of production activation. Distinguish it
from production by checking the deployed artefact per the
[runbooks](../runbooks/README.md).

| Plan | Status | Verification route |
| --- | --- | --- |
| [M0 page-renderer migration](m0-page-renderer.md) | Approved direction (2026-11-04); slices implemented family by family | [Kit parity gates](../kit-parity-gates.md), Lighthouse/quality gates and per-slice visual evidence on the exact release head |
| Ember Hours surface expansion | Proposed scope intentions only; not a milestone plan until accepted | Acceptance through normal product planning; roadmap non-goals apply |

For live delivery order and assignments, the internal planning system remains
canonical. These plans are the repo-only record of approach and gates.
