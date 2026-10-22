# Combined board-caption and profile-composition budget

Measured 2026-10-22. This is a budget-only prerequisite for
[#1493](https://github.com/TogetherWeOwn/two-web-next/pull/1493), not approval
of that feature. No feature source, test, baseline, lockfile, checker or CI
wiring changes here. The integrated feature still needs exact-head CI and
independent review.

## Inputs and method

- Main: `5f4f1c65931ba4164a4e611c861f6d1428a8b591`, including profile
  composition feedback from [#1453](https://github.com/TogetherWeOwn/two-web-next/pull/1453).
- Frozen combined candidate: `723957121b65f033d00f03a81647bdfd5b6f7318`.
  Main is an ancestor; the candidate already includes the composition merge.
- Node `v24.22.1`; fresh external `npm ci --include=dev` installations for
  root and `web`, shared by both trees. No credentials, remote services or DB
  are needed for these builds.
- Identical root lockfile SHA-256:
  `04730586621dbb4298900b86b62bd9c3aedab9852e6ffe1df366523593be506d`.
- Identical web lockfile SHA-256:
  `d02c1ee10d14e72934aa30b9182187d8509facf3bfbe4fa5961d812abcf8c9fc`.
- Each tree built twice with `npm --prefix web run build`, followed by
  `node ci/check-kit-perf.mjs`. All 52 client path/SHA-256 pairs are identical
  between rebuilds of the same tree. The check sums each emitted JS file's raw
  length and Node `zlib.gzipSync(bytes)` default gzip length, not a concatenated
  or deduplicated transfer estimate. Source maps remain excluded as before.

## Reproduced results

Values are bytes; slash-separated values are raw/gzip. Server gzip has small
build-ID variation; client output is deterministic.

| Group | Main build 1 | Main build 2 | Combined build 1 | Combined build 2 | Existing ceiling |
| --- | --- | --- | --- | --- | --- |
| Client JS | 246743/99218 | 246743/99218 | 247508/99468 | 247508/99468 | 247296/99840 |
| Client JS files | 52 | 52 | 52 | 52 | 53 |
| Server JS | 1105910/324950 | 1105910/324949 | 1107424/325443 | 1107424/325441 | 1203200/327680 |
| Server JS files | 122 | 122 | 123 | 123 | 123 |
| Worker entry | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 | 3584/1536 |
| Client CSS | 2660/891 | 2660/891 | 2660/891 | 2660/891 | 3072/1024 |
| Client CSS files | 1 | 1 | 1 | 1 | 4 |
| Checker exit (old budget) | 0 | 0 | 1 | 1 | 0 required |

The exact red-before diagnostic is:

```text
kit perf budget: client js: raw 247508B over 247296B
```

The proposed file applied to the already-built combined output exits 0:
client JS 52/53 files, raw 247508/247808B and gzip 99468/99840B. Restoring
the previous budget reproduces exit 1, then reapplying this budget exits 0.

## Attribution and reduction decision

The only client size increase is the member-board structural node:

| Manifest source | Main raw/gzip | Combined raw/gzip | Delta |
| --- | --- | --- | --- |
| `.svelte-kit/generated/build/client-optimized/nodes/26.js` | 3600/1722 | 4365/1972 | +765/+250 |
| `.svelte-kit/generated/build/client-optimized/app.js` | 5318/1477 | 5318/1477 | 0/0 |

The app entry only relinks the changed board hash. Of the 52 client files,
50 retain identical paths and content hashes across trees (47 unique hashes,
because some generated stubs share bytes). Only the board node and app entry
change. The whole client delta equals the board node's +765/+250.
The full per-file sizes and SHA-256 maps from each tree's first build are in
[combined-board-client-budget-files.tsv](combined-board-client-budget-files.tsv).

The board node contains the shared pure caption function and the three
scope/game-specific empty-state branches with real recovery links. The
existing route stays `csr = false`; it still emits a structural client node,
so SSR-only is not grounds to exclude that node. No route, hydration,
dependency or client file is added. Both client trees have zero literal
`drizzle-orm` references.

Server growth is explained by the new `chunks/captions.js` (349 raw/283 gzip),
board SSR entry (+635/+133), shared Hono `chunks/src.js` (+577/+116), and
`chunks/members.js` (-45/-39), plus small generated instance/node variation.
No server ceiling needs to move.

Reduction was considered first. The source feature's recorded, reverted
copy-deduplication and status-paragraph experiments saved only 94 B and
127 B respectively, both short of the 212 B breach. Those experiments were
not rerun or shipped here. Independent source/output inspection confirms
the growth is the intended caption and recovery template, not a duplicated
library. Removing meaningful copy/links or shifting caption generation into
the server data contract would broaden this prerequisite into a feature
rewrite. No safe sufficient reduction is established, so this PR leaves
the feature bytes intact and makes the cost decision explicit.

## Proposed limit and unchanged guards

Only `client.js.maxRawBytes` moves: **247296 → 247808 (+512 B, about 0.21%)**.
It is the first fitting 512-byte boundary, not an arbitrary proportional
increase. The previous boundary fails by 212 B; the new limit leaves 300 B.
The unchanged gzip ceiling leaves 372 B. Client/server counts, gzip, server
bytes, worker, CSS and startup ceilings remain exactly as main.

The startup bound remains 60000 ms, still consumed as the readiness timeout
by `playwright.kit-parity.config.ts`. This reproduction did **not** measure
Worker startup latency or run the parity browser server; an unchanged
configured bound is not a measured startup result. No audits are skipped,
assets hidden, baselines reset or checks weakened outside this one explicit
raw-byte proposal.

## Verification scope and rollback

The unchanged checker selftest passes 6/6 cases and
`node --test ci/check-kit-perf.test.mjs` passes 13/13, including real breaches
and incomplete-output refusals. The red/green swap uses the same emitted
combined bytes, avoiding rebuild churn as a confounder.

Full-app verification and required exact-head CI are recorded in the PR;
this measurement does not stand in for them. This prerequisite changes no
page, so it has no new page screenshot or staging claim. Rollback restores
the prior raw limit; it intentionally makes the frozen combined candidate
fail again. Do not change the feature ref from this prerequisite.
