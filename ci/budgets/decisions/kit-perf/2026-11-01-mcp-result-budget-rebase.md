# MCP result budget rebased on main 290e4519

PR #1975's 1209856 / 338432 step (taken on main `004ce006`) merged
forward to main `290e4519` cleanly: no conflicting hunks. The merge
brings the #2000 trim, the GET /version endpoint (#1974), the outage
headers (#1973), and the release-automation changes; none of them
touches a budget fragment or oracle.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root
and web lockfiles. The merged tree was built twice.

| Metric | Merged build 1 / 2 | Main ceiling | Kept ceiling |
| --- | ---: | ---: | ---: |
| Server JS raw | 1209604 / 1209604 | 1209344 | 1209856 |
| Server JS gzip | 338183 / 338185 | 338176 | 338432 |

No ceiling change: the merged build fits the existing step with
margins of 252 raw bytes and 247 gzip bytes. Main's own ceilings
reject it by 260 raw and 7-9 gzip bytes, so the step is still
required. Each kept raise stays under the 0.5% per-feature limit from
the original step decision. No gate, coverage floor, file-count cap
or user-facing performance target is changed or bypassed.

## Enforcement

Unchanged: both shipping oracles keep every earlier allocation
including server raw 1209856 and server gzip 338432. Exact-head CI
remeasures composition with later features.

Undo: revert PR #1975, including its fragment change and oracle controls.
