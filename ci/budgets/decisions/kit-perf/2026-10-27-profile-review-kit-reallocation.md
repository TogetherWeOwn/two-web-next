# 2026-10-27 decision: profile unsaved-change review Kit capacity after main moved

Second measured-budget allocation for the Kit cost of the profile slice
that lets a member review unsaved profile differences before saving. The
first allocation (`2026-10-26-profile-review-client-gzip.md`) was sized
against an older main; main has since consumed that headroom, so the exact
reviewed feature head now fails `node ci/check-kit-perf.mjs` in CI. This
decision was re-measured on main `4e90a8bcf` after earlier measurements
(`ba58281d2`, `3baeb3793`, `d9b213141`, `f1dfd3eb2`, `227414575`,
`b69eea7d7`) went stale. Main moved to `4e90a8bcf` with the jobs-ledger
bound (#1866), the event time-from-now explainer (#1767) and the
cancelled-event alternatives (#1442); unlike the previous moves this one
touches Kit bundle inputs (`web/src/lib/EventDetail.svelte`,
`web/src/lib/EventGone.svelte`), so the combined re-build breaches all
three previous ceilings and reads 337079/337080 server gzip, 258278 client
raw, 103704 client gzip.

## Ceilings

Baselines are the merge-base ceilings on main `4e90a8bcf`
(336384 / 257024 / 103168).

- `server.js.maxGzipBytes` 336384 -> 337408 (four 256B steps, 328B margin;
  lower 337152 rejects by 72B; one step leaves 72B, below the observed
  renaming churn).
- `client.js.maxRawBytes` 257024 -> 259072 (two 1024B steps, 794B margin;
  lower 258048 rejects by 230B).
- `client.js.maxGzipBytes` 103168 -> 103936 (three 256B steps, 232B margin;
  lower 103680 rejects by 24B).
- Every other ceiling is unchanged. No ceiling moves by x1.25 or more.

## Measurements

Locked Node production builds (`npm run build --prefix web`), measured
through `node ci/check-kit-perf.mjs` and `--format json`, on the profile
feature head (#1834, `f594991f8`) merged with main `4e90a8bcf` (conflicts
only in `README.md` and `ci/a11y-native-browser-suites.test.mjs`; no
bundle inputs).

| Tree | Server gzip | Client raw | Client gzip |
|---|---:|---:|---:|
| Main `4e90a8bcf` alone | 336250 | 256371 | 102994 |
| Combined build 1 | 337079 | 258278 | 103704 |
| Combined build 2 | 337080 | 258278 | 103704 |
| Slice delta over current main | +830 | +1907 | +710 |
| Slice delta over its first measurement (pristine `ba58281d2`) | +846 | +1907 | +711 |

Main alone passes its own ceilings (margins 134 / 653 / 174B). The
combined tree carries the same file counts as main (116 server files,
raw 1193532/1203200B; 54 client files; CSS unchanged): the feature adds
no files and no dependency. The +1907 client raw slice delta reproduces
every measurement; the server delta moved +846 -> +830 because main's
own `web/` changes shifted the shared chunks. The pins use the worst
observed figures (337080 / 258278 / 103704); the 1B server spread between
the two builds is rebuild jitter. The ceilings on main reject the
combined tree by 696B server gzip, 1254B client raw and 536B client
gzip.

## Attribution

Main moved after the first allocation and twice after this one was first
proposed (server gzip 335360 -> 335872 -> 336128, client raw 256000 ->
257024 in #1895), consuming the earlier sizing. The slice itself is
unchanged (client raw delta +1907 in every measurement). The growth is the
`ProfileView` review markup and the shared row helper
`src/profiles/composition.ts`, which ships to both the Kit server bundle
and the client; no new files and no new dependency.

## Shipping tests

`ci/check-kit-perf.test.mjs` keeps every previously admitted rung and adds
the three re-measured profile review rungs: 337408 server gzip (interval =
measured worst 337080, exact 337408, one over 337409), 259072 client raw
(interval 258278, exact 259072, one over 259073) and 103936 client gzip
(interval 103704, exact 103936, one over 103937). Three unconditional cases
pin the measured tree (337080 server gzip, 258278 client raw, 103704 client
gzip), so reverting any fragment to an older admitted rung fails closed
instead of selecting an older fixture set.
`ci/budget-fragments.test.mjs` admits 337408 alongside the older server
rungs (336128 Happening-now, 336384 event-share-honesty, 336896 profile
review), pins the client plan at 259072 raw / 103936 gzip, and rejects the
new rung's neighbours (337152, 337409).

## Scope

Measured bytes only. No checker, gate, mask or exclusion changes; the
feature merges separately and exact-head CI plus independent review stay
mandatory. Undo: revert this allocation before the feature merges.
