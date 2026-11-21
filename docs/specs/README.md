# Specs

Active milestone requirements, contracts and acceptance criteria. Existing
accepted specs stay where they are; this directory collects the milestone
specs that gate completion so a fresh reader can see what "done" means without
a tracker. No approval is invented here: each entry names its basis and date,
and anything without one is marked proposed.

| Spec | Status | Basis |
| --- | --- | --- |
| [M0 page-renderer milestone](m0-page-renderer.md) | Approved (owner direction 2026-11-04, recorded 2026-11-06) | [ADR 0001](../adr/0001-sveltekit-page-renderer.md) (canonical record) |
| [48h post-flip watch spec](../48h-watch-spec.md) | Approved (closed inaugural watch 2026-10-10–2026-10-12 UTC) | Operations runbook and cutover gates |
| [Kit parity gates](../kit-parity-gates.md) | Approved repository gate | Route manifest ownership rules; the accepted gate document in `docs/kit-parity-gates.md` |
| [Post-cutover milestone proposal](../post-cutover-milestone.md) | **Historical proposal — not an active milestone** | Superseded (see [Decision 0005](../decisions/0005-post-cutover-milestone-superseded.md)); its remaining ideas are not newly approved scope |

## The two meanings of "M0"

The repository uses "M0" in two distinct senses, and this directory does
not equate them. [ADR 0001](../adr/0001-sveltekit-page-renderer.md) calls
the page-renderer milestone M0: every page family Kit-served in production
plus the Kit Worker cut's 48-hour acceptance. The canonical product roadmap
tracked in the internal planning system calls the Ember Hours milestone M0
(Ember Hours in production). No source in this repository defines how the
two relate — whether they are the same milestone, overlapping milestones,
or separate milestones is unresolved here. The milestone spec in this
directory ([M0 page-renderer](m0-page-renderer.md)) covers the renderer
meaning only; Ember Hours scope is approved direction in
[ROADMAP.md](../../ROADMAP.md) and its delivery belongs to the roadmap
track, not to this spec.

## How to read this directory

- A spec here states requirements and acceptance criteria only. It does not
  schedule work, assign owners, or promote later backlog to commitments.
- The [website roadmap](../../ROADMAP.md) is the public direction summary and
  is not a spec. Architecture decisions and repository specifications retain
  their own scope; the roadmap does not replace them.
- "Approved" reflects acceptance already recorded in the repository. Later
  expansion does not become a commitment merely because it appears in a backlog
  or a historical proposal.
