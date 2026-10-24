# Event print summary: visual evidence

## Design contract

Audience: members keeping a legible paper or browser-PDF reference for a
game night. Print job: one-subject reference (what / when / where / host /
how-to-join / canonical URL). Primary action: the viewer's own browser
Print; no new button, endpoint, PDF service, library, or auto-print.

Retain: title, game kicker, full absolute start AND end with timezone,
venue, host, description, join instructions, accessibility notes, lineup
count, explicit Draft / Past event / Cancelled state. Add as readable print
text: the canonical event URL, and the join destination only when it is a
bare public URL (absolute http(s), no query, no fragment, no private path
segment). Suppress in print: skip link, site header/footer, all navs, RSVP
block, share block, named attendee roster, join pitch, join-result flash,
discovery, and the cancelled-page alternatives / .ics link / upcoming
button. Bearer, session, return-context and private destinations never print
as text or hyperlink. Gone pages carry no print URL: both renderers
deliberately omit canonical on 410, and print mirrors that served decision.

Keep Open Lobby/Logo 1 and the existing semantic tokens, remapped to
dark-on-white inside `@media print` on the event scope; existing
Display/system type, tabular-nums times, wrapping long titles/descriptions,
normal multi-page flow. No threshold, mask, baseline, budget, or
route-ownership change. Kit host/join/accessibility parity stays separately
owned: this styles what each renderer already has.

## Captures

Real Chromium print emulation against real route bytes per twin (Hono: the
served GET with intercepted fixtures; Kit: the executed route SSR with the
built root stylesheet), JavaScript disabled except the scripted
screen-print-screen control, at 1280x800 and 390x844:

```sh
npm ci --include=dev
npm ci --prefix web --include=dev
npm run build --prefix web
EVENT_PRINT_EVIDENCE_DIR=<dir> env -u DATABASE_URL -u BOT_DATABASE_URL \
  npx vitest run test/event-print-summary-acceptance.test.ts
```

Before shots use the same command on the pre-change tree. Print pairs below
are first-viewport crops of the full-page captures (seewhy: the long-title
fixture makes full pages 5-9k px tall); state shots are whole. Every image
here was opened and inspected, as were the full-page sources and the native
Chromium A4 PDFs (before: Hono 8 pages dark with chrome; after: Hono 7 pages
light, clean page 1 in the viewer shots below).

## Files

- `before/`, `after/`: `{Hono,Kit}-{1280,390}-print.png` — print pairs at
  both widths. Before: dark paper with header, RSVP, share, roster, pitch,
  discovery and footer. After: light paper, summary content, `Event page:`
  canonical line, no chrome.
- `after/Hono-{draft,past,cancelled}-print.png`,
  `after/Kit-{draft,past,cancelled}-print.png` — required states with
  explicit labels, no interactive actions.
- `after/Hono-1280-screen.png` — screen rendering is untouched: all four
  full-page screen captures are byte-identical before/after (sha256-12 of
  each pair: Hono-1280 `ffddbdeb4f27`, Hono-390 `e2635f308608`, Kit-1280
  `f05239924767`, Kit-390 `43d43dd4d21e`).
- `before/`, `after/` `Hono-pdf-page1-viewer.png` — native A4 PDF page 1 in
  the Chromium viewer. The after shot initially showed a diagonal seam from
  the hero gradient hard stops; the print stylesheet now neutralizes the
  hero background and the seam is gone.

Limits: container font fallback can differ from the pinned CI runner (the
CJK probe glyph renders as tofu locally in both runs), so these captures
prove layout and suppression, not CI-pixel identity. The committed
`browser-smoke` baselines are unaffected: screen pixels are identical, and
no baseline file changes in this slice.
