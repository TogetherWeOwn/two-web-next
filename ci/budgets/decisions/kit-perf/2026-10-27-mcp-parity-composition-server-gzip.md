# 2026-10-27 decision: server JS gzip ceiling 336384 -> 336640

Only `server.js.maxGzipBytes` in `ci/budgets/kit/server-js.json` rises,
by one 256B step. This independently admits the measured server cost of
MCP/REST game-filter and case-variant event-key parity (PR #1860) when
composed with current main. It does not approve or ship that feature.

## Historical pinned composition — 2026-10-27

These measurements describe the original source pin, not the subsequent
conflict-resolved main revalidation recorded below.

- Main: `db2590d0cfc892956aa8f96f21e616fa47b6d6d2`.
- Feature: `9b8b6eb24d4eabe81b7bccc0c5d2da873130b6a5`.
- Conflict-free `git merge-tree --write-tree <feature> <main>`:
  `2536204ab1bd43947d4c14a120e525dcfaf2db8a`.

Independent archived sources, Node v24.22.1 and committed root/web lockfiles;
`npm ci --include=dev` in each root, `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`. No database is used.

| Source | Build | Server raw B | Server gzip B | Files | Gate at 336384 |
|---|---:|---:|---:|---:|---|
| pristine main | 1 | 1190765 | 336371 | 116 | pass |
| pristine main | 2 | 1190765 | 336369 | 116 | pass |
| main + feature | 1 | 1191953 | 336611 | 116 | fail, 227B over |
| main + feature | 2 | 1191953 | 336608 | 116 | fail, 224B over |

Two further composition rebuilds with only the scratch ceiling changed to
336640 pass all groups: 1191955 raw / 336608 gzip and 1191953 raw / 336609
gzip, 116 server files each. The original scratch fragment was restored.

Every build retains Worker 2551 raw / 1219 gzip, client JS 256400 raw /
103000 gzip (54 files), and client CSS 2861 raw / 1019 gzip (2 files).
Their ceilings, server raw/file limits and startup ceiling do not change.

## Why this step

336640 is the smallest 256B-aligned cover of the 336611B worst case, with
29B margin. The lower step misses by 227B. A fresh 25% reserve would be
unjustified for this incremental admission; this is measured capacity,
not a blanket relaxation or an assumption that head-alone CI proves the
composition fits. Identical-tree jitter of up to 3B gzip / 2B raw is
included in the recorded range, not hidden. Future main growth still
requires a new composition measurement.

Using the checker's Node `gzipSync`, the final paired builds attribute
+802 raw / +171 gzip to `chunks/src.js` and +386 raw / +80 gzip to
`chunks/admin.js`; remaining hash churn nets -11 gzip. Total +1188 raw /
+240 gzip. The feature's API parity is the reason to admit this cost;
rewriting its implementation is outside this independent allocation.

## Conflict-resolution revalidation — 2026-10-28

Main `16b59f27931d891b59307ef73240ac06ecc222b2` still ships 336384B.
Its composition with the unchanged feature head above merges cleanly to
`ac0662ac35a555a7bae204b87a5e82357aaa1a4f`. Fresh archived sources,
independent locked root/web installs and the same build/check commands
produce:

| Source | Server raw B, builds 1 / 2 | Server gzip B, builds 1 / 2 | Gate |
|---|---:|---:|---|
| pristine main | 1190765 / 1190767 | 336370 / 336370 | pass at 336384 |
| main + feature | 1191953 / 1191955 | 336607 / 336607 | fail at 336384 |
| main + feature + allocation/tests | 1191955 / 1191953 | 336608 / 336608 | pass at 336640 |

The measured admitted tree is `8e18f95067129eebbf8f04debbc8db7f641b71ec`;
this revalidation note was added afterwards. All six builds have 116
server files and retain the Worker/client measurements above. Main's
separately admitted client pair is 258048 raw / 103424 gzip; this PR does
not change it. The original 336611B witness remains a conservative fixed
acceptance input. Across both dated sessions, composed gzip spans
336607–336611B; the original 3B observation was not a universal jitter
bound. The smallest covering step remains 336640, with 32B margin in this
session and 29B against the historical worst.

The independent conflict handoff `479f25a0a631b7fbb6cc671b83621bc401ac5df1`
is incorporated byte-verbatim: fragment-test SHA256
`7fbdf489014a2c7ae51d61c6da1a2d542ccd85b4e38060be7e63988d4d861459`.
It retains both the server admission and main's paired client oracle.
Both budget suites pass 79/79 with zero skips. Scratch unsupported server
ceilings 336639/336641/336642 and mixed client pairs 258048/103168 and
257024/103424 still reject. On the actual 336608B output, an exact 336608
cap passes and 336607 fails; both budget files are restored byte-for-byte.
This is composition evidence, not a full-suite, CI, review or release claim.

## Fixed acceptance and boundary

The unchanged independently authored handoff
`33e10896c8021c2b426842ced2634018b6a79a9e` adds 336640 to the fragment
oracle and both shipping-checker sections: fixed interval 336611, exact
336640, and one-byte-over 336641. Prior entries and every off-axis pin
remain intact. Unsupported 336639, 336641 and 336642 allocations remain
refused. Before the handoff, a scratch 336640 fragment produced exactly
five unsupported-allocation failures; the shipping baseline passed 74/74.

No application source, checker implementation, dependency, workflow,
exclusion, mask or legacy history changes here. Open competing allowances
are not landed authority. Exact-head CI and independent review still gate
this allocation; runtime, staging, startup and release acceptance are not
claimed. Undo: revert this fragment step, its additive test admission and
this decision; the feature composition will correctly fail the old cap.
