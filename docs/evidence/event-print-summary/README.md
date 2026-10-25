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
bare public URL (absolute http(s), no userinfo, query, fragment, malformed
encoding, decoded private segment, matrix parameter or recognized credential
path marker). Instruction lines containing an unsafe destination or labeled
credential stay screen-only; separate harmless lines remain printable. The
original instruction text stays unchanged on screen. Suppress in print: skip
link, site header/footer, all navs, RSVP
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
EVENT_PRINT_EVIDENCE_DIR=<dir> EVENT_PRINT_BROWSER_TESTS=true env -u DATABASE_URL -u BOT_DATABASE_URL \
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

## Privacy correction captures

The `review/` pairs exercise the same sensitive URL in the Hono joining link
and the instruction text, between two harmless instruction lines. Before uses
the original renderer; after uses the print-safe line projection. Both are
real route fixture responses with JavaScript disabled, not edited screenshots.
The title, schedule and harmless instructions remain legible; the sensitive
instruction line disappears only on paper. All eight screen/print sources
were opened at 1280x800 and 390x844. These additional captures exercise Hono;
the original paired Kit evidence above is unchanged (Kit has no joining-field
surface in this slice).

- Desktop print: [before](review/instructions-before-1280-print.png) /
  [after](review/instructions-after-1280-print.png).
- Mobile print: [before](review/instructions-before-390-print.png) /
  [after](review/instructions-after-390-print.png).
- Screen before/after bytes are identical at both widths; the retained
  [desktop](review/instructions-after-1280-screen.png) SHA-256 begins
  `507f428740d1156f`, and [mobile](review/instructions-after-390-screen.png)
  begins `92420f1ab92c59c8`.

Red-before proof: seven added destination cases returned `true` instead of
`false`; a real Chromium print fixture exposed the repeated sensitive URL.
After the correction, the destination/instruction unit suite passes 39/39,
and the desktop/mobile fixture probes pass 2/2. The temporary capture probe
was archived outside the source tree after capture. Existing focused print,
theme and host/join suites pass 93/93, with lint and typecheck passing.
The independently authored regression correction from commit `cc3a4bef83f9`
is incorporated unchanged: destination rejection (including draft), repeated
instruction URLs, computed ink contrast, the real join-result flash and the
real island's failed-refresh retry. The expanded six-suite run passes 105/105;
execution verifiers require and confirm 48 summary plus 2 narrow-wrap cases,
zero skips. Each isolated draft-guard, ink-remap, flash-selector and
retry-selector deletion was independently killed, with both production files
restored byte-identically afterward. No production changes from the test
transport branch were incorporated.

Round gates: lint/types, a11y (146/0), Lighthouse and Lighthouse quality
(24 reports each), asset and Worker budgets pass. These Hono quality gates do
not exercise Kit routes. The full local check was stopped after ten minutes
without a final result and is not claimed green. Hosted exact-head CI and
independent review remain required.
