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
- **Responsive behavior:** preserve the existing desktop header and the stacked
  mobile header; the lockup scales with the same slot at both widths.
- **Required states:** guest renders of `/`, `/about`, `/join` at desktop and
  mobile; the 1200×630 share card; the SVG favicon; the 192/512/maskable-512
  icons; the Apple touch icon; the web manifest.
- **Non-goals:** a new visual direction beyond the owner artwork; a light-theme
  lockup variant; Kit route screenshots; data, auth, or route-flag changes; any
  threshold or baseline change.

## Captures

All twelve images were opened for visual inspection. The viewport is 1280×800
for desktop and 390×844 for mobile. The only intended visual change is the
header lockup: the "TWO" text placeholder becomes the Logo 1 mark plus
"TOGETHER WE OWN" wordmark. Header geometry is unchanged — the lockup occupies
the same centered slot (top-left, stacked, on mobile) — and no page shows
horizontal overflow at either width. Body copy, nav, buttons, and footers are
pixel-identical between each before/after pair.

| Page / viewport | Before | After |
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

The Hono a11y gate and both Lighthouse gates pass (24/24 LHRs each, exit 0);
their commands and results are reported in the pull request. The Kit header
shares the same `logo.svg` via copy-public but no Kit route was screenshotted:
the Hono gates do not exercise the Kit route.

Icon and manifest coverage is by file, not screenshot: `favicon.svg`,
`public/icons/icon-192.png` (192×192), `icon-512.png` (512×512),
`maskable-512.png` (512×512), and `apple-touch-icon.png` (180×180) were
dimension-checked, and `site.webmanifest` lists the SVG first. The share card
`public/og-1200x630.png` is a single-lockup recomposition verified at exactly
1200×630 RGB; no test pins its bytes.

No visual baseline was changed or accepted, and no threshold was relaxed. Known
boundary: the homepage HTML LCP ratchet
(`test/homepage-mobile-lcp-acceptance.test.ts`, 24800 B) measures 24939 B on
this head — the +145 B brand delta is fully itemized and irreducible — while
the inline-CSS ratchet passes (18849 ≤ 18850). That reconciliation belongs to
the paired LCP card and is flagged in the pull request, not absorbed here.
