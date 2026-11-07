# Profile bidi and invisible-character rule

`containsControlCharacters` (`src/admin/validation-shared.ts`) now refuses
every Default_Ignorable_Code_Point outside the admitted joiners, emoji tag
flags and anchored variation selectors, and `src/profiles/validation.ts`
applies that shared rule to bio and game names instead of its own
Cc-only pattern. The Kit server bundles both validators. No dependency,
asset-count, CSS, client, startup or user-facing speed-target changes.

## Measurements

Exact-head CI measured the composed build (this branch merged with the
RFC 5892 joiner branch over main `161462d2`) at 1226904 raw across 114
files. The joiner branch alone measured 1226469 on the same main, so this
change adds 435 raw. Client JS (250664 raw / 101255 gzip) and the Worker
entry are unchanged.

## Least-cover sizing

- Server raw 1226752 -> 1227264: +512 bytes, 0.042%; margin 360 bytes.
  The lower 1226752 step rejects by 152. Main moving to `21a17861`
  (+117 server bytes) still fits.
- Server gzip stays at 342272. The composed build measures 342346 gzip,
  which warns and does not gate under
  `2026-11-04-server-gzip-runtime-boundary.md`, so this PR does not raise
  that ceiling.

The ceiling of record before this stack is main's 1222656; across both
PRs it moves to 1227264 (+4608 bytes, 0.377%). The joiner step is sized
in [2026-11-06-rfc5892-joiner-tables.md](2026-11-06-rfc5892-joiner-tables.md).

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1227264 only from its explicit allocation list and keeps every earlier
allocation. The checker fixtures in `ci/check-kit-perf.test.mjs` pin the
interval, exact and one-over cases for the new ceiling.

Undo: revert this PR, including its fragment change and oracle controls.
