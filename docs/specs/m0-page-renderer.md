# M0: page-renderer milestone

Status: **approved**. Basis: [ADR 0001](../adr/0001-sveltekit-page-renderer.md)
(owner direction 2026-11-04, recorded 2026-11-06; canonical record ADR 0001).
This spec states M0's requirements and acceptance criteria only; the approach
and its slice-by-slice status live in [plans/m0-page-renderer.md](../plans/m0-page-renderer.md).

**Scope note.** This spec uses the *page-renderer* meaning of M0 from ADR 0001
(every page family Kit-served in production, plus the Kit Worker cut's 48-hour
acceptance). The canonical product roadmap also labels the Ember Hours
milestone "M0" in the internal planning system; no source in this repository
defines how the two relate, so they are not equated here. See the
reconciliation in [specs/README.md](README.md).

## Requirement

Every page family is served by SvelteKit with Svelte 5 in production, and the
production cut of the Kit Worker has finished its 48-hour production
acceptance. Hono keeps every non-page contract meanwhile: OAuth and session
endpoints, form and JSON write handlers, JSON, feeds, the public API and
OpenAPI, MCP, agent ingress, health, version, the CSP sink, SEO files, legacy
redirects and static assets. The method-aware ownership, same-origin, session,
CSRF, body-limit and throttle rules stay as they are.

## Page families

A "page family" is a group of GET pages migrated together; its rejected-POST
page moves with its write family after M0. A family counts toward M0 once its
GET pages are Kit-served in production. In particular:

- A retained write handler that answers a rejected native form with an HTML
  page still renders that page through Hono until its write family migrates;
  the Kit page for the same form mirrors that response (status, entered values,
  field errors, and the no-JavaScript path).
- No permanent Hono/Kit page twins and no Astro/Kit hybrid.
- New page work goes into `web/` only; a Hono page handler is frozen once its
  family starts its Kit cutover and receives fixes only.
- Content routes stay server-rendered, with `csr = false` wherever a page
  needs no enhancement. Interactive widgets use explicit, budgeted
  enhancement. Native forms and every no-JavaScript journey stay supported.

## Acceptance criteria

1. Each page family is Kit-served in production (manifest entry `enabled:
   true` on the production binding) with Hono as fallback only where the
   decision permits.
2. The production cut of the Kit Worker has completed its 48-hour production
   acceptance. The watch procedure is the
   [48h post-flip watch](../48h-watch-spec.md) in the operations runbook.
3. Per-family parity evidence is green for the routes that migrated, under
   the [Kit parity gates](../kit-parity-gates.md). The Hono-only gates do not
   qualify a Kit route they did not exercise; each slice brings its own visual
   and performance evidence.
4. Per-route rollback (manifest entry back to `enabled: false`) remains
   available until that family's rollback end. After deletion of the Hono
   handler, rollback is whole-release only.

## Non-goals

This milestone does not authorize moving the retained Hono APIs into SvelteKit
(direction approved, authorization is not), any backend rewrite, contract
deletion, new infrastructure, credential or spend. Each post-M0 family needs
its own design, tests, review and release gates.
