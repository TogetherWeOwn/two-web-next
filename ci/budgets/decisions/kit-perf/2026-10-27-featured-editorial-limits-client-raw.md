# 2026-10-27 decision: client JS raw ceiling 256000 -> 257536

`client.js.maxRawBytes` rises 256000 -> 257536 in
`ci/budgets/kit/client-js.json`; no other client ceiling changes. This admits
the featured editorial-limits slice, whose Kit new/edit pages ship the shared
live-counter wiring to the browser. Three 512B steps, the smallest aligned
cover with at least 300B of margin over the measurement: 257024 fits the
measured 256932 by only 92B, which rebuild-to-rebuild movement of the
surrounding ladder can erase.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, three builds per tree. Client totals did not
move across rebuilds.

| Tree (main tip `ba58281d2`) | Client JS raw | Client JS gzip | Gate at 256000/103168 |
|---|---:|---:|---|
| Pristine main | 254926 | 102621 | exit 0 |
| Merged (main plus feature) | 256932 | 103054 | exit 1, raw 932 over |

Feature delta on client JS: +2006 raw / +433 gzip. Gzip stays at main's
103168: the merged 103054 fits with 114B of margin, so no gzip step is
needed. File count and client CSS (2861/1019B) fit unchanged.

Candidate ceilings against the merged build: 256512 rejects (kit.client.js
fails, 420 over); 257024 admits with 92B of margin (below the 300B target);
257536 admits with 604B of margin (exit 0, every Kit group fits).

## Shipping tests

`ci/check-kit-perf.test.mjs` pins the client raw boundary with fixed
literals; the Reviewer-owned allocation mapping that supports 257536
(interval 257039, exact 257536, one byte over 257537) is delivered
separately, and the merged measurement 256932 lies inside that interval
(256000, 257536]. In `ci/budget-fragments.test.mjs` the shipping pin moves
to 257536 and gains a client raw allocation list [256000, 257536]: a case
admits both, and 256001, 257024, 257535, 257537 and 258048 stay rejected.
The off-axis drift cases now run at every admitted server-gzip x client-raw
pair.

Sibling open PRs that propose the same 257536 key (for example the archive
game-facet change) are not forked: the key is one authority, and whichever
lands second reconciles to this history record.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
