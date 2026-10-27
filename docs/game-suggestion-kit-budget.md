# Published game suggestions: measured Kit capacity

## Current decision

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

Raise **only client JS gzip 102912 → 103168 B** in
[`client-js.json`](../ci/budgets/kit/client-js.json). Main already supplies
server gzip 335104 (#1826) and client raw 256000 (#1798); neither is raised
or lowered here. The original three-limit proposal is historical, not the
current allocation.

| Budget field | Incoming ceiling | Proposed ceiling | Increase | Margin above fresh combined build |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 335104 | 335104 — no change | 0 | 181 above worst 334923 |
| `client.js.maxRawBytes` | 256000 | 256000 — no change | 0 | 302 |
| `client.js.maxGzipBytes` | 102912 | 103168 | 256 | 134 |

This is the smallest 256-byte-aligned gzip step covering the measured output,
not a fresh measured-size ×1.25 allocation or speculative headroom. No
application, dependency, asset, checker, loader, file-count or startup limit
changes relative to current main. All other fragments and the frozen legacy
history remain byte-identical. The fragment migration from #1858 is consumed,
not replaced by a second budget authority. The new
[decision record](../ci/budgets/decisions/kit-perf/2026-10-26-game-suggestion-client-gzip.md)
preserves this branch's prior monolith-history suffix verbatim.

ACT: allocate only this one client-gzip step through independent review.
WHY: current main fits; the exact feature composition fails only client gzip
by 122 B on both repeated builds. Existing raw/server allowances now cover
those axes without any new allocation here.
UNDO: reviewed revert of this gzip step and its matching acceptance delta,
retaining all earlier decisions and coordinating with the dependent feature.

## Earlier remeasurement after repair and fragment migration (main 0f8fdd17f)

- Main: `0f8fdd17f21abe7d0f7c015001b9415b180efe99`.
- Feature remains `7d390f4b8c54e30b0da703c2085530d1876c78f4`.
- Clean combined tree: `f7830a2a6042c197ed17696041bf86096998e73d`;
  `git merge-tree --write-tree <main> <feature>` exits 0.
- Node 24.22.1, npm 11.19.1; identical locked dependencies and canonical
  checker, inventory and loader bytes across the two measured trees.
- Calendar repair #1841 is inherited unchanged; it is not authored here.

| Measurement | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1179526 / 1179528 | 1183170 / 1183170 |
| Server JS gzip | 334041 / 334041 | 334922 / 334923 |
| Client JS files | 54 / 54 | 55 / 55 |
| Client JS raw | 253949 / 253949 | 255698 / 255698 |
| Client JS gzip | 102273 / 102273 | 103034 / 103034 |
| Worker raw / gzip | 2551 / 1219 both | 2551 / 1219 both |
| CSS files; raw / gzip | 2; 2833 / 1006 both | 2; 2833 / 1006 both |

All four production builds succeed. Both pristine measurements pass incoming
main limits; both combined measurements fail only client gzip. On the same
combined output without rebuilding, the proposed fragment passes; the prior
102912 and one-byte-below-measured 103033 gzip limits reject. Startup is not
measured. The historical sections below retain earlier source-specific
numbers and test counts; they are not current-head results.

## Historical measurements and reconciliations

## Pinned source and method

- Main: `91b66a68d2d37bd2c717f3a75299300d3617b811`.
- Reconciled onto main `0141158a01b32d7d6e16901f49a26558583da9c7`,
  which changed only the history line (one-file diff, numerics
  byte-identical, zero build-input change). The measurements below were
  taken against the `91b66a68d`-based trees and stand; the merged tree
  is rebuilt and re-verified under the proposed caps before merge.
- Reconciled onto main `4d9ebeee5b311dd5bedb606a57ea91183625c3c7`
  (`test(kit): support current and justified server-gzip allowances`),
  which restructured only the shipping test (one-file diff, no numeric
  or build-input change). At that point this decision adopted the tier
  structure and added a measured 334848 tier; pinned values were unchanged.
- Reconciled onto main `0fe4dd90396dc17d7985ae6e5df24ebad46c226e` after
  #1826 raised server gzip to 335104, #1812 and #1819 changed server
  build inputs (`src/events/*`, `src/agent-events/*`), and #1827 added
  the 335360 shipping-test tier. Build inputs moved, so the `91b66a68d`
  numbers below no longer decide anything on their own: both trees were
  re-measured on this final base (fresh table further down). The 334848
  test tier is dropped again; main's supported tiers
  (334080/335104/335360) are kept byte-identical.
- Feature: `7d390f4b8c54e30b0da703c2085530d1876c78f4` (unchanged across
  every reconcile).
- Clean three-way merged source tree (original pins):
  `a51b15238a8a28880fc4e87c7f432e9143fcf81f`.
- Clean three-way merged source tree (final base):
  `d8fd764d71e1ccfac62843cdc8d24da236009328`
  (`git merge-tree --write-tree 0fe4dd903 7d390f4b8`, exit 0).
- Runtime: Node 24.22.1, npm 11.19.1.

Use `git merge-tree --write-tree <main> <feature>` to produce the combined tree,
not a wholesale feature-file overlay. Archive pristine main and that exact tree
into separate run-owned directories. The assigned branch and parent workspace do
not move. Root and web package manifests, lockfiles, canonical checker and bundle
inventory are byte-identical across both measured trees. Install the locked root
and web dependencies outside the synced trees with
`npm ci --include=dev --no-audit`, then link both measurement trees to those
same two installs. No database is needed for the builds.

Build each tree twice and measure with the unchanged canonical checker:

```sh
npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

The checker sums raw bytes and Node's default-level gzip bytes **per JS/CSS file**.
It excludes sourcemaps and non-JS/CSS files such as the generated `version.json`.
All four builds exit 0. Incoming main passes twice; the combined source fails
twice on exactly server gzip and client raw/gzip.

| Measurement | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1178762 / 1178764 | 1182408 / 1182406 |
| Server JS gzip | 333875 / 333875 | 334761 / 334762 |
| Client JS files | 54 / 54 | 55 / 55 |
| Client JS raw | 253949 / 253949 | 255698 / 255698 |
| Client JS gzip | 102273 / 102273 | 103034 / 103034 |
| Worker raw / gzip | 2551 / 1219 both builds | 2551 / 1219 both builds |
| Client CSS files | 2 / 2 | 2 / 2 |
| Client CSS raw / gzip | 2833 / 1006 both builds | 2833 / 1006 both builds |

The client delta is +1749 raw / +761 gzip bytes and one file. The generated client
manifest attributes raw growth to event-edit node 14 (+536), event-create node 15
(+545), member-board node 28 (+521), the shared hint chunk (+114), and the app
manifest/import map (+33): exactly 1749 bytes. The native option loops are not a
new browser widget or dependency. These routes remain SSR-only; `csr = false`
does not remove their generated client nodes from the canonical inventory.

Server raw varies by two bytes between repeated builds, and combined server gzip
by one byte. The proposal covers the larger observation, not a selected lower
result. Startup latency was not measured; the existing bound is unchanged.

## Re-measurement on final main (`0fe4dd903`)

Same method as above: pristine `0fe4dd903` and the clean combined tree
`d8fd764d`, identical locked dependencies (root/web manifests, lockfiles and
the checker are byte-identical across both trees), two builds per tree, all
four builds exit 0. Pristine main passes its own budget twice; the combined
source fails twice on **client JS only** — server JS now fits main's 335104
ceiling, which is why the server step is dropped.

| Measurement | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1179526 / 1179528 | 1183170 / 1183172 |
| Server JS gzip | 334041 / 334040 | 334923 / 334924 |
| Client JS files | 54 / 54 | 55 / 55 |
| Client JS raw | 253949 / 253949 | 255698 / 255698 |
| Client JS gzip | 102273 / 102273 | 103034 / 103034 |
| Worker raw / gzip | 2551 / 1219 both builds | 2551 / 1219 both builds |
| Client CSS files | 2 / 2 | 2 / 2 |
| Client CSS raw / gzip | 2833 / 1006 both builds | 2833 / 1006 both builds |

Feature delta against final main: server +3644 raw / +882..884 gzip, client
+1749 raw / +761 gzip and one file — the client numbers are identical to the
original measurement (no client build input changed on main). Combined
server gzip worst 334924 fits 335104 with 180 bytes to spare; combined
client breaches 254976/102912 by 722/122 bytes on both builds. On the same
built combined output with no rebuild: the proposed 256000/103168 client
limits pass (checker exit 0); client raw at 255488 rejects (exit 1); client
gzip at 102912 rejects (exit 1); restored main limits reject (exit 1).

## Rejected source-sharing experiment

In the isolated combined source only, extract the three repeated datalist/hint
blocks into one Svelte component. Pass `games`, list ID, hint ID, and a board flag
for the existing `br`/`span` versus admin `p.hint` wrapper. Keep the input fields,
ARIA links, optional reads and original acceptance files unchanged.

| Group | Shared-component experiment | Incoming ceiling | Verdict |
| --- | ---: | ---: | --- |
| Server raw / gzip | 1182115 / 334766 | 1203200 / 334080 | gzip breach |
| Client raw / gzip | 255652 / 103162 | 254976 / 102912 | raw and gzip breach |
| Server / client JS files | 115 / 55 | 126 / 55 | fit |

Sharing saves only 46 client raw bytes and increases client gzip by 128 bytes.
Server gzip is also higher than either original combined measurement. Discard
the experiment, restore all original source bytes, and rebuild before the second
combined measurement above. No component refactor ships. This is not a claim that
all possible implementations were explored; changing HTML serialization or the
escaping boundary solely to recover a few hundred bytes is outside this narrow
capacity decision.

## Canonical boundary proof

On the same restored combined output, change only the copied budget under test;
never change the checker, artifacts or other limits. (This table is the
original `91b66a68d`-based tree under the original three-limit proposal,
retained as history; the fresh-base boundary results are in the
re-measurement section above.)

| Copied budget | Checker exit | Failed group |
| --- | ---: | --- |
| Incoming main limits | 1 | server JS and client JS |
| All three proposed limits | 0 | none |
| Proposed limits, server gzip one step lower (334592) | 1 | server JS |
| Proposed limits, client raw one step lower (255488) | 1 | client JS |
| Proposed limits, client gzip one step lower (102912) | 1 | client JS |

Against current main caps the resolved shipping-boundary suite produces
27 passes and six expected failures in this file (78 passes across the
shipping + inventory files; the inventory file contributes 51
budget-independent passes): its client rows pin the proposed 256000/103168
ceilings (interval, exact and diagnostic-ceiling assertions), while the
server rows select main's supported 335104 allocation tier and pass. These
are stale-cap failures, not flaky runs; no rerun, skip or checker change can
substitute for the proposed limits.

The [independently authored acceptance correction](https://github.com/TogetherWeOwn/two-web-next/commit/0f76d9f0387ea1913e00ef3bb6903e182e64daa5)
(test-file SHA256 `cd3314aec99bb7c255ba132d99ce692ab80995201acd48bd7ea90182b6129716`
at incorporation) is preserved. In the final resolved file its client rows
(measured intervals 255698/103034, exact ceilings, one-byte-over cases) are
the **only** diff against current main: the earlier 334848 server-tier
adaptation is reverted because #1826 landed the independently justified
335104 ceiling first (its record covers a 334994 combined worst, above this
composition's fresh 334924 worst). Main's allocation mapping
(334080/335104/335360), the checker, fixture helpers and every unrelated
boundary are unchanged. Resolved test-file SHA256:
`11ee01e10aac2e92b63a9ae7f0d598854299334d83c8b53be4dcf162c9fcc0f3`.

Local red/green verification of those exact resolved bytes (copied budgets,
unchanged checker and test file):

- Current main caps (335104 server, 254976/102912 client): 27/33 pass, six
  intended client failures, no skips.
- Proposed final caps: file 33/33; the complete Kit gate step passes
  163/163, no skips; checker selftest 12/12.
- Server cap at the dropped 334848 step: 29/33 pass; the allocation control
  plus all three server rows reject the unsupported ceiling.
- Client raw one step lower (255488): 30/33 with three row failures; one byte
  lower (255999): 31/33 with exact plus diagnostic-ceiling failures; one byte
  higher (256001): 32/33 with the diagnostic-ceiling failure only.
- Client gzip one step lower (102912): 30/33 with three row failures; one byte
  lower (103167): 31/33 with exact plus diagnostic-ceiling failures; one byte
  higher (103169): 32/33 with the diagnostic-ceiling failure only.

The over-row failures show the loaded (wrong) ceiling in the checker
diagnostic, for example `over 254976B` where the test pins `over 256000B`.
All eight rejecting controls behave as listed. This synthetic evidence complements, but
does not replace, the exact application build measurements above.

## Scope of the evidence

This is a capacity decision, not feature or release approval. No browser,
accessibility, Lighthouse, staging, deployment, production, database or live
read-performance claim follows from these local build measurements. Original
feature acceptance and visual evidence remain the feature's responsibility.
The parent feature must remeasure its actual integrated head after this decision
lands and pass exact-head CI plus independent review before auto-merge. No gate
is bypassed, and unrelated thresholds are not weakened.
