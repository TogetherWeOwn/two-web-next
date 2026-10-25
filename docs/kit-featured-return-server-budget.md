# Featured inventory return: server gzip allocation

Measured 2026-10-25. This separate budget change supports the native navigation
in [#1805](https://github.com/TogetherWeOwn/two-web-next/pull/1805); it does not
ship or approve that feature. Only `server.js.maxGzipBytes` changes numerically
in [`ci/kit-perf-budget.json`](../ci/kit-perf-budget.json): **333568 → 333824 B**.
Existing decision history is retained verbatim and the new decision is appended.

## Locked inputs and method

- Pristine main: `847bf4647def72aebcb84d1defa9ec8726afa207`.
- Feature: `576d7051f7d58fd7da55fdca5a047ed1de00b307`. Main is its ancestor,
  so that complete feature tree is also the combined tree; no merge reconstruction
  or partial feature overlay is needed.
- Node 24.22.1, npm 11.19.1, zlib `1.3.2.1-motley-285e94b`.
- Root lockfile SHA-256:
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`.
- Web lockfile SHA-256:
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both trees use identical lockfiles and dependency installations, installed with
  `npm ci --include=dev` outside the source trees and linked into them.
- Build with `npm run build --prefix web`, then run
  `node ci/check-kit-perf.mjs --format json`. Use `--root <tree>` when measuring
  an archived tree from the main checkout. The checker sums each emitted file's
  raw length and `gzipSync(bytes).length`; it does not compress concatenated files.
  Every generated JS/CSS file remains counted, including duplicate wrappers and
  manifests. Sourcemaps retain the checker's existing exclusion.

Two builds per locked input, before any budget change:

| Group | Pristine main raw / gzip B | Combined feature raw / gzip B | Files / cap | Unchanged raw / gzip cap B |
| --- | ---: | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry | 3584 / 1536 |
| Server JS | 1176054–1176056 / 333150–333151 | 1178089 / 333741–333745 | 115 / 126 | 1203200 / 333568 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 | 254464 / 102912 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 | 3072 / 1024 |

The unchanged gate passes pristine main (exit 0) and refuses the combined tree
only for server gzip (exit 1, **173–177 B over**). Rebuild variation is reported,
not hidden: server gzip varies by 1 B on main and 4 B on the feature. Client
JS/CSS and Worker totals repeat exactly. The earlier feature measurement of
333743 gzip B falls inside this independently reproduced range.

## Attribution and no-allowance alternative

First-build server attribution, using output paths rather than client content hashes:

| Emitted file | Before raw / gzip B | After raw / gzip B | Delta raw / gzip B |
| --- | ---: | ---: | ---: |
| `chunks/admin.js` | 412754 / 101024 | 414371 / 101493 | +1617 / +469 |
| `entries/pages/admin/featured/_id_/_page.server.ts.js` | 685 / 434 | 981 / 529 | +296 / +95 |
| `entries/pages/admin/featured/_page.server.ts.js` | 1385 / 691 | 1507 / 735 | +122 / +44 |
| Remaining server files, net | — | — | 0 / −18 |
| **Total** | **1176054 / 333151** | **1178089 / 333741** | **+2035 / +590** |

The admin chunk contains the shared five-field return codec, native Hono form
links/copy and route propagation. The two Kit loaders compute the edit, return,
save and delete URLs server-side. The existing featured-list parser remains the
single normalization authority; no second validator, new runtime dependency,
new server file or browser navigation controller is introduced. The edit route
already disables client-side rendering. This PR changes none of that source.

A disposable single-pass parser experiment replaced `some` plus
`Object.fromEntries(map(...))` with a five-field loop collecting first values and
tracking presence before calling the same normalizer. It built **1178118 raw /
333738 gzip B**, still **170 B over** the original ceiling, while growing raw
output by 29 B. It was discarded and the exact feature blob restored. This is
size evidence only, not a claim of acceptance-test equivalence. Moving required
markup or validation away, weakening bounds, or changing bundling globally to
recover these bytes would exceed this narrow allocation's scope.

## Minimum step and refusal controls

One existing 256 B gzip step gives **333824 B**, leaving **79–83 B** against the
two measured unmodified feature builds. Zero steps fails. This is not an x1.25
allowance or reserved capacity for another feature. Server raw and file caps,
all client/Worker caps and the 60000 ms startup ceiling remain unchanged. The
byte gate does not measure actual startup time; the existing parity readiness
timeout enforces that separate bound.

Using retained unmodified feature output at 1178089 raw / 333745 gzip B and
115 files, disposable budget controls exercised the unchanged exported checker:

- Original server gzip cap: exit 1, 177 B over.
- Proposed 333824 B cap: exit 0 across all asset groups.
- Exact actual server raw/gzip/file caps: exit 0.
- Actual server gzip minus one byte: exit 1.
- Actual server raw minus one byte, with the proposed gzip cap: exit 1.
- Actual server file count minus one, with the proposed gzip cap: exit 1.
- Existing `node ci/check-kit-perf.mjs --selftest`: 12 passed.
- Existing `node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs`:
  64 passed, zero failures or skips, including empty/missing/incomplete evidence
  and unbudgeted-asset refusals. No acceptance test files were edited.

After restoring the exact feature source and copying only the proposed budget,
a fresh build passes every group at **1178091 raw / 333744 gzip B**, 115 server
files (80 B gzip margin). The two-byte raw variation is included rather than
attributed to an application edit. Its client, CSS and Worker totals are unchanged.
Pristine main also passes with the proposed cap at 1176056 raw / 333150 gzip B.

The feature's client raw margin is only **99 B**, CSS gzip margin **18 B**, and
new server gzip margin at least **79 B** across the unmodified feature builds. Do not treat this
allocation as proof for a future composition: rebuild the actual integrated head
and retain all normal CI/security/independent-review gates. The feature remains
non-reviewable until its separate acceptance corrections and prerequisite work
are resolved.

## Undo and scope

Revert the single numeric change and the appended decision/note. This restores
333568 B and intentionally rejects the measured feature until its bytes shrink
or a new allocation is independently justified. No application, schema, test,
dependency, workflow, checker, mask, skip or exemption changes are included.
No deployment or production/staging database test is part of this work.
