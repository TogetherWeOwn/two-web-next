# Decision 0001: SvelteKit with Svelte 5 is the single page renderer

- Status: accepted (owner direction, 2026-11-04)
- Recorded: 2026-11-06
- Deciders: the project owner (direction); the Engineering Lead (record and
  technical boundaries)
- Source verified at: revision recorded in the canonical ADR
- Canonical record: [ADR 0001](../adr/0001-sveltekit-page-renderer.md)

## Context

Production serves the Hono Worker: server-rendered JSX with plain JavaScript
islands. The SvelteKit tree in `web/` is a strangler: its hook asks the
method-aware manifest which renderer owns each request and hands every other
request to the unchanged in-process Hono app. The Kit Worker runs on the
preview Worker and, on staging, serves only the archive and static families.
No production request is Kit-rendered today.

The next UI generation needs one page renderer. A comparative trial
(SvelteKit against Astro with Svelte islands) was planned. The owner skipped
it and chose SvelteKit directly. That trial did not run; nothing here shows
that Astro would have lost. The separate Hyperdrive semantics probe passed 3/3
in its 2026-10-01 live staging run; that checks locking and GIN semantics, not
a renderer comparison.

## Decision

1. SvelteKit with Svelte 5 is the only page renderer for this site. There will
   be no permanent Hono/Kit page twins and no Astro/Kit hybrid.
2. Hono keeps every non-page contract until the page-renderer milestone (called
   **M0**): OAuth and session endpoints, form and JSON write handlers, JSON,
   feeds, the public API and OpenAPI, MCP, agent ingress, health, version, the
   CSP sink, SEO files, legacy redirects and static assets. A retained write
   handler that answers a rejected native form with an HTML page still renders
   that page through Hono until its write family migrates; the Kit page for the
   same form mirrors that response. A page family counts toward M0 once its GET
   pages are Kit-served in production.
3. **M0** means that every page family has served by Kit in production and that
   the production cut of the Kit Worker has finished its 48-hour production
   acceptance.
4. The owner approved moving the retained Hono APIs into SvelteKit after M0.
   That is direction, not authorization. Each post-M0 family needs its own
   design, tests, review and release gates. This decision authorizes no backend
   rewrite, contract deletion, new infrastructure, credential or spend.

## Consequences

- New page work goes into `web/` only. A Hono page handler is frozen once its
  family starts its Kit cutover; it gets fixes and nothing else.
- Hono stays a runtime dependency of the Kit Worker until the post-M0 migration
  finishes. The catch-all `web/src/routes/[...path]/+server.ts` remains the
  fallback, and setting a manifest entry back to `enabled: false` remains the
  per-route rollback until that family's rollback end.
- The Hono-only gates do not qualify a Kit route they did not exercise. Each
  slice brings its own visual and performance evidence per its plan.

See the full record, including boundary rules and the retirement register, in
[ADR 0001](../adr/0001-sveltekit-page-renderer.md). This entry is the
repo-only pointer; the ADR remains canonical.
