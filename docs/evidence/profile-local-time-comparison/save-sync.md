# Saved timezone synchronization

## Design contract addendum

The existing audience, action, layout, tokens, and no-JS fallback are unchanged.
An accepted owner save advances the comparison's saved timezone. A changed or
cleared timezone removes the obsolete comparison without computing or announcing
a replacement. The member explicitly activates **Compare local times** again.
Adding a first valid timezone enables that action without a reload. An unchanged
saved timezone preserves the frozen result. Unsaved and newer pending drafts are
not comparison inputs.

References: the existing owner `accepted()` path in
[`member-profile.js`](../../../assets/islands/member-profile.js), the shared
[`local-time-compare.js`](../../../assets/islands/local-time-compare.js), and the
[separate editor helper contract](../../profile-timezone-helper.md). No new
visual direction or server-side projection is introduced.

## Before and after

Captured real Hono and executed Kit routes through the existing local profile
fixtures, with intercepted assets and writes, no live database or deployment.
Each image below was opened for visual inspection. These are scrolled viewport
captures, not whole-page images. External fonts and avatar requests are blocked;
font fallbacks remain visible. The twins retain their existing distinct themes.

At the fixed instant `2026-07-15T19:00:00.000Z`, save `Asia/Tokyo` over
`Europe/London`. Before the fix, the visible timezone and store show Tokyo but
the requested comparison still says London, 15 July at 20:00. After the fix,
activation says Tokyo, 16 July at 04:00; device time remains New York, 15 July
at 15:00. Clearing the timezone hides the action and removes the old result.

| Route / viewport | Before save-sync fix | Saved Tokyo, then activated | Cleared timezone |
| --- | --- | --- | --- |
| Hono 390×844 | [before](before-save-sync-hono-390.png) | [saved](saved-hono-390.png) | [cleared](cleared-hono-390.png) |
| Hono 1280×800 | [before](before-save-sync-hono-1280.png) | [saved](saved-hono-1280.png) | [cleared](cleared-hono-1280.png) |
| Kit 390×844 | [before](before-save-sync-kit-390.png) | [saved](saved-kit-390.png) | [cleared](cleared-kit-390.png) |
| Kit 1280×800 | [before](before-save-sync-kit-1280.png) | [saved](saved-kit-1280.png) | [cleared](cleared-kit-1280.png) |

## Regression proof

- The separate `test/profile-local-time-save.test.ts` reproduces 20 failures on
  the previous head (changed, cleared, and first-zone states across both twins
  and both source/shipped artifacts). The independent acceptance file is untouched.
- All 36 post-save browser cases pass after the fix, with zero skipped. They
  include unchanged-zone saves, invalid draft refusal, loss of Intl during a
  save, and an accepted older save while a newer draft remains in the editor.
- The existing acceptance and editor neighbors pass 349/349, zero skipped;
  the acceptance verifier confirms all 72 required browser cases executed.
- `node --test ci/a11y-native-browser-suites.test.mjs`: 15/15 pass. The new suite
  has its own CI step, JSON report, minimum-36 executed-case verifier, and README
  Browser regressions row.
- Built assets are in sync and fit unchanged ceilings: comparison 1456/1536 raw,
  685/768 gzip; owner editor 13813/13824 raw, 4863/4864 gzip. No budget, threshold,
  baseline, mask, or route-ownership flag changes.

Reproduce the new suite with root and web locked development dependencies plus
Playwright Chromium:

```sh
A11Y_BROWSER_TESTS=true npx vitest run test/profile-local-time-save.test.ts
```

To capture the post-fix saved/cleared images as well, set
`PROFILE_TIME_SAVE_EVIDENCE_DIR=docs/evidence/profile-local-time-comparison`.
The four before images use the previous head's shipped islands without changing
working-tree code. Hono quality gates do not exercise Kit routes; the executed
Kit fixture cases and opened images are the Kit evidence. No staging or
production behavior is claimed here.
