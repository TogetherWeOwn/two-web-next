# 2026-10-27 decision: schedule print presentation costs

Measured-budget allocation for the slice that makes the already-rendered
`/events` list view and `/events/past` archive readable on paper (scoped
`@media print` block and the print scope stamp styling). One served asset
grows; the raise is the least aligned cover of the measured composition,
not x1.25 bloat.

## public/schedule-theme.css: 6144/1792 -> 9216/2304

- Measured on the feature branch composed with main cd50096f3,
  `npm run budget`: 8779 raw / 2152 gzip bytes (6142 raw before the slice;
  8701 / 2091 before the print block also hid the clear-search links).
- Old ceilings 6144 raw / 1792 gzip. Measured bytes exceed raw by 2635B
  and gzip by 360B.
- New ceilings 9216 raw / 2304 gzip: raw is six 512B steps over the old
  ceiling (437B margin); gzip is two 256B steps over it (152B margin). Far
  below x1.25 (10763/2600).
- Why: the print block hides search, navigation, subscription and sign-in
  controls (including the search-miss and archive "Clear search" links), turns the dark card chrome into high-contrast rows with kept-
  together cards and visible overflow, and reveals the screen-hidden scope
  stamp. Every selector is scoped to the list-view and archive roots, so
  the calendar grid and the member board print as before.

## Scope

This allocation carries measured bytes only; it does not approve the
feature, which merges separately. No checker, gate, or exclusion changes:
over-ceiling fixtures still fail closed through the unchanged checkers,
and `SHIPPING_BUNDLE_BUDGETS` in `ci/budget-fragments.test.mjs` plus the
raw pin in `test/page-shells.test.ts` (`< 9216`) move with the fragment.
Undo: revert this allocation before the feature merges.
