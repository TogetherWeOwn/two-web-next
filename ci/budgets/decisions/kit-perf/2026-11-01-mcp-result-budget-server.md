# MCP result budget on main 004ce006

The Kit server bundle imports the whole Hono app (`web/src/lib/server/hono.ts`
imports `src/index`), so the MCP event result budget lands in it: the
`eventResultBytes` count, the serverInfo stamp it counts, and the shared
`src/mcp/identity.ts` constants. This replaces the 1207808 step this PR took
on `c0fadacb`; #1973 and #1971 have since moved main to 1209344 / 338176.
No dependency, file-count, client, CSS, worker, startup or user-facing speed
target changes.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root and
web lockfiles. The feature merged into main `004ce006` was built twice; main
`004ce006` (the same tree with the three MCP source files reverted) was built
twice with the same dependencies.

| Metric | Merged build 1 / 2 | Main build 1 / 2 | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1209740 / 1209742 | 1209420 / 1209420 | 1209344 | 1209856 |
| Server JS gzip | 338213 / 338213 | fits 338176 | 338176 | 338432 |

A third merged build, run after the oracle edits, measured 1209742 raw and
338217 gzip (margins 114 and 215). The feature costs +320 to +322 server raw
bytes. Main itself is already 76
bytes over its raw ceiling: #1970 and #1971 each fit alone and landed
together. #1989 proposes the same 1209856 / 338432 step to repair main and
admit #1987; whichever of the two merges second keeps the shared values.

## Sizing

Least-cover aligned steps (raw to 512 bytes, gzip to 256 bytes), not 25%
headroom:

- Server raw 1209344 -> 1209856: +512 bytes (0.042%); margin 114 bytes.
- Server gzip 338176 -> 338432: +256 bytes (0.076%); margin 219 bytes.

Main's ceilings reject the merged build by 396 / 398 raw and 37 gzip bytes.
Each raise is under the 0.5% per-feature limit. No gate, coverage floor,
file-count cap or user-facing performance target is changed or bypassed.
Exact-head CI must remeasure composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1209856 and server gzip 338432. Fixed fixtures accept the measured sizes
(1209742 raw, 338213 gzip) and the exact ceilings, and reject one byte over
each.

Undo: revert this PR, including its fragment change and oracle controls.
