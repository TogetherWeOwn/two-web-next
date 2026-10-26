# Published game suggestions: measured Kit capacity

## Decision

Admit only the measured cost of the published-game suggestion feature in a
separate capacity PR. This PR changes no application, dependency, asset, checker,
file-count allowance or startup bound. It preserves the complete existing budget
history, appending one dated decision.

| Budget field | Incoming ceiling | Proposed ceiling | Increase | Margin above combined build |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 334080 | 334848 | 768 | 86 |
| `client.js.maxRawBytes` | 254976 | 256000 | 1024 | 302 |
| `client.js.maxGzipBytes` | 102912 | 103168 | 256 | 134 |

These are the smallest 256-byte gzip and 512-byte raw boundary steps that cover
the observed composition. They are **not** a new measured-size ×1.25 allocation
or capacity for future work. All other limits remain incoming main, including
server raw 1203200, server files 126, client JS files 55, Worker 3584/1536,
client CSS 3072/1024 and four files, and startup 60000ms.

ACT: allocate only these three byte steps through independent review.
WHY: main fits, while the exact feature composition breaches these three limits;
ordinary shared-component extraction does not recover enough capacity.
UNDO: reviewed revert of these steps and the appended decision, retaining every
prior record. Coordinate any revert with the dependent feature so it cannot ship
against an insufficient budget.

## Pinned source and method

- Main: `91b66a68d2d37bd2c717f3a75299300d3617b811`.
- Feature: `7d390f4b8c54e30b0da703c2085530d1876c78f4`.
- Clean three-way merged source tree: `a51b15238a8a28880fc4e87c7f432e9143fcf81f`.
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
never change the checker, artifacts or other limits:

| Copied budget | Checker exit | Failed group |
| --- | ---: | --- |
| Incoming main limits | 1 | server JS and client JS |
| All three proposed limits | 0 | none |
| Proposed limits, server gzip one step lower (334592) | 1 | server JS |
| Proposed limits, client raw one step lower (255488) | 1 | client JS |
| Proposed limits, client gzip one step lower (102912) | 1 | client JS |

The existing shipping-boundary suite on the proposed budget initially produces
78 passes and three expected failures: its literal one-byte-over cases still pin
the superseded server gzip 334080, client raw 254976 and client gzip 102912 limits.
These are stale test boundaries, not flaky runs; no rerun, skip or checker change
can substitute for independently authored acceptance updates. Preserve the
historical admitted-interval checks and every unrelated boundary. Acceptance
updates and their red/green proof must be incorporated unchanged from the
independent test owner before this PR is ready.

## Scope of the evidence

This is a capacity decision, not feature or release approval. No browser,
accessibility, Lighthouse, staging, deployment, production, database or live
read-performance claim follows from these local build measurements. Original
feature acceptance and visual evidence remain the feature's responsibility.
The parent feature must remeasure its actual integrated head after this decision
lands and pass exact-head CI plus independent review before auto-merge. No gate
is bypassed, and unrelated thresholds are not weakened.
