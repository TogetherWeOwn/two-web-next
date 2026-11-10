# Handoff — current source state

Last reviewed: 2026-11-10 (UTC). This is a dated snapshot, not a live work queue.
For live status, assignments and dependencies, the internal planning system
remains canonical; this file records where the repository stood at the review
date so a fresh reader can resume from the repository alone.

## Source state at review time

- Repository: `TogetherWeOwn/two-web-next`, default branch `main`.
  HEAD on `main` at review: `1fe09ab8` ("fix(ci): accept bounded startup
  profile timestamp reversals"). Production serves the Worker built from
  `main`; see [releases.md](releases.md) for release history.
- Stack: Hono on Cloudflare Workers, TypeScript, Drizzle + Postgres,
  server-rendered HTML with plain JavaScript islands. SvelteKit with Svelte 5
  under [`web/`](../web/) is the accepted single page renderer; Hono keeps the
  non-page APIs for now. See [architecture.md](architecture.md), the
  [renderer decision](adr/0001-sveltekit-page-renderer.md) and the
  [website roadmap](../ROADMAP.md).
- Direction entry point: the public [website roadmap](../ROADMAP.md) (landing
  via its pull request, see "Open pull requests" below) summarises approved
  community/event direction, Ember Hours boundaries and non-goals. It is an
  entry point, not a delivery schedule and not a task tracker.
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
- No other open pull request in this repository at review time conflicted with
  the documents in this handoff.

## Concrete blockers

- None recorded for the local runbook, spec, plan and decision documents in
  this handoff: their sources are already in the repository (operations
  runbook, architecture and config references, renderer ADR, parity matrix,
  moderator and planning guides).
- The roadmap composition depends on the roadmap entry PR landing first (see
  above). If it does not land, this handoff's link to the roadmap remains to be
  reconciled; the remaining documents stand alone.

## Last verification

Documentation-only change. Verification was a focused content inspection:
relative links resolve to existing files, no internal tracker references or
credentials appear in the new prose, and no application, instruction or
workflow behaviour changes. No local test suite, CI mirror, build or
deployment ran. GitHub Actions is the CI of record; exact-head Actions results
are recorded in the pull request body at draft time. A merged pull request was
not treated as live evidence.

## Next unfinished step

The next step is integration review of the roadmap entry PR and this handoff
against the accepted milestone sources in [specs/](specs/README.md) and the
provenance record in [decisions/](decisions/README.md), then final
clean-source acceptance. Any remaining Ember Hours scope stays a proposal
until accepted through normal product planning; the roadmap's non-goals apply.
