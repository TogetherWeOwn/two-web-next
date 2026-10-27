# 2026-10-27 decision: profile unsaved-change review Kit capacity after main moved

Second measured-budget allocation for the Kit cost of the profile slice
that lets a member review unsaved profile differences before saving. The
first allocation (`2026-10-26-profile-review-client-gzip.md`) was sized
against an older main; main has since consumed that headroom, so the exact
reviewed feature head now fails `node ci/check-kit-perf.mjs` in CI. This
decision was re-measured on main `d9b213141` after earlier measurements
(`ba58281d2`, `3baeb3793`) went stale.

## Ceilings

- `server.js.maxGzipBytes` 335872 -> 336640 (three 256B steps, 146B margin;
  lower 336384 rejects by 110B).
- `client.js.maxRawBytes` 257024 -> 257536 (one 512B step, 511B margin;
  lower 257024 rejects by 1B).
- `client.js.maxGzipBytes` 103168 -> 103680 (two 256B steps, 305B margin;
  one step, 103424, would leave 49B, less than the renaming churn a moving
  main adds to the client gzip).
- Every other ceiling is unchanged. No ceiling moves by x1.25 or more.

## Measurements

Locked Node production builds (`npm run build --prefix web`), measured
through `node ci/check-kit-perf.mjs --format json`, on the profile feature
head (#1834, `f594991f8`) merged with main `d9b213141` (conflicts only in
`README.md` and `ci/a11y-native-browser-suites.test.mjs`; no bundle inputs).

| Tree | Server gzip | Client raw | Client gzip |
|---|---:|---:|---:|
| Combined build 1 | 336494 | 257025 | 103375 |
| Combined build 2 | 336494 | 257025 | 103375 |
| Slice delta over its first measurement (pristine `ba58281d2`) | +846 | +1907 | +711 |

An independent review build of main `3baeb3793` merged with the feature
measured server gzip 336495 / 336493 and client 257025 / 103375, matching
these figures. The current ceilings reject the combined tree by 622B server
gzip, 1B client raw and 207B client gzip.

## Attribution

Main moved after the first allocation and again after this one was first
proposed (335360 -> 335872 server gzip, client raw 256000 -> 257024 in
#1895), consuming the earlier sizing. The slice itself is unchanged (client
raw delta +1907 in every measurement). The growth is the `ProfileView`
review markup and the shared row helper `src/profiles/composition.ts`,
which ships to both the Kit server bundle and the client; no new files and
no new dependency.

## Shipping tests

`ci/check-kit-perf.test.mjs` gains the 336640 rung in
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval = measured worst 336494, exact
336640, one over 336641), moves the client raw and gzip literals to the new
ceilings (interval 257025 / 103375, exact 257536 / 103680, one over 257537 /
103681) and adds an unconditional case that the measured 336494-byte server
tree fits, so reverting only the server fragment fails closed.
`ci/budget-fragments.test.mjs` moves its client pin and admits the 336640
server rung.

## Scope

Measured bytes only. No checker, gate, mask or exclusion changes; the
feature merges separately and exact-head CI plus independent review stay
mandatory. Undo: revert this allocation before the feature merges.
