# 2026-10-26 decision: profile unsaved-change review bundle costs

Measured-budget allocation for the profile slice that lets a member
review unsaved profile differences before saving (changed-field list,
confirm/discard actions, error and responsive states). Two served
assets grow; both raises are the least aligned cover of the measured
feature composition, not x1.25 bloat.

## public/islands/member-profile.js: 14336/5120 -> 15872/5632

- Measured on the feature branch composed with main a902d670f,
  `npm run budget`: 15634 raw / 5440 gzip bytes.
- Old ceilings 14336 raw / 5120 gzip (current fragment values; the raw
  ceiling moved 13824 -> 14336 on main after the measurement base).
  Measured bytes exceed raw by 1298B and gzip by 320B.
- New ceilings 15872 raw / 5632 gzip: raw is four 512B steps over the
  13824 measurement-base ceiling (238B margin); gzip is two 256B steps
  over 5120 (192B margin). Far below x1.25 (19543/6800).
- Why: the island carries the review-dialog behavior (dirty-field
  diffing, review list rendering, confirm/discard wiring, focus and
  error states). No other island changes in this slice.

## public/profile-theme.css: 8192 -> 8704 raw (gzip unchanged)

- Measured on the same composition: 8352 raw bytes; gzip still fits
  the 2048 ceiling.
- Old ceiling 8192 raw; measured exceeds it by 160B.
- New ceiling 8704 raw: one 512B step (352B margin). Gzip stays 2048.
- Why: review-dialog and notice styling for the same slice, including
  the responsive rules the shipped pin requires.
- Paired pin: `test/profile-theme.test.ts` `css.length < 8000` moves to
  `< 8500` with this ceiling; it still fails closed above the new raw
  ceiling (8704 > 8500 keeps the pin tighter than the budget).

## Scope

This allocation carries measured bytes only; it does not approve the
feature, which merges separately. No checker, gate, or exclusion
changes: over-ceiling fixtures still fail closed through the unchanged
checkers, and `SHIPPING_BUNDLE_BUDGETS` in
`ci/budget-fragments.test.mjs` moves with the fragments. Undo: revert
this allocation before the feature merges.
