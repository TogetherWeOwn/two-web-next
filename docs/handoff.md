# Handoff — current source state

Last reviewed: 2026-11-10 (UTC). This is a dated snapshot, not a live work queue.
For live status, assignments and dependencies, the internal planning system
remains canonical; this file records where the repository stood at the review
date so a fresh reader can resume from the repository alone.

## Source state at review time

- Repository: `TogetherWeOwn/two-web-next`, default branch `main`.
  HEAD on `main` at review: `1fe09ab8` ("fix(ci): accept bounded startup
  profile timestamp reversals").
- **Production is frozen at release `v2026.1107.2`, built from commit
  `943f0b40` (2026-11-07 19:06Z).** No production deploy has shipped since.
  The current `main` HEAD is ahead of the deployed release. See
  [GitHub releases](https://github.com/TogetherWeOwn/two-web-next/releases)
  for the shipped history.
- Stack: Hono on Cloudflare Workers, TypeScript, Drizzle + Postgres,
  server-rendered HTML with plain JavaScript islands. SvelteKit with Svelte 5
  under [`web/`](../web/) is the accepted single page renderer; Hono keeps the
  non-page APIs for now. See [architecture.md](architecture.md), the
  [renderer decision](adr/0001-sveltekit-page-renderer.md) and the
  [website roadmap](../ROADMAP.md).
- Direction entry point: the public [website roadmap](../ROADMAP.md) (landing
  via its pull request, see "Open pull requests" below) summarises approved
  community/event direction and the **approved** Ember Hours core scope (the
  shared visual system across the site's home, events, join and sign-in,
  member discovery, profiles and moderator screens, with the seat and
  reserve-offer journeys, Event Echoes, profile history and privacy controls,
  honestly labelled season rankings, live voice context, event action
  timelines and a privacy-filtered bot activity feed). Only later expansion
  beyond that accepted scope is proposed and unapproved. The roadmap's
  non-goals apply.
- "M0" appears in two distinct senses: ADR 0001's page-renderer milestone
  (every page family Kit-served in production, plus the Kit Worker cut's
  48-hour acceptance) and the canonical product roadmap's Ember Hours
  milestone in production. No source in this repository defines how the two
  relate; whether they are the same, overlapping, or separate milestones is
  unresolved. See the reconciliation in [specs/README.md](specs/README.md).
- Accepted milestone contracts live in [specs/](specs/README.md); approved
  approaches and their implemented-vs-remaining status in
  [plans/](plans/README.md); material decisions with provenance in
  [decisions/](decisions/README.md); deploy, rollback and recovery procedures
  in [runbooks/](runbooks/README.md) (index over the operations runbook).

## Open pull requests and branches at review time

(Reviewed 2026-11-10 at HEAD `1c2b50c9`, the head of the roadmap entry PR.)

- **Website roadmap entry** — head `1c2b50c9`, branch `docs/public-roadmap-entry`.
  Publishes the public roadmap and records the post-cutover milestone proposal
  as history. This handoff stacks on that head for composition; at integration
  it consumes the merged roadmap content. Its recorded exact-head Actions runs
  (PR standards, CI, docs-links, e2e, PR lint, gitleaks, CodeQL) passed. A
  merged PR is not proof of production activation: verify on the deployed
  artefact per the runbook before treating it as live.
- **Release-hold remedy and promotion fixes bearing on the next step:**
  [#2092](https://github.com/TogetherWeOwn/two-web-next/pull/2092) (production
  Kit Worker cutover), [#2088](https://github.com/TogetherWeOwn/two-web-next/pull/2088),
  [#2093](https://github.com/TogetherWeOwn/two-web-next/pull/2093),
  [#2097](https://github.com/TogetherWeOwn/two-web-next/pull/2097),
  [#2098](https://github.com/TogetherWeOwn/two-web-next/pull/2098),
  [#2099](https://github.com/TogetherWeOwn/two-web-next/pull/2099),
  [#2100](https://github.com/TogetherWeOwn/two-web-next/pull/2100),
  [#2101](https://github.com/TogetherWeOwn/two-web-next/pull/2101)
  (promotion, CI, watch-scheduling and staging-qualification fixes).

## Concrete blockers

- **Production release hold.** Every production deploy is refused while
  exact-`main` staging fails the mobile `/events` largest-contentful-paint
  budget, so production stays at `v2026.1107.2` (`943f0b40`). Merges still
  land on `main`, but nothing new reaches production until the hold clears.
- The roadmap composition depends on the roadmap entry PR landing first (see
  above). If it does not land, this handoff's link to the roadmap remains to be
  reconciled; the remaining documents stand alone.

## Last verification

Documentation-only change. Verification was a focused content inspection:
relative links resolve to existing files, no internal tracker references or
credentials appear in the new prose, and no application, instruction or
workflow behaviour changes. No local test suite, CI mirror, build or
deployment ran. GitHub Actions is the CI of record; exact-head Actions results
are recorded in the pull request body. A merged pull request was not treated
as live evidence.

- Candidate head SHA: `689d6a27` (the link-only commit after it changes
  only these lines).
- CI run for the candidate head: [Actions run 42886309702](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42886309702)
  — all required checks green on `689d6a27` (`ci-ok`, `gitleaks`, `e2e-ok`,
  `pr-lint`, `check`, `docs-links`, `node22-compat`, `pr-standards`).

## Next unfinished step

In the order the canonical product roadmap tracks them (weekly-review header
2026-11-09):

1. **Clear the release hold** — run the schedule-only removal investigation
   (see [Decision 0004](decisions/0004-critical-css-lcp-remedy.md)), the promotion
   resolver fix, and the production Kit Worker cutover
   ([#2092](https://github.com/TogetherWeOwn/two-web-next/pull/2092)).
2. The Release Manager **re-qualifies exact-`main` staging**.
3. The **queued finished PRs merge** once the hold clears.
4. The **M0 slices continue** (both senses: the Ember Hours milestone slices
   and the page-renderer family migrations; their relationship is unresolved
   in this repository — see above).

Ember Hours **core** scope is approved; only later expansion beyond the
accepted scope stays a proposal until accepted through normal product
planning. The roadmap's non-goals apply.
