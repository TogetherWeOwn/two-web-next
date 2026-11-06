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
  mobile; Hono and Kit guest/member headers; the 1200×630 share card; SVG
  favicon; 192/512/maskable-512 icons; Apple touch icon; web manifest.
- **Non-goals:** a new visual direction beyond the owner artwork; a light-theme
  lockup variant; application data, auth, or route-flag changes; threshold
  relaxation or wholesale baseline regeneration.

## Corrected captures

Source: [browser-smoke run 42299178227, attempt 1](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178227/job/128172290149),
head `c2c105ced54a43d92222a866ecb0b20830ce4610`, artifact
`e2e-failure-42299178227-1` (artifact ID 13542999803). These real application
captures use the existing Actions fixture stack, not a separately built mock.
All ten corrected images linked below were opened by the implementation author.
Independent UX review opened all 32 expected/actual/diff triplets and all 24
multi-width captures from this attempt before approving the named replacements.

Viewport: desktop 1280×800, mobile 390×844. The six Hono after-images capture
that viewport; Kit images are full-page captures at those viewport sizes, so
image height exceeds viewport height. Source paths, dimensions and SHA256
values are recorded in [the capture manifest](corrected-captures.json).

### Hono before/after

Before-images are retained historical static-rig captures of the placeholder.
After-images below come from the corrected real fixture stack. Different
capture rigs mean these pairs illustrate the brand change, not pixel parity;
use the same-attempt visual comparisons for geometry evidence.

| Page / viewport | Before | Corrected after |
| --- | --- | --- |
| Home / desktop | [Before](before-home-desktop.png) | [After](corrected-hono-home-desktop.png) |
| Home / mobile | [Before](before-home-mobile.png) | [After](corrected-hono-home-mobile.png) |
| About / desktop | [Before](before-about-desktop.png) | [After](corrected-hono-about-desktop.png) |
| About / mobile | [Before](before-about-mobile.png) | [After](corrected-hono-about-mobile.png) |
| Join / desktop | [Before](before-join-desktop.png) | [After](corrected-hono-join-desktop.png) |
| Join / mobile | [Before](before-join-mobile.png) | [After](corrected-hono-join-mobile.png) |

The original `after-*.png` files remain historical pre-crop evidence, not the
current after-state. No actual from run 42294753053 is accepted.

### Kit guest/member

| State / route | Desktop | Mobile |
| --- | --- | --- |
| Guest / `/events` | [After](corrected-kit-guest-desktop.png) | [After](corrected-kit-guest-mobile.png) |
| QA Member / `/leaderboards/members` | [After](corrected-kit-member-desktop.png) | [After](corrected-kit-member-mobile.png) |

The same-attempt Kit expected images in the failure artifact provide the
placeholder before-state. Hono captures do not substitute for Kit evidence.
Kit signed-in 360/768px captures are still missing from this attempt: the new
capture's cookie setup failed before member navigation. The existing Kit
member-board visual journey supplies signed-in 390/1280px evidence. A shared
stylesheet suggests similar narrower behavior, but that is not capture proof.
The corrected setup must execute and publish the remaining widths on rerun.

## Named intentional baseline acceptance

Independent UX approved exactly 32 replacements from run 42299178227 attempt 1:

| Suite | Names (each at desktop and mobile) | Count |
| --- | --- | --- |
| Hono | `home`, `events`, `event`, `past`, `about`, `rules`, `privacy`, `event-paused`, `event-cancelled` | 18 |
| Kit | `kit-events-index`, `kit-archive-populated`, `kit-archive-out-of-range`, `member-board-default`, `member-board-relative`, `member-board-season`, `member-board-activity` | 14 |

UX found all 16 desktop changes confined to the logo slot, with pixel-identical
bodies. Six mobile pages shorten by 14px (64px placeholder → 50px mark); their
bodies match after removing that offset. The other ten shorten by 1–2px and
re-render text edges without changed wrapping or component geometry. Guest
header actions stay on one line; QA Member and Sign out remain visible. The
mark-only crop shows no wordmark sliver. Any later header rendering change
requires fresh design review; typecheck and cookie-harness fixes do not change
rendering.

Applied only the approved names with the supported scripts, after dry-run
plans matched the ledger exactly:

```sh
node ci/visual-accept.mjs --dry-run --format json <reviewed-artifact-root>
node ci/kit-visual-accept.mjs --dry-run --format json <reviewed-artifact-root>
node ci/visual-accept.mjs <reviewed-artifact-root>
node ci/kit-visual-accept.mjs <reviewed-artifact-root>
```

Results: 18 Hono and 14 Kit baselines accepted. Unrelated Kit viewer images
were unchanged. No threshold, mask, test skip or asset budget was loosened.
Acceptance is intentional-diff evidence, not a passing browser gate; the final
exact head must still pass Actions.

## Fixture and execution boundaries

`e2e/kit-parity/parity.spec.ts` captures guest and signed-in headers at 360,
390, 768 and 1280px against the existing disposable Actions fixture stack.
Screenshot outputs live in `test-results-kit-parity/`, not new golden baselines.
The assertions require no page overflow, one-line guest actions, the full
fixture member name and the approved logo dimensions. Only disposable seeded
rows and stubbed integrations supply these images; no live Discord, bot,
staging or production data is used.

On `c2c105ce`, the Hono multi-width assertions passed. All twenty Hono guest
home/about/join/events and member-board captures plus four Kit guest events
captures executed. Kit member capture failed because its setup derived a
secure `__Host-` cookie from the HTTP fixture URL. A repeated-worker RSVP
teardown also reported 429. The capture setup now preserves the issued cookie
attributes, like the existing member-board visual journey, and initializes
Hono's jar even when run alone. The harness correction remains unverified
until the next Actions run; no green browser gate is claimed.

The same head's [check](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290283)
and [Node 22 compatibility](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290299)
jobs failed typecheck on global URL versus Node URL types. The token test now
imports `URL` from `node:url`; the next Actions run must verify it.
[Hono a11y](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290320)
and [Lighthouse](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290325)
passed on that head. Neither exercises Kit. Historical targeted Hono audits
from 2026-11-03 are not current-head evidence.

Icon and manifest coverage is by file, not screenshot: `favicon.svg`,
`public/icons/icon-192.png` (192×192), `icon-512.png` (512×512),
`maskable-512.png` (512×512), and `apple-touch-icon.png` (180×180) were
dimension-checked, and `site.webmanifest` lists the SVG first. The share card
`public/og-1200x630.png` is a single-lockup recomposition verified at exactly
1200×630 RGB; no test pins its bytes. The token stylesheet fits the unchanged
1536 B raw / 512 B gzip bundle budget.

Historical boundary (2026-11-03, `d9bb71c6`): homepage LCP ratchets measured
24950 B HTML (>24800) and 18860 B inlined CSS (>18850). Ratchet reconciliation
merged separately in PR #2031; it is not a live prerequisite. Current merge
verification belongs to exact-head Actions run/job links in the PR. No local
full suite, app build, staging verification, merge or production deployment
was performed for this acceptance step. Post-merge staging/e2e/soak and
exact-head Release Manager approval remain separate release gates.
