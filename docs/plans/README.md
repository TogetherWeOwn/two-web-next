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
| Ember Hours core scope (website and bot surfaces in production) | **Approved** — the roadmap's accepted scope brings the shared visual system to the site's home, events, join and sign-in, member discovery, profiles and moderator screens, with the seat and reserve-offer journeys, Event Echoes, profile history and privacy controls, honestly labelled season rankings, live voice context, event action timelines and a privacy-filtered bot activity feed | Acceptance is the website and bot surfaces actually serving together in production with their acceptance and release gates met; merged code alone is not completion |
| Ember Hours later expansion beyond the accepted scope | Proposed only; not a commitment until accepted | Acceptance through normal product planning; roadmap non-goals apply |

The two meanings of "M0" (page-renderer vs. Ember Hours) are reconciled in
[specs/README.md](../specs/README.md); the page-renderer plan in this
directory covers the renderer meaning only. No source in this repository
defines the relationship between the two senses.

For live delivery order and assignments, the internal planning system remains
canonical. These plans are the repo-only record of approach and gates.
