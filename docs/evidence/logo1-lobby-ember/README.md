# Logo 1 (Lobby Ember) brand apply — before/after evidence

Home, events, join and the branded 404/503 shells at 1440px and 390px,
full-page, `<time>` masked. Before shots render the base revision through
the same harness; after shots render this branch.

Harness: `ci/lighthouse-worker.ts` fixture pages for `/`, `/events`,
`/join` (the same bytes the local Lighthouse job measures) plus scratch
error-handler renders for 404/503, served with each tree's own `public/`
over local HTTP and captured with headless Chromium after `document.fonts.ready`.

Layout, structure and copy are unchanged between each pair; only theme and
brand move (tokens, header lockup, fonts, favicon/manifest/OG).
