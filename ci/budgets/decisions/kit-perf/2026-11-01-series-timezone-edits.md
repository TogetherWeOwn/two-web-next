# Main 004ce006 and series timezone-only edits

Main `004ce006` fails its own Kit server raw ceiling. #1971 measured its
activity-log links on main `7f5c60e2` at 1209182 raw. #1970 (`293ad29b`,
refused-transition return links, also in `src/admin`) landed beside it.
The composed main measures 1209420 raw, 76 bytes over 1209344, so every
app PR fails `check` until the ceiling moves.

The next admission is #1987. A parent series edit that changes only the
timezone moves future children to the new zone's wall time and sets
their timezone. Its only changed source is `src/admin/store-event-writes.ts`,
which the Kit server bundles through the admin chunk. Before this raise,
#1987 offset its size inside `src/admin`: it switched the update path's
inline audit inserts to the shared `audit()` helper and shortened the
`agentVersion` bump. That fit on main `0855896f` with 0 bytes of gzip
headroom, but no compaction can absorb main's own 76-byte raw overrun.

No dependency, file-count, CSS, worker, client, startup or user-facing
speed target changes; server and client file counts stay 116 and 53.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`. Gzip uses Node's `gzipSync`, as the
checker does. Build 1 is a local merge of #1987 head `e5143123` into
main `004ce006`. Build 2 is CI's `check` run on the same merge.

| Metric | Main 004ce006 | Composed build 1 / 2 | Main ceiling | New ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1209420 | 1209656 / 1209658 | 1209344 | 1209856 |
| Server JS gzip | 338096 | 338193 / 338189 | 338176 | 338432 |

CI's main run on `004ce006` measured the same 1209420 raw. #1987 costs
+236 / +238 raw and +97 / +93 gzip on this main.

## Sizing

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1209344 -> 1209856: +512 bytes (0.042%). Main alone needs
  this step (76 over). Worst composed margin 198 bytes.
- Server gzip 338176 -> 338432: +256 bytes (0.076%). Only the composed
  build needs it (17 and 13 over). Worst composed margin 239 bytes.

This is a standalone budget PR. It merges before #1987 and turns main's
own `check` green again. No gate, coverage floor, file-count cap or
user-facing performance target is changed or bypassed. Exact-head CI
must remeasure composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1209856 and server gzip 338432. Fixed fixtures accept the measured sizes
and exact ceilings, and reject one byte over each.

Undo: revert this PR only together with changes that bring main back
under 1209344 raw and 338176 gzip. Main alone already exceeds the old
raw ceiling, and #1987 needs the gzip step.
