# Schedule availability evidence

The initial `before-*` and `after-*` captures show the availability slice in list
and month views at 1280×800 and 390×844, including no-JavaScript states. The PR
records their original verification commands and the design contract.

## Integration with scannable cards

The `combined-*` captures were taken after integrating the shared calendar card's
native long-description disclosure and overnight end-date labels. They use the
real Hono schedule renderer with local, intercepted fixtures, its public assets,
and JavaScript disabled. Chromium uses local DejaVu system fonts and the shipped
Display font; these are visual evidence, **not pinned-runner baselines**. Every
listed image was opened after capture.

| View | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- |
| List | [Combined list](combined-list-1280.png) | [Combined list](combined-list-390.png) |
| Month | [Combined month](combined-calendar-1280.png) | [Combined month](combined-calendar-390.png) |

Fixtures include capacity 10 / named going 3 / occupancy 8 (`2 seats left`), a
paused overnight row, and a Discord-managed row. The first list card has a long
description, collapsed by the native disclosure. The month retains its existing
horizontally scrollable table on narrow screens.

Both availability and scannable-card browser acceptance suites pass together
(32 cases across Hono/Kit, desktop/mobile, JavaScript on/off, keyboard disclosure,
continuation, and island replacement). The attendance count's existing test hook
retains only its count and legacy Full marker; availability remains an inline
sibling within the same styled attendance run.

## Draft review repair and renewed base conflict

Design-contract extension: moderators scanning an ended draft must retain its
Draft badge and response count, without a misleading Full marker. Future drafts
remain badge-only rather than advertising seats or paused RSVPs. This restores
the pre-existing rule; there is no new action, layout, token or typography change.

The following no-JavaScript captures use the real merged Hono renderer and public
assets. The before bundle substitutes the reviewed card source in memory; the
after bundle uses the restored independent past-context guard. Both use the same
local fixtures and merged assets. All four final images were opened. Body fonts
are this container's browser fallback, not the pinned CI runner's system fonts.

| Width | Before | After |
| --- | --- | --- |
| 1280×800 | [Past draft before](draft-before-1280.png) | [Past draft after](draft-after-1280.png) |
| 390×844 | [Past draft before](draft-before-390.png) | [Past draft after](draft-after-390.png) |

A new owned suite checks finite, uncapped and paused future drafts through both
Hono/Kit list and calendar renderers, with published positive controls. Deleting
the draft guard fails all 12 cases. The separate past-draft-at-capacity pin was
observed failing before the one-line guard repair.

The renewed binary conflict with base `a4cd5d2e3` retains the four newer base
images (including the reordered subscription links), not the older accepted
availability images. No local screenshot is substituted as a baseline. The
combined layout still needs a current pinned-runner failure artifact and review;
the historical acceptance below is not proof for this merged tree. CSS was
compacted without changing its minified declarations to fit the unchanged
6144-byte raw budget after integrating the base's search-highlight rule.

## Historical baseline conflict disposition

The initial binary conflict resolution retained the base images until combined
head `86a4007fc` produced a pinned-runner artifact in
[CI run 40141240688](https://github.com/TogetherWeOwn/two-web-next/actions/runs/40141240688).
That run differed only on the Hono/Kit events-index desktop/mobile images. All
four actuals and all four diffs were opened: availability adds `10 seats left`
and moves the sign-in link; on mobile each of the three cards grows by one line
(the full image grows from 2172 to 2256 pixels). The new end-time mask stays
intact. Hono and Kit actuals are byte-identical at each width.

Accepted only those four reviewed actuals using `ci/visual-accept.mjs` and
`ci/kit-visual-accept.mjs`. Their SHA-256 values are:

- Desktop: `f905b77e81731fadf910df11f5f8f7c042115b6eb840b4dfd3bb37ff562c8d66`
- Mobile: `aea19f98404980ffb44ebd1459f6399382e113506ba2c186c1398141ca1a189b`

The full artifact also carries now-stale copies of unrelated cancelled-detail
baselines from before a newer base merge. The accept tool refused those copies.
The original artifact was preserved, and a separate selection containing only
the four reviewed, byte-verified actuals was accepted. The newer cancelled-detail
images stay unchanged. No baseline was synthesized locally, no audit was skipped,
and no threshold was increased. See [visual regression](../../visual-regression.md).

Hono accessibility and Lighthouse gates do not exercise Kit routes. Kit browser
coverage above exercises its shared renderer, not a deployed Kit route. This PR
has not been deployed to staging or production by the implementer.
