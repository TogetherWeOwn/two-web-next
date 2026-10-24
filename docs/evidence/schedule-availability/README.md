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

## Baseline conflict disposition

The four events-index binary conflicts retain the base branch's images. Neither
prior image set represents the combined availability text plus the newly masked
end-time element. Any intentional difference must be reviewed and accepted from
the combined head's pinned-CI failure artifact using the documented visual accept
commands. No baseline was synthesized locally, no audit was skipped, and no
threshold was increased. See [visual regression](../../visual-regression.md).

Hono accessibility and Lighthouse gates do not exercise Kit routes. Kit browser
coverage above exercises its shared renderer, not a deployed Kit route. This PR
has not been deployed to staging or production by the implementer.
