# FAQ answer destination links — visual evidence

Captures use the real Hono `/faq` route rendered through the test app with no
database access, shipped public styles, and Chromium. The before images render
the same route with the FAQ content file at the base revision; the after
images render this branch. FAQ sections use `content-visibility: auto` for
LCP, which leaves offscreen sections unpainted in full-page captures, so the
capture adds one screenshot-only override (`content-visibility: visible`) to
paint every section; layout and page CSS are otherwise untouched. These are
fixture captures, not new visual baselines. No staging or production probe
was used.

## Design contract

- **Audience/job:** newcomers reading answers that already name a destination
  ("on the join page", "see the Events page", "open your profile") can tap
  straight there instead of hunting through navigation.
- **Content:** real FAQ copy, unchanged byte for byte. Six answers gain the
  optional trailing link the content model already supports: Join page
  (`/join`), Events page (`/events`, three answers), Your profile
  (`/profile`), Privacy policy (`/privacy`). Labels repeat the destination
  nouns the prose already uses.
- **Continuity references:** the existing recovery-guide link on the RSVP
  sync answer is the one prior use of this shape and stays untouched; link
  styling is the page's existing inline anchor style.
- **Layout, typography and tokens:** unchanged. The link renders inline at
  the end of the answer paragraph in every renderer; no stylesheet,
  component or island change.
- **Responsive behavior:** captured at desktop 1280×800 and mobile 390×844,
  full scrollable page at both widths. Links wrap with the paragraph text.
- **States:** the FAQ is one anonymous readable page; signed-in and
  signed-out renders share the same answer list. Discord-only answers stay
  unlinked and no external link is added.
- **Non-goals:** FAQ copy rewrites, new link placements inside sentences,
  jump/share/find mechanisms, print layout, budget or threshold changes.

## Images

| Viewport | Before | After |
| --- | --- | --- |
| Desktop 1280×800 | [before-desktop.png](before-desktop.png) | [after-desktop.png](after-desktop.png) |
| Mobile 390×844 | [before-mobile.png](before-mobile.png) | [after-mobile.png](after-mobile.png) |

All four images were opened. The only visual difference is the six appended
answer links; section order, headings, spacing and the existing recovery
guide link are unchanged. The Hono quality gates (a11y, Lighthouse, visual
specs) do not exercise the SvelteKit route; the Kit FAQ renders the same
content source and is covered by the FAQ parity suites.
