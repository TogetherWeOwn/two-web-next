# 2026-10-26 decision: admit exact-series review server+client gzip growth

## Current decision after main advanced

Rechecked main `4b2a8ce3f9126536d4d107840d97ed8ff92ed49a` against the
original pin with `git diff --name-status f6b97d9f0..origin/main`. PR #1831
changed Kit build dependencies (Vite 8.3.4 -> 8.3.5, Wrangler 4.151.0 ->
4.152.0, svelte-check 4.7.6 -> 4.7.7), so the original green was not carried
forward. PR #1833 already supplied client gzip 103168B. The net ceiling
change here is now server gzip 335104 -> 336128 only; the client allocation
is inherited, not raised again.

Keep the requested server ceiling covering the historical maximum 335899B
below. It is the smallest 256B-aligned cover of that historical maximum,
NOT the smallest fit for the refreshed output. The refreshed minimum
aligned fits are server 335872B and client 102912B. This distinction is
intentional and visible to independent review; no lower-current-boundary
failure is claimed for those historical values.

Refreshed main and combined tree were each built twice, with locked web
dependencies installed separately via `npm ci --include=dev` per archive,
Node 24.22.1/npm 11.19.1, `npm run build --prefix <archive>/web`, then
`node ci/check-kit-perf.mjs --root <archive> --format json`. Combined tree
`7ef0d170a2b2cba1dd067371153bcbe2301fe117` is the clean merge of refreshed
main and unchanged PR #1764 head `20684191d62abdc6a17379bbdac6e804153af792`;
measurement archives overlay only the requested gzip ceilings.

| Tree / run | Server raw | Server gzip | Client raw | Client gzip | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Refreshed main / 1 | 1182156 | 334739 | 254691 | 102574 | exit 0 |
| Refreshed main / 2 | 1182154 | 334740 | 254691 | 102574 | exit 0 |
| Combined / 1 | 1186500 | 335786 | 255708 | 102902 | exit 0 |
| Combined / 2 | 1186502 | 335790 | 255708 | 102902 | exit 0 |

All four builds retain server 116 files, client 54 files, Worker
2551 raw/1219 gzip bytes, and CSS 2 files at 2861 raw/1019 gzip bytes.
Worst refreshed margins: server gzip 338B under 336128, client gzip 266B
under inherited 103168, client raw 292B under unchanged 256000. Server
gzip spans 4B across the combined rebuilds; the historical +/-3B is not a
guaranteed bound. Client gzip remains identical within each pair.

Refreshed run-2 attribution retains `server/chunks/admin.js` +4303 raw
(412777 -> 417080), events server page +43 raw (854 -> 897), and instance
hash churn +2 raw. Manifest/internal/node hashes change at identical sizes.
Client nodes/13 remains +760 raw (7492 -> 8252), nodes/14 +257 raw
(11164 -> 11421); app entry renames at identical 5596B, with 51/54 client
files unchanged. No new chunks.

Refreshed boundary probes on combined run 2: server 335616B rejects
335790B (exit 1); client 102656B rejects 102902B (exit 1). Historical
server 335872B now PASSES by 82B, and old client 102912B now PASSES by 10B
(both exit 0). Those are not fresh rejection proofs. The historical
rejections below remain evidence for the original build pin only.

Reviewer-owned pin coevolution accompanies this decision: additive server
336128 and client 103168 interval/exact/one-byte-over cases, retaining
prior allocations and both main/original client raw intervals. Only the
two pinning test files change beside the server fragment and this record;
no product code, checker, workflow, dependency, raw/files ceiling, or other
budget changes relative to refreshed main.

## Historical proposal and measurements at the original pin

`server.js.maxGzipBytes` rises 335104 -> 336128 (+1024B, four 256B steps)
in `ci/budgets/kit/server-js.json`; `client.js.maxGzipBytes` rises 102912 ->
103168 (+256B, one step) in `ci/budgets/kit/client-js.json`. No other
ceiling changes: raw, files, worker, CSS and startup limits all fit and
stay unchanged.

Why: PR #1764 (review the exact saved series in the existing inventory)
grows Kit output past both gzip ceilings on its combined tree while each
side fits alone. Main tip `f6b97d9f0` is green on `check`; the bot-merged
head `20684191d` (feature plus main `a9ef8e8e7`) breaches server gzip by
~793B and client gzip by 110B. The feature delta is minimal compiled
scope-retention logic plus acceptance-pinned copy with no safe byte
reduction (longest literals all count-1, recovery copy already
server-carried, tree-shaking clean); server needs -793 of its +1057
marginal while client also breaches, and client raw has 54B headroom, so
server-carry moves are excluded. Capacity decision required.

Measurements (locked Node 24.22.1/npm 11.19.1, two production builds per
tree through `node ci/check-kit-perf.mjs`, all four green on the new
ceilings):

Pristine main tip `f6b97d9f0` (plus only this budget change, no feature;
Kit output identical to main since JSON ceilings do not affect builds):
run 1 server 116 files raw 1182431/gzip 334840B, client 54 files raw
254929/gzip 102692B; run 2 byte-identical. Margins on new ceilings:
1288B server, 476B client. Worker 2551/1219B, CSS 2 files 2861/1019B.

Combined tree (merge-tree `660b9084d233eb2e154a95f390a714ab3dc7a8c3`
of this budget head `58a328275` plus PR head `20684191d`; clean merge, no
conflicts, budget files keep the new ceilings): run 1 server 116 files
raw 1186777/gzip 335897B, client 54 files raw 255946/gzip 103022B; run 2
server raw 1186775/gzip 335896B, client identical. Max observed: server
335897B, client 103022B. Margins on new ceilings: 231B server (229B over
the parent-measured 335899B max, within jitter), 146B client. Client raw
255946B fits 256000B by 54B (tight, noted, no raw move). Server raw fits
1203200B by ~16423B. Files fit (116/126, 54/55).

Attribution (combined run 2 vs pristine rebuild; totals match run-1 pair
+4346 raw/+1057 gzip server, +1017 raw/+330 gzip client): server growth
concentrates in `server/chunks/admin.js` 412777 -> 417080 (+4303 raw,
+997 gzip) plus the events page server entry 854 -> 897 (+43 raw); one
chunk shrinks 2B (`instance.js` hash churn) and five files churn hash at
identical size (manifests, server nodes 13/14, `internal.js`); 108/116
files byte-identical. Client growth is two renamed page nodes only:
`nodes/13` 7492 -> 8252 (+760 raw, +240 gzip), `nodes/14` 11164 -> 11421
(+257 raw, +80 gzip); entry/app hash-churns at identical 5608/1527B;
51/54 files byte-identical including names. No new chunk on either axis.

Boundary selftests on combined run-2 output: server ceiling one 256B step
under (335872B) rejects with `gzip 335896B over 335872B` (exit 1);
client one step under (102912B) rejects with `gzip 103022B over 102912B`
(exit 1); old ceilings (335104/102912B) double-reject (exit 1, matching
the CI failure); new ceilings pass (exit 0). The raised ceilings are the
smallest 256B-aligned covers of max observed actuals, never below them.

Jitter disclosure: server gzip varies +/-3B across identical-tree rebuilds
(pristine 334839-334844B over four builds, combined 335896-335897B over
two; parent saw 335897-335899B). Client gzip is bit-stable (102692B
pristine x4, 103022B combined x2). Ceilings cover the highest observed
value on each axis plus documented margins; a future rebuild at +3B over
our max still fits (server margin 231B, client 146B).

No product code, checker, workflow, dependency or other threshold changes.
Client raw 54B margin is tight but fits; no raw move. Exact-head CI and
independent review remain mandatory; no feature, staging or release
acceptance is claimed.

Undo on refreshed main: revert this slice's server fragment to 335104B,
restore its additive test changes, and delete this file. Do not revert the
103168B client allocation or other changes inherited from PR #1833.
