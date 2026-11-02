# MCP truncation notice on the result budget

The Kit server bundle imports the whole Hono app, so the MCP trimmed-result
notice lands in it: the two notice texts, the notice-aware `fitByteBudget`
and `eventResultBytes`, and the second text block in the event tools. The
REST routes share the same fitter. This builds on the result-budget step
([2026-11-01-mcp-result-budget-server.md](2026-11-01-mcp-result-budget-server.md))
and replaces the 1209088 / 338432 step this PR took on `c0fadacb`. No
dependency, file-count, client, CSS, worker, startup or user-facing speed
target changes.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root and
web lockfiles. Both trees sit on main `004ce006`.

| Metric | Feature build 1 / 2 | Result budget builds | Result-budget ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1210976 / 1210976 | 1209740 - 1209742 | 1209856 | 1211392 |
| Server JS gzip | 338619 / 338619 | 338213 - 338217 | 338432 | 338688 |

Feature delta: +1234 raw and +402 to +406 gzip bytes, mostly the two
notice strings, which tell an MCP caller how to read the text that was cut.
Client JS (260403 / 103909), client CSS and the Worker entry are unchanged.

## Sizing

Least-cover aligned steps (raw to 512 bytes, gzip to 256 bytes), not 25%
headroom:

- Server raw 1209856 -> 1211392: +1536 bytes (0.127%); margin 416 bytes.
  The lower 1210880 step rejects by 96.
- Server gzip 338432 -> 338688: +256 bytes (0.076%); margin 69 bytes.

The result-budget ceilings reject this build by 1120 raw and 187 gzip
bytes. Each raise is under the 0.5% per-feature limit. No gate, coverage
floor, file-count cap or user-facing performance target is changed or
bypassed. Exact-head CI must remeasure composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1211392 and server gzip 338688. Fixed fixtures accept the measured sizes
(1210976 raw, 338619 gzip) and the exact ceilings, and reject one byte over
each.

Undo: revert this PR, including its fragment change and oracle controls.
