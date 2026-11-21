# M0 page-renderer migration

Status: **approved direction** (owner direction 2026-11-04, recorded
2026-11-06; [ADR 0001](../adr/0001-sveltekit-page-renderer.md)).
This plan records the approach, what is implemented versus what remains, and
the exact verification route for the [M0 milestone spec](../specs/m0-page-renderer.md).

**Scope note.** This plan uses the *page-renderer* meaning of M0 from ADR 0001
(every page family Kit-served in production, plus the Kit Worker cut's 48-hour
acceptance). The canonical product roadmap also labels the Ember Hours
milestone "M0" in the internal planning system; no source in this repository
defines how the two relate, so they are not equated here. See the
reconciliation in [specs/README.md](../specs/README.md). Ember Hours core
scope is **approved** direction in [ROADMAP.md](../../ROADMAP.md); only later
expansion beyond the accepted scope stays proposed.

## Approach

The SvelteKit tree in `web/` is a strangler over the Hono Worker. The hook
asks the method-aware manifest in `src/route-ownership.ts` which renderer owns
each request and hands every other request to the unchanged in-process Hono
app. The Kit Worker runs on the preview Worker and, on staging, serves only
the archive and static families. Families migrate one at a time: a page family
starts its cutover, its Hono handler is frozen to fixes only, and flipping the
manifest entry to `enabled: true` rolls the route to Kit. Rolling the entry
back to `false` is the per-route rollback until that family's rollback end.

Order within M0 follows family readiness, not a fixed calendar. Live delivery
order stays in the internal planning system; this plan carries only the
approach and the gates.

## Implemented versus remaining

- **Implemented (slice level, not M0):** individual families have their Kit
  handlers in `web/` and staged entries in the manifest, gated by the
  [Kit parity gates](../kit-parity-gates.md). Staging admits only the archive
  and static families today; no production request is Kit-rendered yet.
- **Remaining:** every page family serving by Kit in production, then the
  48-hour production acceptance of the Kit Worker. A family counts toward M0
  once its GET pages are Kit-served in production; rejected-POST pages move
  with their write families after M0.
- **Not in M0:** moving the retained Hono APIs, any backend rewrite or
  contract deletion. Direction for post-M0 API migration is approved; each
  post-M0 family needs its own plan, tests, review and release gates.

## Verification route

1. Per-slice parity: the [Kit parity gates](../kit-parity-gates.md) prove a
   migrated route renders the Hono contract before it owns traffic, flipping
   with the manifest entry.
2. Quality and accessibility: `npm run lighthouse`, `npm run lighthouse:quality`
   and `npm run a11y` run against the Hono site. They do not qualify a Kit
   route they did not exercise; each slice brings its own screenshots and
   evidence at desktop (1280×800) and mobile (390×844) widths per the UI-change
   loop in `AGENTS.md`.
3. Release: green required checks on the exact head, review and findings
   disposition, and the release-manager confirmation for the production
   promotion in `CONTRIBUTING.md`. A merged PR is not proof of production
   activation.
4. Production acceptance: the 48-hour production acceptance of the Kit Worker
   under the [48h post-flip watch](../48h-watch-spec.md), then M0 is met.

For the deployed artefact, see [setup and operations](../runbooks/README.md);
for the direction boundary, the [website roadmap](../../ROADMAP.md).
