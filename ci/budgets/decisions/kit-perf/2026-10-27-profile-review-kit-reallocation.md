# 2026-10-27 decision: profile unsaved-change review Kit capacity after main moved

Second measured-budget allocation for the Kit cost of the profile slice
that lets a member review unsaved profile differences before saving. The
first allocation (`2026-10-26-profile-review-client-gzip.md`) was sized
against an older main; main has since consumed that headroom, so the exact
reviewed feature head now fails `node ci/check-kit-perf.mjs` in CI. This
decision was re-measured on main `227414575` after earlier measurements
(`ba58281d2`, `3baeb3793`, `d9b213141`, `f1dfd3eb2`) went stale. No Kit
bundle input moved between `f1dfd3eb2` and `227414575` (`web/` untouched;
the only `src/` change is `src/islands/contracts-shared.ts`, which `web/`
does not import), so the combined bytes reproduce the `f1dfd3eb2`
measurement within +/-3B server gzip rebuild jitter.

## Ceilings

- `server.js.maxGzipBytes` 336128 -> 336896 (three 256B steps, 225B margin;
  lower 336640 rejects by 31B).
- `client.js.maxRawBytes` 257024 -> 258048 (one 1024B step, 509B margin;
  lower 257536 rejects by 3B).
- `client.js.maxGzipBytes` 103168 -> 103680 (two 256B steps, 123B margin;
  one step, 103424, rejects by 133B). The 103680 rung is already admitted
  in the shipping tests by the admin-orientation slice (#1911); this
  allocation moves the fragment onto that existing rung.
- Every other ceiling is unchanged. No ceiling moves by x1.25 or more.

## Measurements

Locked Node production builds (`npm run build --prefix web`), measured
through `node ci/check-kit-perf.mjs --format json`, on the profile feature
head (#1834, `f594991f8`) merged with main `227414575` (conflicts only in
`README.md` and `ci/a11y-native-browser-suites.test.mjs`; no bundle inputs).

| Tree | Server gzip | Client raw | Client gzip |
|---|---:|---:|---:|
| Combined build 1 | 336671 | 257539 | 103557 |
| Combined build 2 | 336670 | 257539 | 103557 |
| Slice delta over its first measurement (pristine `ba58281d2`) | +846 | +1907 | +711 |

Client bytes are identical to the `f1dfd3eb2` measurement (257539 /
103557); server gzip reads 336670/336671 versus 336667/336668 there, a +3B
rebuild jitter on an unchanged bundle tree (no Kit bundle input moved:
`web/` untouched, and `src/islands/contracts-shared.ts` is not imported by
`web/`). The pins use the worst observed server figure, 336671. The base
move adds the Happening-now server rung (#1923), the discovery HTML byte
cap (#1913) and the admin-orientation shipping ceilings (#1911). The
ceilings on main reject the combined tree by 543B server gzip, 515B client
raw and 389B client gzip.

## Attribution

Main moved after the first allocation and twice after this one was first
proposed (server gzip 335360 -> 335872 -> 336128, client raw 256000 ->
257024 in #1895), consuming the earlier sizing. The slice itself is
unchanged (client raw delta +1907 in every measurement). The growth is the
`ProfileView` review markup and the shared row helper
`src/profiles/composition.ts`, which ships to both the Kit server bundle
and the client; no new files and no new dependency.

## Shipping tests

`ci/check-kit-perf.test.mjs` unions with main's per-axis allocation menus
(#1911): the `SHIPPING_SERVER_GZIP_ALLOCATIONS` map and
`shippingServerGzipCases()` gain both the 336384 admin-orientation rung and
the 336896 profile review rung (interval = measured worst 336671, exact
336896, one over 336897); `SHIPPING_CLIENT_RAW_ALLOCATIONS` and
`shippingClientRawCases()` gain the 258048 rung (interval 257539, exact
258048, one over 258049); the 103680 client gzip rung is reused unchanged.
Two unconditional cases pin the measured tree (336671 server gzip, 257539
client raw), so reverting either fragment to an older admitted rung fails
closed instead of selecting an older fixture set.
`ci/budget-fragments.test.mjs` admits 336128 (Happening-now) and 336896
(profile review) alongside the older server rungs.

## Scope

Measured bytes only. No checker, gate, mask or exclusion changes; the
feature merges separately and exact-head CI plus independent review stay
mandatory. Undo: revert this allocation before the feature merges.
