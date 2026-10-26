# Published game suggestions: measured Kit capacity

## Decision

Admit only the measured cost of the published-game suggestion feature in a
separate capacity PR. This PR changes no application, dependency, asset, checker,
file-count allowance or startup bound. It preserves the complete existing budget
history, appending one dated decision.

The original proposal also included a server gzip step (334080 → 334848).
Before this PR merged, main raised that ceiling further for an independent
composition (#1826: 334080 → 335104), and a fresh re-measurement on the final
base (below) shows the feature composition already fits it. The server step
is therefore **not taken**: taking 334848 would lower the reviewed ceiling.
The final change raises only the two client ceilings.

| Budget field | Incoming ceiling | Proposed ceiling | Increase | Margin above fresh combined build |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 335104 (landed by #1826) | 335104 — no change | 0 | 180 above worst 334924 |
| `client.js.maxRawBytes` | 254976 | 256000 | 1024 | 302 |
| `client.js.maxGzipBytes` | 102912 | 103168 | 256 | 134 |

These are the smallest 256-byte gzip and 512-byte raw boundary steps that cover
the observed composition. They are **not** a new measured-size ×1.25 allocation
or capacity for future work. All other limits remain incoming main, including
server raw 1203200, server files 126, client JS files 55, Worker 3584/1536,
client CSS 3072/1024 and four files, and startup 60000ms.

ACT: allocate only these two client byte steps through independent review.
WHY: main fits, while the exact feature composition breaches these two client
limits on every repeated build; ordinary shared-component extraction does not
recover enough capacity. The server breach measured originally is already
covered by the independently reviewed 335104 ceiling on main.
UNDO: reviewed revert of these two steps and the appended decision, retaining
every prior record. Coordinate any revert with the dependent feature so it
cannot ship against an insufficient budget.

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
