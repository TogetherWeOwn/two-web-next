# 2026-10-26 decision: admit exact-series review server+client gzip growth

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

Undo: revert both fragment `maxGzipBytes` values and delete this file.
