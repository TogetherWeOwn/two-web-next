# 2026-10-27 decision: profile unsaved-change review Kit capacity after main moved

Second measured-budget allocation for the Kit cost of the profile slice
that lets a member review unsaved profile differences before saving. The
first allocation (`2026-10-26-profile-review-client-gzip.md`) was sized
against an older main; main has since consumed that headroom, so the exact
reviewed feature head now fails `node ci/check-kit-perf.mjs` in CI. This
decision was re-measured on main `db2590d0c` after earlier measurements
(`ba58281d2`, `3baeb3793`, `d9b213141`, `f1dfd3eb2`, `227414575`,
`b69eea7d7`, `4e90a8bcf`) went stale. The latest move includes generated
leaf CSS (#1882), honest UTC fallback labels (#1906), and refused-draft
cancellation (#1902). The fresh combined builds read 337204/337206 server
gzip, 258307 client raw, 103710 client gzip. They still fit the proposed
ceilings; this conflict resolution does not increase them further.

## Ceilings

Baselines are the merge-base ceilings on main `db2590d0c`
(336384 / 257024 / 103168).

- `server.js.maxGzipBytes` 336384 -> 337408 (four 256B steps, 202B margin;
  lower 337152 rejects by 54B, so 337408 is the smallest fitting step).
- `client.js.maxRawBytes` 257024 -> 259072 (two 1024B steps, 765B margin;
  lower 258048 rejects by 259B).
- `client.js.maxGzipBytes` 103168 -> 103936 (three 256B steps, 226B margin;
  lower 103680 rejects by 30B).
- Every other ceiling is unchanged. The CSS gzip ceiling of 1280B landed
  separately in #1727 and is preserved. No ceiling moves by x1.25 or more.

## Measurements

Locked Node production builds (`npm run build --prefix web`), measured
through `node ci/check-kit-perf.mjs --format json`, on the profile feature
head (#1834, `f594991f8`) merged with main `db2590d0c`. The disposable
measurement tree unions `README.md` and
`ci/a11y-native-browser-suites.test.mjs`, regenerates the conflicting
minified profile island from its cleanly merged source, and takes all
other automatic merges unchanged. These product bytes are measured only;
this PR does not ship them.

| Tree | Server gzip | Client raw | Client gzip |
|---|---:|---:|---:|
| Main `db2590d0c` build 1 | 336371 | 256400 | 103000 |
| Main `db2590d0c` build 2 | 336369 | 256400 | 103000 |
| Combined build 1 | 337204 | 258307 | 103710 |
| Combined build 2 | 337206 | 258307 | 103710 |
| Slice delta over current main (maxima) | +835 | +1907 | +710 |
| Historical slice delta from the first paired builds on `ba58281d2` | +846 | +1907 | +711 |

Main alone passes its own ceilings (minimum margins 13 / 624 / 168B).
The combined tree carries the same file counts as main (116 server files,
raw 1194057/1203200B; 54 client files; CSS unchanged at 2861 raw / 1019
gzip): the feature adds no files and no dependency. The +1907 client raw
slice delta reproduces every measurement. The pins use the worst observed
figures (337206 / 258307 / 103710); the 2B server spread in each pair is
rebuild jitter. Main's ceilings reject the combined tree by 822B server
gzip, 1283B client raw and 542B client gzip.

## Attribution

Main moved after the first allocation and after this one was first
proposed (server gzip 335360 -> 335872 -> 336128 -> 336384, client raw
256000 -> 257024 in #1895), consuming the earlier sizing. The slice itself
is unchanged (client raw delta +1907 in every measurement). The growth is
the `ProfileView` review markup and the shared row helper
`src/profiles/composition.ts`, which ships to both the Kit server bundle
and the client; no new files and no new dependency.

## Shipping tests

`ci/check-kit-perf.test.mjs` keeps every previously admitted rung and adds
the three re-measured profile review rungs: 337408 server gzip (interval =
measured worst 337206, exact 337408, one over 337409), 259072 client raw
(interval 258307, exact 259072, one over 259073) and 103936 client gzip
(interval 103710, exact 103936, one over 103937). Three unconditional cases
pin the measured tree (337206 server gzip, 258307 client raw, 103710 client
gzip), so reverting any fragment to an older admitted rung fails closed
instead of selecting an older fixture set. Landed witnesses win shared
keys: 336896 server gzip keeps the bounded-homepage 336673 witness from
#1908, and 258048 client raw keeps the 257638 witness from #1943.
`ci/budget-fragments.test.mjs` admits 337408 alongside the older server
rungs (including 336896), pins the client plan at 259072 raw / 103936
gzip, preserves the landed CSS pin, and rejects the new server rung's
neighbours (337152, 337409).

## Scope

Measured bytes only. No checker, gate, mask or exclusion changes; the
feature merges separately and exact-head CI plus independent review stay
mandatory. Undo: revert this allocation before the feature merges.
