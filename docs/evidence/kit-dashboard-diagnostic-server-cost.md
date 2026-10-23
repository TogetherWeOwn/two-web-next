# Dashboard diagnostic server cost

Measured 2026-10-23. This standalone admission supports [#1700](https://github.com/TogetherWeOwn/two-web-next/pull/1700);
it does not ship, modify or approve that product change.

## Frozen inputs and method

- Green main: `46332992eb1b40ae729b47dbb092ec03c5af4c49`.
- Product: `9ed9fd6c5e5a863d243b9d330881360de570747c`.
- Failed combined merge: `7811924913a4ed29328ea4d85f29a98b93e8234b`.
  Its two parents were independently verified as the exact main and product pins above.
- Node v24.22.1; npm 11.19.1. Both committed lockfiles are byte-identical
  across these inputs. Root/web dependencies were installed outside the checkout
  with `npm ci --include=dev --no-audit --no-fund` and linked into each archive.
  Product's root manifest differs only by an unrelated check script; dependency,
  dev-dependency, override and engine declarations are identical.
- Each tree was extracted with `git archive <sha>` into an independent run-owned
  directory, then built twice with `npm run build --prefix web`. Each build
  ran `node ci/check-kit-perf.mjs` without altering the original budget.
- Measurements recursively count emitted `.js` files in
  `web/.svelte-kit/output/server`, sum their raw lengths and sum default Node
  `gzipSync(bytes).length` per file, exactly as the unchanged checker does.
  Source maps are excluded by that existing policy, not a new mask.

## Independent results

All builds succeed. Only the combined tree fails the original gate.

| Tree / build | Server files | Server raw B | Server gzip B | Original gate |
| --- | ---: | ---: | ---: | --- |
| Main / 1 | 118 | 1128057 | 329274 | PASS |
| Main / 2 | 118 | 1128057 | 329272 | PASS |
| Combined / 1 | 118 | 1129391 | 329691 | FAIL, +219 B |
| Combined / 2 | 118 | 1129393 | 329694 | FAIL, +222 B |
| Isolated product / 1 | 118 | 1125424 | 328410 | PASS |
| Isolated product / 2 | 118 | 1125424 | 328409 | PASS |

The isolated product uses an older source base; its passing total does not prove
that integration fits. Against pinned main, the combined increment is
1334–1336 raw B and 417–422 gzip B. Few-byte rebuild variation is recorded,
not claimed as an optimization. The original CI result, 329692 B, falls inside
this independently measured range.

Other groups fit without a ceiling change; totals repeat across both builds:

| Group | Main files / raw / gzip B | Combined files / raw / gzip B | Existing limits |
| --- | --- | --- | --- |
| Worker | 1 / 2551 / 1219 | 1 / 2551 / 1219 | 3584 / 1536 B |
| Client JS | 53 / 245301 / 99265 | 54 / 246495 / 99852 | 54 files; 251904 / 101632 B |
| Client CSS | 2 / 2737 / 983 | 2 / 2804 / 1006 | 4 files; 3072 / 1024 B |

## Attribution and alternatives

First-build server comparison accounts for the entire +1334 raw / +417 gzip B:

| Emitted server path | Main raw / gzip B | Combined raw / gzip B | Delta raw / gzip B |
| --- | ---: | ---: | ---: |
| `entries/pages/admin/_page.svelte.js` | 4016 / 1366 | 4659 / 1607 | +643 / +241 |
| `chunks/admin.js` | 334485 / 85825 | 335106 / 85978 | +621 / +153 |
| `nodes/11.js` | 550 / 296 | 586 / 307 | +36 / +11 |
| `nodes/12.js` | 550 / 290 | 586 / 303 | +36 / +13 |
| `manifest.js` and `manifest-full.js`, together | 13270 / 2288 | 13270 / 2290 | 0 / +2 |
| `chunks/internal.js` | 62347 / 18030 | 62347 / 18029 | 0 / -1 |
| `chunks/instance.js` | 79094 / 21934 | 79092 / 21932 | -2 / -2 |

The two renderer chunks contain the explicit unavailable-versus-empty branches,
retention/cache and privacy explanations, and outcome links using the existing
query parser and URL builder. The node wrappers include the additional client
chunk reference; remaining differences include generated import/hash churn.
110 of 118 server files are byte-identical in this comparison. The feature adds
no server file. The independent byte proof is the emitted total, not a claim
that gzip costs add linearly across unrelated features.

The parent recorded and discarded three combined-tree reductions: shared
copy (329766 B), direct reactive prop access (329654 B), and shared resource-card
data (329615 B). These are reported prior experiments, **not independently rerun
results**. None fit 329472 B. This prerequisite does not revive those refactors,
change diagnostic semantics or remove safety guidance. An inline relaxation on
#1700, arbitrary headroom, checker changes and unrelated ceiling changes are
rejected. No product source or acceptance-author files are modified here.

## Narrow decision and proof limits

Change only `server.js.maxGzipBytes` from **329472 to 329728 B**, one existing
256 B quantum. It is the smallest such step covering the observed maximum
329694 B, leaving 34 B. Zero steps rejects both combined builds; this is an
explicit cost admission, not a size reduction or a future-capacity reserve.
Server raw remains 1203200 B and file count 126; Worker, client, CSS and startup
limits remain unchanged. Preserve the entire prior decision history verbatim.

Current main was checked for already-landed decisions: #1654 changed history
only and left server gzip at 329472 B. Pending #1704 (operator panel) and #1712
(RSVP) are different source-pinned proposals, not landed allowances to add to
this one. If either lands first, reconcile against actual main and remeasure;
never sum independent proposed increases or lower an already-reviewed ceiling
based only on these older measurements.

The existing checker tests and selftest, plus scratch real-artifact boundary
proofs, verify original rejection, proposed acceptance, exact server-boundary
acceptance and one-byte/raw/file-under refusal on both main and combined builds.
No test file or checker changes are needed. Verification commands and outcomes
are recorded in the PR; this document does not claim unrun full-suite, browser,
staging, production-transfer or runtime behavior verification.

The product owner must consume the landed prerequisite and rebuild their actual
integrated head. Fresh exact-head required CI and independent review remain
mandatory on both PRs. A later source change can consume this small margin.

**ACT:** admit only independently measured dashboard diagnostic server cost.
**WHY:** preserve explicit truthful diagnostic states through a separate review.
**UNDO:** revert this standalone admission; the original gate rejects the pinned
combined product again. No deployment or data rollback is involved.
