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
Kit signed-in 360/768px captures are missing from this historical attempt:
the new capture's cookie setup failed before member navigation. The existing
Kit member-board visual journey supplies signed-in 390/1280px evidence.
The corrected setup subsequently passed on `b738e122`, but that successful
run retained no images. Run 42310900115 now supplies all four widths for both
renderers, including Kit member 360/768, as recorded below.

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

## Retained four-width captures and Actions checkpoint

At head `a513f5ae8e6f0bc70714f3a5f582c9d1400529c6`,
[browser-smoke](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900115/job/128211868039)
passed: 17 Kit visuals, 17 Hono visuals, 452 critical journeys, 79 parity tests
(zero failed/skipped), and two authenticated performance checks.
[e2e-ok](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900115/job/128215177032)
passed. The pinned uploader retained all 28 expected PNGs in
[artifact 13548672752](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900115/artifacts/13548672752),
`brand-header-captures-42310900115-1`. The downloaded archive SHA256 matched
the upload log. [The retained-capture manifest](retained-captures.json) records
every source path, dimension and SHA256. All 28 original images were opened by
the implementation author and published together in the task's downloadable
PNG-only evidence bundle with this provenance. This is not final independent
UX review or production approval.

Coverage: Hono guest home/about/join/events and member leaderboard, plus Kit
guest events and member leaderboard, each at 360/390/768/1280px. These are
viewport screenshots: 844px high at 360/390/768 and 800px at 1280, unlike the
older full-page Kit captures above. The missing Kit member 360/768 evidence
is now retrieved, opened and published. No baseline changed in this step.

Same-head [a11y](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900133/job/128211882638),
[Lighthouse](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900133/job/128211882587),
bundle budget, [PR lint/gitleaks](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310956016),
CodeQL and Devin succeeded. CodeRabbit completed with no new actionable
comment. Hono audits do not exercise Kit.
[Check](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900133/job/128211882597)
and [Node 22](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42310900133/job/128211882586)
failed on one Biome formatting difference in
`test/brand-header-evidence-contract.test.ts`, before typecheck or unit tests.
The missing Kit admin contrast upload was downstream of the early failure.
`ci-ok` failed; the admin icon correction has no passing unit-suite evidence
yet. Applied only the exact formatter-requested single-line assertion layout;
its meaning is unchanged. This correction and evidence update require fresh
exact-head Actions; no full-suite pass is claimed.

## Earlier Actions verification checkpoint

At published head `b738e1222938faea196d640a38dbd4422cb3c4d3`,
[browser-smoke](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304037907/job/128188837937)
passed: 17 Kit visual tests, 17 Hono visual tests, 452 critical browser
journeys, 79 parity tests (zero failed or skipped) and two authenticated
performance checks. Both renderers' guest/member header tests passed at all
four widths. The [e2e aggregate](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304037907/job/128192283898)
also passed. The artifact listing was empty: successful execution proves the
assertions, not that any screenshot was retrieved or visually reviewed.
The later PNG-retention run above closes that screenshot-publication gap.

The same head's [a11y](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304038201/job/128188850887),
[Lighthouse](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304038201/job/128188850735),
[bundle budget](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304038201/job/128188850906),
[gitleaks](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304375498/job/128190100037)
and [PR lint](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304375498/job/128189881940)
passed. CodeQL and Devin completed successfully, with no new findings at this
checkpoint. Hono audits still do not exercise Kit.
[Full check](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304038201/job/128188851020)
and [Node 22 compatibility](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42304038201/job/128188850755)
finished with failures at 22:57 and 22:58 UTC on 2026-11-06. Each suite
reported 18 failed, 26042 passed and 676 skipped tests across 1 failed,
1237 passed and 5 skipped files. All 18 failures were in
`test/page-shells.test.ts`, on admin-shell variants; no additional failing
test appeared in either completed log. The `ci-ok` aggregate failed too.
The new shared SVG/PNG/touch assertions exposed the separate admin shell's
missing icon declarations. The correction adds those same three links to
`src/admin/pages/shell.tsx`; no assertion or admin layout is changed.
The existing route inventory covers ordinary, operational and error admin
shells. No local reproduction ran because this isolated worktree has no
installed dependencies; the correction awaits its own Actions run.
No full-suite or `ci-ok` pass is claimed. These are `b738e122` results, not
verification of the later retention or admin-head corrections.

## Fixture and execution boundaries

`e2e/kit-parity/parity.spec.ts` captures guest and signed-in headers at 360,
390, 768 and 1280px against the existing disposable Actions fixture stack.
Screenshot outputs live in `test-results-kit-parity/`, not new golden baselines.
The assertions require no page overflow, one-line guest actions, the full
fixture member name and the approved logo dimensions. Only disposable seeded
rows and stubbed integrations supply these images; no live Discord, bot,
staging or production data is used.

The workflow retains `test-results-kit-parity/**/brand-*.png` in the separate
`brand-header-captures-<run>-<attempt>` artifact on success as well as failure.
This narrowly scoped upload contains PNGs only, not traces, cookie storage or
environment files. The existing failure report is unchanged. Missing files are
ignored because earlier setup may fail before captures run; the presence and
completeness of the expected images must still be checked, never inferred
from a successful upload step. `test/brand-header-evidence-contract.test.ts`
pins the upload condition, scope and existing action SHA. The actual upload
executed successfully on `a513f5ae`; the regression test's formatter correction
still requires its own next-head Actions execution.

On `c2c105ce`, the Hono multi-width assertions passed. All twenty Hono guest
home/about/join/events and member-board captures plus four Kit guest events
captures executed. Kit member capture failed because its setup derived a
secure `__Host-` cookie from the HTTP fixture URL. A repeated-worker RSVP
teardown also reported 429. The capture setup now preserves the issued cookie
attributes, like the existing member-board visual journey, and initializes
Hono's jar even when run alone. Both corrected header tests and the browser
gate passed on `b738e122`, as recorded above; this does not close the separate
screenshot-publication gap or establish a final-head full CI pass.

The same head's [check](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290283)
and [Node 22 compatibility](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42299178568/job/128172290299)
jobs failed typecheck on global URL versus Node URL types. The token test now
imports `URL` from `node:url`; both `b738e122` jobs passed typecheck before
the admin-shell unit failures recorded above.
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
