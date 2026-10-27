# 2026-10-27 decision: profile unsaved-change review Kit capacity after main moved

Second measured-budget allocation for the Kit cost of the profile slice
that lets a member review unsaved profile differences before saving. The
first allocation (`2026-10-26-profile-review-client-gzip.md`) was sized
against an older main; main has since consumed that headroom, so the exact
reviewed feature head now fails `node ci/check-kit-perf.mjs` in CI.

## Ceilings

- `server.js.maxGzipBytes` 335360 -> 336384 (four 256B steps, 187B margin).
- `client.js.maxRawBytes` 256000 -> 257024 (one 1024B step, 191B margin).
- `client.js.maxGzipBytes` 103168 -> 103680 (two 256B steps, 348B margin;
  one step would leave 92B, less than the renaming churn a moving main
  adds to the client gzip).
- Every other ceiling is unchanged. No ceiling moves by x1.25 or more.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`.

| Tree | Server gzip | Client raw | Client gzip |
|---|---:|---:|---:|
| Pristine main `ba58281d2` | 335351 | 254926 | 102621 |
| Feature head merged with the same main | 336197 | 256833 | 103332 |
| Slice delta | +846 | +1907 | +711 |

CI on the same combined head measured server gzip 336195 (run
40453468852), inside rebuild jitter. The current ceilings reject the
combined tree by 837B server gzip, 833B client raw and 164B client gzip.

## Attribution

Main moved after the first allocation: the first measurement saw server
gzip 334041 and client 253949 raw / 102273 gzip on main, and pristine main
now measures 335351 and 254926 / 102621 (see also
`2026-10-26-server-gzip-335360.md`). That consumed the first allocation's
margins. The slice itself is unchanged since the first measurement (client
raw delta +1907 both times). The growth is the `ProfileView` review
markup and the shared row helper `src/profiles/composition.ts`, which ships to both the Kit server bundle and
the client; no new files and no new dependency.

## Shipping tests

`ci/check-kit-perf.test.mjs` gains the 336384 rung in
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval = measured worst 336197, exact
336384, one over 336385) and moves the client raw and gzip literals to the
new ceilings (interval 256833, exact 257024 / 103680, one over 257025 /
103681). `ci/budget-fragments.test.mjs` moves its client pin and admits the
336384 server rung. With the two fragments reverted, six cases fail, so a
revert and any further widening both fail closed.

## Scope

Measured bytes only. No checker, gate, mask or exclusion changes; the
feature merges separately and exact-head CI plus independent review stay
mandatory. Undo: revert this allocation before the feature merges.
