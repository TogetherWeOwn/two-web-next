# Optional dashboard diagnostics: state and native-link evidence

## Design contract

Audience: admitted human moderators. The screen distinguishes recorded diagnostic
results from unavailable reads. Its primary diagnostic action opens the existing
read-only join-attempt list at page 1 for the exact recorded outcome.

References are the existing [Hono dashboard](../../../src/admin/pages/dashboard.tsx),
[Kit dashboard](../../../web/src/routes/admin/+page.svelte) and
[moderator guide](../../moderator-admin-guide.md#dashboard). Reuse their four
resource cards, heading hierarchy, typography, native links, semantic tables,
focusable scroll regions and existing tokens. Reject only omitted failures and
unqualified search-demand copy. No new visual direction, chart or palette.

Both headings remain present for populated, successful-empty and unavailable
reads. Explain the recorded join-attempt retention window and cache lag without
inventing a sampling instant. Missed searches are recorded planning hints, not
all searches, proof of demand or searcher identity; no search-retention claim.
Keep unknown recorded strings escaped, with canonical native drill-down links.

At 1280×800 and 390×844, preserve card wrapping, readable paragraphs and
container-owned table scrolling. No new reads, refresh, mutation, telemetry,
framework, query/cache changes, authentication changes or allowance relaxation.

## Captures opened

All actors, outcomes and queries are synthetic. These are full-page screenshots
at the named viewport sizes, not new screenshot-regression baselines.
Before is the unchanged product tree at `2540adb21`; the independent acceptance
fixtures were already present. After renders both real dashboard components.
Kit includes its actual built root CSS plus renderer-matched component CSS for
focus evidence. No deployed origin, database or external request is involved.

| Renderer | Desktop populated before / after | Mobile populated before / after |
| --- | --- | --- |
| Hono | [Before](before-hono-populated-populated-1280.png) / [After](after-hono-populated-populated-1280.png) | [Before](before-hono-populated-populated-390.png) / [After](after-hono-populated-populated-390.png) |
| Kit | [Before](before-kit-populated-populated-1280.png) / [After](after-kit-populated-populated-1280.png) | [Before](before-kit-populated-populated-390.png) / [After](after-kit-populated-populated-390.png) |

| Renderer/state | Desktop | Mobile |
| --- | --- | --- |
| Hono unavailable before | [Open](before-hono-unavailable-unavailable-1280.png) | [Open](before-hono-unavailable-unavailable-390.png) |
| Kit unavailable before | [Open](before-kit-unavailable-unavailable-1280.png) | [Open](before-kit-unavailable-unavailable-390.png) |
| Hono empty | [Open](after-hono-empty-empty-1280.png) | [Open](after-hono-empty-empty-390.png) |
| Kit empty | [Open](after-kit-empty-empty-1280.png) | [Open](after-kit-empty-empty-390.png) |
| Hono unavailable | [Open](after-hono-unavailable-unavailable-1280.png) | [Open](after-hono-unavailable-unavailable-390.png) |
| Kit unavailable | [Open](after-kit-unavailable-unavailable-1280.png) | [Open](after-kit-unavailable-unavailable-390.png) |
| Hono funnel populated/search unavailable | [Open](after-hono-populated-unavailable-1280.png) | [Open](after-hono-populated-unavailable-390.png) |
| Kit funnel populated/search unavailable | [Open](after-kit-populated-unavailable-1280.png) | [Open](after-kit-populated-unavailable-390.png) |
| Hono funnel unavailable/search populated | [Open](after-hono-unavailable-populated-1280.png) | [Open](after-hono-unavailable-populated-390.png) |
| Kit funnel unavailable/search populated | [Open](after-kit-unavailable-populated-1280.png) | [Open](after-kit-unavailable-populated-390.png) |
| Hono keyboard focus, no JavaScript | [Open](focus-hono-populated-unavailable-1280.png) | [Open](focus-hono-populated-unavailable-390.png) |
| Kit keyboard focus, no JavaScript | [Open](focus-kit-populated-unavailable-1280.png) | [Open](focus-kit-populated-unavailable-390.png) |

## Visual critique and disposition

- Both headings remain; unavailable copy is not empty success. A successful peer
  still shows its table. No empty table/scroll shell appears in empty states.
- Existing cards, spacing and heading hierarchy remain. Provenance paragraphs
  add necessary vertical space; no text/column overlap or whole-document
  horizontal overflow was observed at either width.
- Unknown outcome text wraps without becoming markup. Its underline makes the
  drill-down discoverable without color alone.
- Keyboard inspection found the new Kit links inherited a nearly invisible dark
  outline. The existing dashboard-scoped `currentColor` focus rule now also
  covers diagnostic table links. Reopened both widths: the outline is 3px and
  matches their visible foreground. Shared Hono styling is unchanged.
- **Existing limitation:** Kit's dark root canvas conflicts with legacy admin
  brand/card/footer colors, visible before and after and already documented in
  [the preceding dashboard evidence](../admin-dashboard/README.md#visual-critique-and-disposition).
  This slice does not repair that separate theme issue or certify the whole Kit
  shell's contrast.
- An initial focus capture used built component CSS with a different SSR hash.
  Final focus images use CSS emitted by the same Svelte compiler/filename as
  their rendered component. Root CSS is included throughout; no screenshot-only
  visual override was added.

## Verification boundaries

The acceptance helper renders the real Hono component and compiles the real Kit
page/AdminShell. This is local component SSR evidence, not deployed route/load,
hydration or protected-viewer integration proof.

`e2e/admin-diagnostics-native.spec.ts` passed all four Hono/Kit, desktop/mobile
cases using an isolated local-fixture Playwright config: Tab reaches the unknown
outcome; Enter performs ordinary document navigation; the real query parser
returns the exact outcome and page 1. Every other request is blocked. Its inert
navigation receipt does not claim to render the protected destination viewer.

The 47 new Vitest checks initially had 28 expected assertion failures and 19
passes. After the behavior change, 46 passed: the remaining assertion exposed
a test HTML parser that stopped at `>` inside a valid quoted Svelte attribute.
Chromium confirmed the complete descriptive label on both twins at both widths.
The broader focused run initially had 343 passes, 13 failures and no skips;
twelve failures were obsolete omission/empty-copy expectations. A separately
authored test-only correction updates those pins and makes attribute observation
quote-aware, without changing the substantive unknown-value assertions. The
correction was consumed unchanged and the exact ten-suite command rerun:
**356 passed, zero failures, zero skips**, including all 47 new checks. This is
focused local verification, not a full-suite or final release verdict.

Executed successfully: root typecheck and lint; Kit warning-enforcing check and
build; `npm run kit-perf`; four native keyboard/no-JS cases; `npm run a11y`
(146 Hono fixture scans, zero failures). Hono accessibility/Lighthouse/committed
visual gates do not exercise the Kit-only route; the Kit screenshots above are
separate evidence.

Local `npm run lighthouse` and `npm run lighthouse:quality` first lacked automatic
Chrome discovery. With the installed browser selected explicitly, both stopped
because the fixed local fixture port was occupied; no Lighthouse score is
claimed. The pinned visual comparisons belong to the CI runner, not this local
font environment. No baseline, mask or threshold was changed. Full repository
check, exact-head CI, independent review, merge and release remain separate
gates, recorded in the pull request as their results become available.
