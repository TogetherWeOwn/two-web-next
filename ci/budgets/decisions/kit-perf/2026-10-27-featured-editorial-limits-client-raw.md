# 2026-10-27 decision: client JS raw ceiling 257024 -> 257536

`client.js.maxRawBytes` rises 257024 -> 257536 in
`ci/budgets/kit/client-js.json`; no other client ceiling changes. This admits
the featured editorial-limits slice, whose Kit new/edit pages ship the shared
live-counter wiring to the browser. One 512B step, the smallest aligned cover
with at least 300B of margin over the measurement: 257024 rejects the merged
257124 by 100B.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`, two builds per tree. Client
totals did not move across rebuilds.

| Tree (main tip `7d5db1c21`) | Client JS raw | Client JS gzip | Gate at 257024/103168 |
|---|---:|---:|---|
| Pristine main | 255118 | 102664 | exit 0 |
| Merged (main plus feature) | 257124 | 103096 | exit 1, raw 100 over |

Feature delta on client JS: +2006 raw / +432 gzip. Gzip stays at main's
103168: the merged 103096 fits with 72B of margin, so no gzip step is needed.
File count (54/55) and client CSS (2861/1019B) fit unchanged.

Candidate ceilings against the merged build: 257024 rejects (kit.client.js
fails, 100 over); 257536 admits with 412B of margin (exit 0, every Kit group
fits).

## Shipping tests

`ci/check-kit-perf.test.mjs` pins the client raw boundary with fixed
literals; the Reviewer-owned allocation mapping that supports 257536
(exact 257536, one byte over 257537) is delivered separately. In
`ci/budget-fragments.test.mjs` the shipping pin moves to 257536 and gains a
client raw allocation list [257024, 257536]: a case admits both, and 257025,
257535, 257537 and 258048 stay rejected. The off-axis drift cases now run at
every admitted server-gzip x client-raw pair.

Sibling open PRs that propose the same 257536 key (for example the archive
game-facet change) are not forked: the key is one authority, and whichever
lands second reconciles to this history record.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
