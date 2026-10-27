# 2026-10-26 decision: profile unsaved-change review Kit client gzip

Measured-budget allocation for the Kit client cost of the profile
slice that lets a member review unsaved profile differences before
saving. Only the client gzip ceiling moves; raw already fits.

## client.js: gzip 102912 -> 103168 (raw unchanged at 256000)

- Measured on the feature branch composed with main a902d670f
  (`npm run build --prefix web`, then `node ci/check-kit-perf.mjs`):
  client JS 255856 raw / 102979 gzip bytes.
- Raw 255856 fits the current 256000 ceiling (144B margin; the ceiling
  reached 256000 on main via the admin-review allocation, ported
  through the fragment split). No raw change here.
- Old gzip ceiling 102912; measured exceeds it by 67B.
- New gzip ceiling 103168: one 256B step (189B margin). Far below x1.25.
- Why: the same review-dialog slice ships shared client code; the
  delta is review behavior, not a new dependency. Server gzip fits the
  current 335104 ceiling (measured 334906, 198B margin) and stays
  untouched, as do worker, CSS, file-count, and startup limits.
- Paired pins in `ci/check-kit-perf.test.mjs`: the client gzip
  exact/one-byte-over cases move to 103168/103169, and the client raw
  newly-allowed-interval input becomes the measured 255856. A revert
  rejects the interval; a further widening fails the one-over cases.

## Scope

This allocation carries measured bytes only; it does not approve the
feature, which merges separately. No checker, gate, or exclusion
changes: over-ceiling fixtures still fail closed, and
`SHIPPING_KIT_BUDGET` in `ci/budget-fragments.test.mjs` moves with the
fragment. Undo: revert this allocation before the feature merges.
