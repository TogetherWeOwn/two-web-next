# Published game suggestions: Kit capacity

## Current decision

Raise three Kit ceilings to the smallest aligned steps that cover the exact
feature composition on current main:

| Budget field | Incoming ceiling | New ceiling | Increase | Margin above worst fresh combined build |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 336128 | 336896 | 768 | 205 above 336691 |
| `client.js.maxRawBytes` | 257024 | 257536 | 512 | 155 above 257381 |
| `client.js.maxGzipBytes` | 103168 | 103680 | 512 | 70 above 103610 |

Main `227414575dd8fffe8ebe245086442ce5a20ca174` (adds #1487 archive search and
pager, #1923 server tier 336128 and #1913 discovery HTML cap on top of the
previously measured base; the last commit changes only a test file) and
feature `7d390f4b8c54e30b0da703c2085530d1876c78f4` merge cleanly to tree
`efb831ff590effdf8d415c8e0a55bb1473418568`. Node 24.22.1, npm 11.19.1,
identical locked root/web dependencies, one main build and three composition
builds through the canonical
`npm run build --prefix web && node ci/check-kit-perf.mjs --format json`
(the builds were run against the final fragment values; all three exit 0):

| Measurement | Main | Combined build 1 / 2 / 3 |
| --- | ---: | ---: |
| Server JS raw | 1187400 | 1191042 / 1191042 / 1191042 |
| Server JS gzip | 335837 | 336691 / 336690 / 336691 |
| Client JS raw | 255632 | 257381 / 257381 / 257381 |
| Client JS gzip | 102846 | 103610 / 103610 / 103610 |
| Server / client JS files | 116 / 54 | 116 / 55 all |

Worker 2551/1219 B and CSS 2861/1019 B across two files are identical in all
builds. Main fits its own ceilings. The combined output breaches the previous
branch values server gzip 336640 (+54 B) and client raw 257024 (+357 B);
client gzip 103610 still fits 103680 (the growth is main-side, from #1487;
the feature delta is unchanged). Against the built output without a rebuild,
the new ceilings pass and each single step lower (336640, 257280, 103424)
rejects. Steps are the repository's 256 B gzip and 512 B raw grids, not a
x1.25 allocation or speculative headroom. Worker, CSS, server raw, file-count
and startup limits, the checker, loader, application, dependencies and every
other fragment are unchanged; frozen legacy history is not edited. The
matching acceptance tests were corrected independently by the Test Author
(`a1d07f7da7b5`, based on main `227414575`) and incorporated byte-for-byte
(`ci/check-kit-perf.test.mjs` sha256
`5ce4712f61678d3a21a0223d10de9696456a76d6e9673d54bb427a95090177d4`,
`ci/budget-fragments.test.mjs` sha256
`87783b9446c08b4819f6b61e6f069e094ccf4966eaa395279274c0053a059933`).

ACT: allocate these three measured steps through independent review.
WHY: the exact feature composition exhausts them on current main; the earlier
shared-component experiment did not recover the capacity.
UNDO: reviewed revert of these three fragment values and the matching
acceptance delta, retaining every earlier decision; coordinate with the
dependent feature. This is not feature, staging, deployment or release
approval; the feature must reverify its actual integrated head.

## Re-verification on main `b69eea7d7f8e99096cb497dce71210caf9af0502`

Main moved three commits with no Kit build input: #1942 (103424 client gzip
test tier), #1905 (336384 event-share-honesty server ceiling) and #1903
(staging summary); `git diff 227414575..b69eea7d7 -- web/` is empty and both
package locks are unchanged. The decision above stands unchanged; the merge
unions main's reviewed tier rows (336384 server text, 103424 client row) with
the delivered game-suggestion tiers and keeps the fragment values
336896/257536/103680. Resolved `ci/check-kit-perf.test.mjs` sha256
`e2e20bc3ae2d33b875f206b2d27f49af6d666ec769a1d6b6088534c9fc0fc7e4`,
`ci/budget-fragments.test.mjs` sha256
`3c39426481e306020145f3ec8b6ed970de3c6d658e16a740033219720e644ce3`.

The new composition (main `b69eea7d7` + feature `7d390f4b`, tree
`c9d9b9c81ed9c159fad8519548d86a14461712e4`) carries byte-identical `web/` and
`src/` subtrees to the previous composition tree `efb831ff`. One fresh build
per tree (Node 24.22.1, npm 11.19.1, canonical checker, exit 0 both):
merged tree server gzip 335836 (1 B rebuild jitter vs 335837), client
255632/102846; composition server gzip 336691, client raw 257381, gzip 103610
(all three binding axes byte-identical; server raw 1191044 vs 1191042 is 2 B
of rebuild jitter on a non-binding axis with ~12 KB margin). Proposed
ceilings pass; each single step lower (336640, 257280, 103424) rejects the
same built output. Focused suites 78/78, checker selftest, lint, typecheck,
docs links and floor guard clean.

## Superseded decision (main d9b213141: server 336640, client gzip 103680)

Raise two Kit ceilings to the smallest aligned steps that cover the exact
feature composition on current main (main #1895 already raised client raw
to 257024, so no raw step is taken here):

| Budget field | Incoming ceiling | New ceiling | Increase | Margin above worst fresh combined build |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 335872 | 336640 | 768 | 123 above 336517 |
| `client.js.maxGzipBytes` | 103168 | 103680 | 512 | 252 above 103428 |

Main `d9b213141e4250cbbdc614d70a4ee2a1cea654f` (includes #1803 event-time
duration, #1895 client raw 257024, #1909 server tier 336128, and #1829 root
dependency bumps with no web lockfile change) and feature
`7d390f4b8c54e30b0da703c2085530d1876c78f4` merge cleanly to tree
`a18e5fc2cddd7ef9e5dc08392109022694255a99`. Node 24.22.1, npm 11.19.1,
identical locked root/web dependencies, one main build and three composition
builds through the canonical
`npm run build --prefix web && node ci/check-kit-perf.mjs --format json`:

| Measurement | Main | Combined build 1 / 2 / 3 |
| --- | ---: | ---: |
| Server JS raw | 1186500 | 1190144 / 1190144 / 1190146 |
| Server JS gzip | 335653 | 336516 / 336516 / 336516 |
| Client JS raw | 255118 | 256867 / 256867 / 256867 |
| Client JS gzip | 102664 | 103428 / 103428 / 103428 |
| Server / client JS files | 116 / 54 | 116 / 55 all |

Worker 2551/1219 B and CSS 2861/1019 B across two files are identical in all
builds. Main fits its own ceilings (margins 219/1906/504 B); the combined
output breaches main's server gzip 335872 (+645 B) and client gzip 103168
(+260 B), while client raw 256867 fits main's 257024 (margin 157 B), so only
the two gzip steps are taken. Against the output without a rebuild, the new
ceilings pass and each single step lower (336384, 103424) rejects. Steps are
the repository's 256 B gzip grid, not a x1.25 allocation or speculative
headroom. Worker, CSS, server raw, file-count and startup limits, the checker,
loader, application, dependencies and every other fragment are unchanged;
frozen legacy history is not edited. The matching acceptance tests were
corrected independently by the Test Author (`2132230447b4`) and incorporated
byte-for-byte (`ci/budget-fragments.test.mjs` sha256
`2f46e2afdb42a19012cca439342cb0619caecae21e92d618479bc9eb2fd1d964`).

Merging main `d9b213141` unioned main's own event-detail fits tests and its
336128 tier (interval 335977) into `ci/check-kit-perf.test.mjs`; all delivered
tiers are kept and only the shared 336128 interval takes main's newer,
stronger measurement (the delivered 335875 also fits the tier; the file's
sha256 is now `079948ff9c43b39eb7234d3d031e326478891ff806bf48014dd563e2503c7a7a`).

ACT: allocate these two measured steps through independent review.
WHY: the exact feature composition exhausts them on current main; the earlier
shared-component experiment did not recover the capacity.
UNDO: reviewed revert of these two fragment values and the matching
acceptance delta, retaining every earlier decision; coordinate with the
dependent feature. This is not feature, staging, deployment or release
approval; the feature must reverify its actual integrated head.

## Re-measurement on main `ba58281d211479b934ff268f54f296d2d29adfaa`

Main moved three Kit-relevant commits (#1850 admin bearer rotation, #1806,
#1838) and merged-in budget history. The decision above stands unchanged;
the numbers were re-taken on this base. Main `ba58281d2` and feature
`7d390f4b8c54e30b0da703c2085530d1876c78f4` merge cleanly to tree
`a3275f95c09d16b766628a6dafe971c330dc31dd` (main alone: tree
`b567726b3a2a174e57c54bc9ee635449921f5efb`). Node 24.22.1, npm 11.19.1,
identical locked dependencies, two builds per tree through the canonical
`node ci/check-kit-perf.mjs --format json`:

| Measurement | Main build 1 / 2 | Combined build 1 / 2 |
| --- | ---: | ---: |
| Server JS raw | 1185439 / 1185441 | 1189083 / 1189083 |
| Server JS gzip | 335351 / 335353 | 336203 / 336204 |
| Client JS raw | 254926 / 254926 | 256675 / 256675 |
| Client JS gzip | 102621 / 102621 | 103386 / 103386 |
| Server / client JS files | 116 / 54 both | 116 / 55 both |

Main fits its own ceilings (server margin 7 B); the combined output breaches
main's server gzip 335360 (+844 B), client raw 256000 (+675 B) and client gzip
103168 (+218 B), so all three allocations are still required. The proposed
ceilings pass the combined output with margins 180 B (server gzip), 349 B
(client raw) and 38 B (client gzip); each single step lower (336128, 256512,
103168) rejects it. The fixed test intervals (336190 server) from the earlier
base stay inside the (336128, 336384] interval and are not changed.

## Superseded decision (client gzip only, main 0f8fdd17f)

Raise only `client.js.maxGzipBytes` from 102912 to 103168 B in
`ci/budgets/kit/client-js.json`. Main already supplies server gzip 335104 B
(#1826) and client raw 256000 B (#1798); neither is changed here. All other
fragments and the frozen legacy history are unchanged. The fragment loader,
checkers, application, dependencies, assets, file counts and startup allowance
are unchanged relative to main.

Main `0f8fdd17f21abe7d0f7c015001b9415b180efe99` and feature
`7d390f4b8c54e30b0da703c2085530d1876c78f4` merge cleanly to tree
`f7830a2a6042c197ed17696041bf86096998e73d`. With identical locked root/web
dependencies, Node 24.22.1 and npm 11.19.1, two builds per tree through the
canonical checker measure:

| Measurement | Main build 1 / 2 | Combined build 1 / 2 |
| --- | ---: | ---: |
| Server JS raw | 1179526 / 1179528 | 1183170 / 1183170 |
| Server JS gzip | 334041 / 334041 | 334922 / 334923 |
| Client JS raw | 253949 / 253949 | 255698 / 255698 |
| Client JS gzip | 102273 / 102273 | 103034 / 103034 |
| Server / client JS files | 115 / 54 both | 115 / 55 both |

Worker 2551/1219 B raw/gzip and CSS 2833/1006 B across two files are identical
in all four builds. Both main measurements fit. Both combined measurements
fail only client gzip, by 122 B. The proposed 103168 B ceiling leaves 134 B
margin and is the smallest 256-byte-aligned step covering the observation;
it is not a fresh size-times-1.25 allocation or speculative headroom.
Startup is not measured.

ACT: allocate only this measured client-gzip step through independent review.
WHY: the exact feature composition exhausts this axis; main now covers the
other originally breached axes. The earlier shared-component experiment did
not recover the required capacity and was discarded.
UNDO: reviewed revert of this one ceiling and its matching acceptance delta,
retaining earlier decisions and coordinating with the dependent feature.
This is not feature, staging, deployment or release approval. The parent
feature must reverify its actual integrated head through CI and independent
review. See [the full evidence](../../../../docs/game-suggestion-kit-budget.md).

## Historical branch records

The records below are preserved verbatim from this branch's former monolith
history suffix. Their earlier three-axis and two-axis proposals are historical;
the one-axis decision above supersedes them. Main's frozen legacy record is
not edited.

 2026-10-26 decision (published game suggestion assistance): main 91b66a68d2d37bd2c717f3a75299300d3617b811 plus feature 7d390f4b8c54e30b0da703c2085530d1876c78f4 merges cleanly to source tree a51b15238a8a28880fc4e87c7f432e9143fcf81f. Node 24.22.1/npm 11.19.1, identical locked root/web dependencies, two builds per tree through the unchanged canonical checker: pristine main server 115 files raw 1178762/1178764B and gzip 333875/333875B, client 54 files raw 253949B/gzip 102273B both builds; combined server 115 files raw 1182408/1182406B and gzip 334761/334762B, client 55 files raw 255698B/gzip 103034B both builds. Native datalist/hint rendering across board and event create/edit adds client 1749 raw/761 gzip bytes and server 886-887 gzip bytes. A throwaway shared Svelte component still breaches (server raw/gzip 1182115/334766B, client 255652/103162B); it is discarded and changes no product code. Admit only the measured combined capacity: server.js.maxGzipBytes 334080->334848 (+768B, 86B above largest observation); client.js.maxRawBytes 254976->256000 (+1024B, 302B margin), client.js.maxGzipBytes 102912->103168 (+256B, 134B margin). These are the smallest 256B gzip/512B raw boundary steps that fit; this is not a fresh x1.25 allocation or speculative headroom. Worker 2551/1219B, CSS two files 2833/1006B, server raw, all file caps, startup 60000ms, checker, dependencies, original acceptance tests and every unrelated threshold remain unchanged. Incoming limits reject; the proposed limits pass the same restored combined output; reducing any changed cap by one rounding step rejects again. Full pinned evidence, rejected sharing experiment and limits are in docs/game-suggestion-kit-budget.md. This independent budget decision is not feature, staging, deployment or release approval; the feature must reverify its actual integrated head under exact-head CI and independent review. ACT: allocate these three measured byte steps in this standalone PR. WHY: current caps are exhausted and measured shared-component extraction does not recover the native assistance cost; HTML serialization or escaping-boundary changes are not justified solely to chase these bytes. UNDO: reviewed revert of only these three steps and this appended record, retaining all prior history; coordinate with the dependent feature before reverting. 2026-10-26 reconcile (game-suggestion capacity onto main 0141158a01b32d7d6e16901f49a26558583da9c7): main #1779 changed only this history line (1-file diff, numerics byte-identical, zero build-input change); the 91b66a68d-based combined measurements stand; merged-tree build re-verified post-merge under these caps. 2026-10-26 reconcile (game-suggestion capacity onto main 4d9ebeee5): main #1814 restructured the shipping test to explicit server-gzip allocation tiers (no numeric or build-input change); this decision adopts that structure and adds the measured 334848 tier (interval 334762). Sibling #1816 justifies the same tier with its own interval (334683); the first merger sets the test literal and the second reconciles rows while prose cites both measurements. 2026-10-26 reconcile (game-suggestion capacity onto main 0fe4dd903): main #1826 already moved server.js.maxGzipBytes 334080->335104; fresh repeated builds (Node 24.22.1/npm 11.19.1, identical locked root/web dependencies, unchanged canonical checker, two builds per tree) measure pristine main 0fe4dd903 server 115 files raw 1179526/1179528B gzip 334041/334040B, client 54 files raw 253949B/gzip 102273B both builds, and the clean main+feature tree d8fd764d71e1ccfac62843cdc8d24da236009328 (feature 7d390f4b8 unchanged) server raw 1183170/1183172B gzip 334923/334924B, client 55 files raw 255698B/gzip 103034B both builds. The combined server gzip worst 334924B already fits the reviewed 335104 ceiling (180B margin), so the 334848 server step proposed in the record above is NOT taken: taking it would lower the reviewed ceiling. server.js.maxGzipBytes stays 335104 and the shipping test keeps main's supported tiers (334080/335104/335360) unchanged. The combined client still breaches 254976/102912 on both builds (+722/+122B), so only the two measured client steps are retained: client.js.maxRawBytes 254976->256000 (302B margin; 255488 rejects the same built output) and client.js.maxGzipBytes 102912->103168 (134B margin; 102912 rejects). Every other bound unchanged; evidence updated in docs/game-suggestion-kit-budget.md. Not feature or release approval.
