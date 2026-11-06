# Logo/Icon 1 brand swap evidence

## Design contract

- **Audience and screen job:** guests and members on the dark UI; the header
  lockup is the site identity on every page.
- **Primary action:** unchanged — nav links and the Discord sign-in/join action
  keep their placement and behavior.
- **References:** the owner-supplied Logo 1 lockup and Icon 1 mark (gradient
  ramp ember `#ff9c36` → magenta `#ff0e52` → violet `#5701ae`, top to bottom),
  and the dark-background artwork variant for dark UI.
- **Layout, typography and tokens:** the lockup keeps the existing centered
  header slot at its intrinsic 180×50 aspect (explicit `width`/`height`, no
  layout shift). Brand colors enter through the semantic token layer
  (`--color-brand-ember/magenta/violet` in `public/theme-tokens.css`); no raw
  hex in components. The gradient stops ship baked in the artwork, so no
  gradient token was added.
- **Responsive behavior:** keep the existing header grid, padding and account
  chrome. Above 30rem, show the full 180×50 lockup. At or below 30rem, crop its
  leftmost 50×50 Icon 1 mark with `object-fit: cover` and left alignment; retain
  the intrinsic image attributes and accessible name. This is the UX-reviewed
  correction for wrapped guest buttons and clipped member names.
- **Required states:** guest renders of `/`, `/about`, `/join` at desktop and
  mobile; the 1200×630 share card; the SVG favicon; the 192/512/maskable-512
  icons; the Apple touch icon; the web manifest.
- **Non-goals:** a new visual direction beyond the owner artwork; a light-theme
  lockup variant; data, auth, or route-flag changes; threshold relaxation or
  wholesale baseline regeneration. Changed Kit chrome needs its own evidence;
  intentional baseline replacements require exact-attempt visual review.

## Captures

All twelve images were opened for visual inspection. The viewport is 1280×800
for desktop and 390×844 for mobile. The only intended visual change is the
header lockup: the "TWO" text placeholder becomes the Logo 1 mark plus
"TOGETHER WE OWN" wordmark. The lockup uses the existing centered desktop slot
and top-left mobile slot. The original inspection reported no horizontal
overflow at these two widths; it did not verify 360px. These captures are not
pixel-identical outside the header: mobile text and downstream positions also
differ. They show the artwork swap, not proof of unchanged page geometry.
Pinned-runner visual comparisons and the narrow-screen review determine which
layout differences are acceptable. The table below predates the narrow-screen
correction: its mobile after-images are historical, not the corrected after-state.
They must be replaced with reviewed post-fix captures before merge.

| Page / viewport | Before | Historical after |
| --- | --- | --- |
| Home / desktop | [Before](before-home-desktop.png) | [After](after-home-desktop.png) |
| Home / mobile | [Before](before-home-mobile.png) | [After](after-home-mobile.png) |
| About / desktop | [Before](before-about-desktop.png) | [After](after-about-desktop.png) |
| About / mobile | [Before](before-about-mobile.png) | [After](after-about-mobile.png) |
| Join / desktop | [Before](before-join-desktop.png) | [After](after-join-desktop.png) |
| Join / mobile | [Before](before-join-mobile.png) | [After](after-join-mobile.png) |

## Fixture and coverage boundaries

These are real **static-rig** captures, not deployed-page observations. Guest
HTML for `/`, `/about`, and `/join` is pre-rendered through the same page-shell
pipeline the tests use, served alongside the repo `public/` assets (the real
`logo.svg`, theme stylesheets, and local fonts); Chromium screenshots each
route with off-origin requests aborted. No database, Discord, bot, or staging
traffic supplies these screenshots.

Historical targeted Hono a11y and Lighthouse runs passed (24/24 LHRs each,
exit 0), as recorded by the original implementation on 2026-11-03. These are
not current-head CI results. On head `678de6f6`, the [a11y job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42294753174/job/128157093522)
and [Lighthouse job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42294753174/job/128157093714)
both passed. They exercise Hono, not Kit.

The original twelve captures do not exercise Kit. The exact-head
[browser-smoke failure](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42294753053/job/128157032840)
contains real Hono and Kit expected/actual/diff images in artifact
`e2e-failure-42294753053-1`. The UX review found the 16 desktop changes confined
to the logo box, but rejected all 16 mobile actuals: eight show wrapped actions
or overly clipped names, and the others are superseded by the same responsive
correction. None has been accepted into the baseline set. Fresh post-fix
artifacts must be reviewed before either acceptance script runs.

`e2e/kit-parity/parity.spec.ts` now captures guest and signed-in header states
at 360, 390, 768 and 1280px in the existing GitHub Actions fixture stack. These
are screenshot outputs in `test-results-kit-parity/`, not new golden baselines.
The added assertions require no page overflow, one-line guest actions, the full
fixture member name and the approved logo dimensions. The assertions and
captures are not yet executed. They avoid a duplicate local app build on the
shared host while exercising the real renderers against disposable fixtures.
Required Kit publication remains guest `kit-events-index-{desktop,mobile}` and
signed-in `member-board-default-{desktop,mobile}` from the post-fix artifact;
Hono captures never substitute for them.

Icon and manifest coverage is by file, not screenshot: `favicon.svg`,
`public/icons/icon-192.png` (192×192), `icon-512.png` (512×512),
`maskable-512.png` (512×512), and `apple-touch-icon.png` (180×180) were
dimension-checked, and `site.webmanifest` lists the SVG first. The share card
`public/og-1200x630.png` is a single-lockup recomposition verified at exactly
1200×630 RGB; no test pins its bytes.

No visual baseline was changed or accepted. The token stylesheet fits the
unchanged 1536 B raw / 512 B gzip bundle budget; the unnecessary proposed
raw-budget increase was removed before review.

Historical boundary (2026-11-03, `d9bb71c6`): the homepage LCP ratchets
(`test/homepage-mobile-lcp-acceptance.test.ts`) measured 24950 B HTML
(> 24800) and 18860 B inlined CSS (> 18850) against that branch's original
thresholds. The token lines keep standard Biome formatting. The ratchet
reconciliation subsequently merged separately in PR #2031; these historical
failures are not a reason to wait for that already-merged PR. Current merge
verification belongs to the exact-head GitHub Actions runs linked in the
pull request, including browser-smoke, a11y and Lighthouse. This evidence
record does not claim those later runs passed.
