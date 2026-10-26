# Kit event-edit composition: server gzip allocation

## Decision

Raise only `server.js.maxGzipBytes` in `ci/kit-perf-budget.json` from **334080**
to **334592** bytes, two 256-byte steps. The largest fresh observation is 334526
bytes, so `ceil(334526 / 256) * 256 = 334592`, leaving 66 bytes. One step less,
334336, fails both composed builds by 187–190 bytes. This is the smallest fitting
aligned allocation for these pinned inputs, not a general build-variation bound.

This is a separate prerequisite for [event-edit access and joining fields
(#1739)](https://github.com/TogetherWeOwn/two-web-next/pull/1739), not a reopening
of the [previous correlation allocation
(#1800)](https://github.com/TogetherWeOwn/two-web-next/pull/1800). The separate
[client allocation (#1769)](https://github.com/TogetherWeOwn/two-web-next/pull/1769)
remains its owner's work. No client ceiling is changed here.

**The composed checker remains red overall.** Server gzip passes the proposal,
but client JavaScript still exceeds main's raw and gzip ceilings. Neither this
allocation nor the separate client's proposed limits is feature acceptance,
reserved capacity, deployment evidence, or authority to release the feature.
The feature owner must measure the actual then-current integrated head and obtain
its own exact-head CI and independent review.

## Pinned inputs and reproducible method

- Main: `732a9582a169095051dad778ba98ca1bb7846bd1`.
- Frozen feature: `40940d50b26ba4f8c66bd832c64f52794bd9c2fa`.
- Clean composition tree: `5bcc4d6f0390e3a052a285a6904f6c9be203fa6a`.
- Produce that tree with `git merge-tree --write-tree <main> <feature>`; it exits
  0 without conflicts. Build its exact blobs, not a hand-picked source overlay.
- Node 24.22.1 / npm 11.19.1. Install both committed locks with
  `npm ci --include=dev --no-audit --no-fund` in run-owned external dependency
  directories and symlink them into the archived tree.
  `npm ls --include=dev --depth=0 --json` exits 0 for both roots; installed versions
  include Kit 3.1.0, Svelte 5.57.2,
  Vite 8.3.4, adapter-cloudflare 8.0.1 and Wrangler 4.151.0.
- Root lock SHA-256:
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`.
  Web lock SHA-256:
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both manifests, both locks, `web/vite.config.ts`, `ci/check-kit-perf.mjs` and
  `ci/bundle-inventory.mjs` match byte-for-byte between measured trees.
- Use the same scratch build path and same dependencies for both trees. Remove
  database URL, Postgres and DB-binding environment settings before builds.
  Run twice per tree:

  ```sh
  NODE_ENV=production npm run build --prefix web
  node ci/check-kit-perf.mjs --format json
  ```

- Preserve each output and its checker JSON. For each canonical group, record
  every file's path, raw size, `gzipSync` size and SHA-256; sum individual gzip
  sizes exactly as the unchanged checker does. Verify tracked source blobs
  against the selected Git tree after all controls.

No feature branch, application, test, acceptance file, checker, canonical
inventory, dependency, constraint, CI gate or deploy configuration is changed by
this PR. The scratch composition is an experiment only.

## Two fresh builds per tree

All four production builds exit 0. Original ceilings apply to this table.

| Tree / build | Server files | Server raw bytes | Server gzip bytes | Client raw / gzip bytes | Checker exit / failing groups |
| --- | ---: | ---: | ---: | ---: | --- |
| Pristine 1 | 115 | 1178764 | 333875 | 253949 / 102273 | 0 / none |
| Pristine 2 | 115 | 1178764 | 333872 | 253949 / 102273 | 0 / none |
| Composition 1 | 115 | 1182305 | 334523 | 257165 / 103008 | 1 / server JS, client JS |
| Composition 2 | 115 | 1182305 | 334526 | 257165 / 103008 | 1 / server JS, client JS |

The composed server exceeds 334080 by 443–446 bytes. The earlier observations
of 334526–334528 bytes are not reused as this run's measurements. Both experiments
select the same aligned cap; observed variation is not permission to ignore a red.

Unaffected limits and observed composed totals:

| Group / field | Observed | Unchanged ceiling |
| --- | ---: | ---: |
| Worker raw / gzip | 2551 / 1219 | 3584 / 1536 |
| Server raw / files | 1182305 / 115 | 1203200 / 126 |
| Client JS raw / gzip / files | 257165 / 103008 / 54 | 254976 / 102912 / 55 |
| Client CSS raw / gzip / files | 2861 / 1019 / 2 | 3072 / 1024 / 4 |
| Startup | not timed | 60000 ms |

Client raw is 2189 bytes over its unchanged ceiling and client gzip is 96 bytes
over. The separate client proposal of 257536 / 103168 would cover these observed
client totals, but is neither applied nor accepted by this server-only decision.

## Same-output lower-boundary controls

Run the unchanged canonical checker against each saved composition. Change only
the scratch plan's `server.js.maxGzipBytes`; every other limit stays at main.

| Control | Build 1 cap | Build 2 cap | Server result on both | Overall result on both |
| --- | ---: | ---: | --- | --- |
| Old cap | 334080 | 334080 | fail | exit 1, server + client |
| Proposal | 334592 | 334592 | pass | exit 1, client only |
| One aligned step less | 334336 | 334336 | fail | exit 1, server + client |
| Measured exact fit | 334523 | 334526 | pass | exit 1, client only |
| Measured minus one byte | 334522 | 334525 | fail | exit 1, server + client |
| Restored old cap | 334080 | 334080 | fail | exit 1, server + client |

**12/12 expected exits and group verdicts match.** Worker and CSS pass every
control; client remains red in every control. Artifact manifests before and after
controls match byte-for-byte. Restore the complete original plan after controls.
No fabricated full-green composition is reported.

## Attribution and repeat variation

Compared with the second pristine build, the second composition adds 3541 server
raw bytes and 654 server gzip bytes, with no added or removed server paths. Seven
server paths change bytes; `chunks/admin.js` accounts for +3541 raw / +653 gzip.
The other six are generated hash links or build variation, not omitted artifacts.

Within each repeat pair, only `chunks/instance.js` and `chunks/internal.js` vary
in the server manifest: 113/115 paths are byte-identical. All 54 client paths,
both CSS paths and the Worker are identical within each pair. The feature changes
the event-edit client node by +3216 raw / +736 gzip bytes; three client paths are
rehashed, with the same 54-file inventory. Net client gzip grows by 735 bytes
because the app's hash-link change saves one gzip byte. CSS grows by 28 raw /
13 gzip bytes. These are whole canonical-group measurements, not selected chunks.

## History, scope and rollback

Main's entire `$comment` is preserved exactly, with SHA-256
`d1f03911b163c65b2692bb4547db2b8dd862467dc2f6754f45e8e2becda6dbe9`.
Every other JSON field is identical to pinned main. Evidence lives in this separate
note rather than rewriting or duplicating the existing allocation history.

ACT: allocate 512 additional server-gzip bytes only. WHY: repeated clean
composition builds and lower-boundary controls demonstrate the minimum fitting
256-byte-aligned cap. UNDO: after measuring intervening growth, revert this scalar
and note through a reviewed PR; never rewrite main history or discard another
feature's capacity. No staging/production probe, migration or deployment was run
for this measurement. Startup, browser behavior and feature acceptance remain
outside this budget experiment; exact-head CI and independent review still gate
its merge.
