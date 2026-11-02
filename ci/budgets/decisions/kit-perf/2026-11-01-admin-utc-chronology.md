# Resilient UTC roster and activity times, composed with current main

The roster "Answered" column and the activity-log "When" column now render
through one shared zero-dependency adapter (`src/admin/chronology.ts`):
exact UTC labels with the lossless ISO instant in `<time datetime>`, and an
"Unrenderable time" placeholder instead of a RangeError taking down the
whole table. The Hono pages and their Kit twins label the same instants
the same way across DST boundaries. The roster half ships in this PR; the
activity half is stacked on top, so the ceilings below admit the composed
stack. No dependency, file-count, CSS, worker, startup or user-facing
speed-target changes ship; server and client file counts stay 116 and 53.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0. The pristine merge-base
(`3e718f5f`) was built once; the composed stack (roster PR plus stacked
activity PR) was built twice — once locally and once by exact-head CI —
agreeing within 2 bytes on every axis. Merging current main (which adds
the MCP result-budget and truncation-notice growth) moved the stack to two
new local builds, 1212373/339026 and 1212371/339026, agreeing within 2 bytes
on raw and exactly on gzip.

| Metric | Pristine build | Stack local / CI | Pristine ceiling | Stack ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1209284 | 1210708 / 1210710 | 1209344 | 1212416 |
| Server JS gzip | 338063 | 338447 / 338448 | 338176 | 339200 |
| Client JS raw | 260397 | 261380 / 261380 | 260608 | 261632 |
| Client JS gzip | 103901 | 104463 / 104463 | 103936 | 104704 |

The stack costs +1424 server raw, +384 server gzip, +983 client raw and
+562 client gzip versus pristine (0.12%, 0.11%, 0.38% and 0.54%). Per-file
attribution against pristine: server `chunks/admin.js` +1354 (the shared
adapter plus the Hono roster/activity renderers and both Kit loaders, which
the Kit admin chunk bundles together), `chunks/instance.js` -2 (rename
noise), `nodes/12.js` +36 and `nodes/14.js` +36 (SSR page shells);
client `nodes/12` +227 and `nodes/14` +377 (route nodes: the adapter import
plus the unavailable-time branch), one new 349-byte chunk holding the
shared adapter alone, and `entry/app` +30 (hash noise). The adapter module
has no imports, so no accidental dependency ships in the client chunk; the
remaining growth is the feature's own renderers. Pristine margins were
already razor-thin (client gzip margin 35 bytes), so this product growth
breaches all four axes at once.

## Sizing

Main's MCP admissions landed while this branch was open (server raw 1211392
and server gzip 338688; see `2026-11-01-mcp-result-budget-server.md`,
`2026-11-01-mcp-result-budget-rebase.md`,
`2026-11-01-mcp-truncation-notice-server.md` and
`2026-11-01-mcp-truncation-notice-restack-main.md`), and the merge took this
branch's server fragment to exactly those ceilings. The merged stack measures
1212373 raw and 339026 gzip, so this admission raises the server axes one
further least-cover step on top of main's, plus the client pair.

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1211392 -> 1212416: +1024 bytes (0.085%); margin 43 bytes.
  The lower 512-byte step 1211904 rejects the worst build by 469. The
  margin is thin but has precedent (the 1203932 composition shipped with
  margin 36), and the two merged builds agree within 2 bytes.
- Server gzip 338688 -> 339200: +512 bytes (0.151%); margin 174 bytes.
  The lower 256-byte step 338944 rejects the worst build by 82.
- Client raw 260608 -> 261632: +1024 bytes (0.393%); margin 252 bytes.
  The lower 512-byte step 261120 rejects the worst build by 260.
- Client gzip 103936 -> 104704: +768 bytes (0.739%); margin 241 bytes.
  The lower 256-byte step 104448 rejects the worst build by 15.

Each raise is under 1% and admits this product feature inside its own PR.
No gate, coverage floor, file-count cap or user-facing performance target
is changed or bypassed. Exact-head CI must remeasure composition with
later features.

## Enforcement

Both shipping oracles keep every earlier allocation (including main's
1209856/338432 and 1211392/338688 server steps) and add server raw 1212416,
server gzip 339200 and the client pair 261632/104704. The shipping oracle
admits the stack as server 1212416/339200 with client 261632/104704. Fixed
fixtures accept the measured sizes and exact ceilings, and reject one byte
over each.

Undo: revert the roster PR's admission commit. The server and client
fragments, this decision and the oracle additions go together; the stacked
activity PR then re-measures against the restored ceilings.
