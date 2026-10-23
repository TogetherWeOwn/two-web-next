# Combined board-caption and profile-composition budget

Measured 2026-10-22; refreshed 2026-10-23. This is a budget-only prerequisite for
[#1493](https://github.com/TogetherWeOwn/two-web-next/pull/1493), not approval
of that feature. No feature source, test, baseline, lockfile, checker or CI
wiring changes here. The integrated feature still needs exact-head CI and
independent review.

**Current proposal after base-conflict reconciliation:** raw client JS
247296 → 248320 B (+1024 B). The initial 247808 B proposal below is historical
and does not fit the refreshed integration. See the final section for the
new repeated measurements and unchanged guards.

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

## Initial proposal and unchanged guards (superseded below)

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

## Base-conflict reconciliation: current proposal

The PR conflict wake requires consuming main `65285dba9` (2026-10-22).
Only `ci/kit-perf-budget.json` conflicted: main appended RSVP decision
history, without changing any numeric ceiling. The resolution retains all
of main's history, the original proposal above, and this reconciliation.
No incoming source or test file was edited during resolution.

The budget-only merged tree passes under main's original ceiling. However,
that alone would miss whether the prerequisite still fits the feature.
A disposable archive of `65285dba9` was overlaid with the exact five-path
source/acceptance diff from `5f4f1c659` to frozen candidate `723957121b65`:

- `src/leaderboards/captions.ts`
- `src/leaderboards/members.ts`
- `src/leaderboards/pages.tsx`
- `web/src/routes/leaderboards/members/+page.svelte`
- `test/member-board-captions-empty-recovery-acceptance.test.ts`

The overlay applies cleanly. The feature's budget-history edit, screenshots
and baselines are not build inputs and were not overlaid. No feature source
ref was modified or pushed. Use `git archive 65285dba9`, then apply
`git diff 5f4f1c659 723957121b65 -- <the five paths above>` to reproduce.
Install the same root/web lockfiles externally, link their dependencies,
then run `npm --prefix web run build` and `node ci/check-kit-perf.mjs` in
each tree. This uses no database, credential or remote service.

Two locked builds per tree, Node `v24.22.1`, the same lockfile hashes as
above; all 52 client path/hash pairs match between each tree's rebuilds:

| Group | Updated main 1 | Updated main 2 | Refreshed combined 1 | Refreshed combined 2 |
| --- | --- | --- | --- | --- |
| Client JS raw/gzip | 247148/99351 | 247148/99351 | 247913/99601 | 247913/99601 |
| Client JS files | 52 | 52 | 52 | 52 |
| Server JS raw/gzip | 1109456/326133 | 1109456/326132 | 1110974/326633 | 1110974/326630 |
| Server JS files | 122 | 122 | 123 | 123 |
| Worker raw/gzip | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 |
| Client CSS raw/gzip | 2660/891 | 2660/891 | 2660/891 | 2660/891 |

The same 50 client paths/hashes are unchanged across the two trees; only
the board structural node and app hash relink change. The board node still
measures 3600/1722 → 4365/1972 B, exactly **+765/+250 B**; the app entry is
5318/1476 B on both sides. Both clients have zero literal `drizzle-orm`
references. The TSV appends first-build rows named `refreshed-main` and
`refreshed-combined`; the original rows remain untouched.

The updated main is 148 B below its raw ceiling. The refreshed feature is
**617 B over main's 247296 B ceiling and 105 B over the initial 247808 B
proposal**. Therefore the current raw proposal is **248320 B**, the first
fitting 512 B boundary: +1024 B versus main (about 0.41%), with **407 B raw
and 239 B gzip margins**. This supersedes the initial +512 B proposal; it
is not another allowance on top of 248320 B. Every other numeric ceiling
remains identical to `65285dba9`; server gzip still fits by at least 1047 B.
No feature rewrite or gate exemption is introduced.

On the same second-build combined output, swapping only the raw ceiling
247296 → 247808 → 248320 exits **1 → 1 → 0**, repeated twice without a
rebuild. The unchanged feature acceptance suite passes **20/20** on the
refreshed integration. Checker selftests **6/6**, checker tests **13/13**,
parity-gate unit tests **67/67**, lint, typecheck, asset drift and floor
guard pass on the resolved prerequisite. No acceptance test was edited.
This is local measurement, not exact-head CI, feature approval, a completed
full `npm run check`, a browser run, startup measurement or staging proof.
Rollback restores main's 247296 B raw ceiling.

## Second base-conflict reconciliation: unchanged proposal

On 2026-10-23 GitHub reported another conflict, authorizing a merge of main
`02af9e5ef` ([#1467](https://github.com/TogetherWeOwn/two-web-next/pull/1467)).
Only `ci/kit-perf-budget.json` conflicted. The resolution keeps main's full
422-notice decision history and both prerequisite records above, without
repeating their common history. Incoming source and acceptance tests are
unchanged. The PR still differs from main only in budget and this evidence.

Reproduce with the same five-path overlay described above, substituting
`git archive 02af9e5ef` for the main archive. Node `v24.22.1`, fresh external
root/web `npm ci --include=dev` installations and both lockfile hashes are
unchanged. Two builds per tree give:

| Group | Current main 1 | Current main 2 | Current combined 1 | Current combined 2 |
| --- | --- | --- | --- | --- |
| Client JS raw/gzip | 247165/99460 | 247165/99460 | 247930/99710 | 247930/99710 |
| Client JS files | 52 | 52 | 52 | 52 |
| Server JS raw/gzip | 1109636/326237 | 1109638/326238 | 1111152/326737 | 1111152/326735 |
| Server JS files | 122 | 122 | 123 | 123 |
| Worker raw/gzip | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 |
| Client CSS raw/gzip | 2660/891 | 2660/891 | 2660/891 | 2660/891 |

Each pair has identical 52-file client path/hash maps; 50 path/hash pairs
match across trees. The board node remains 3600/1722 → 4365/1972 B
(**+765/+250 B**); app entries remain 5318/1475 B with hash-only relinking.
Client `drizzle-orm` references remain zero. First-build measurements append
to the TSV as `422-main` and `422-combined`; earlier rows are unchanged.

The current combined tree is **634 B over main's 247296 B raw cap** and
**122 B over the initial 247808 B proposal**. The existing **248320 B**
proposal still fits and remains the first fitting 512 B boundary: **390 B
raw and 130 B gzip margins**. No additional allowance is added. Every other
numeric ceiling remains exactly main's. Combined server gzip fits by at
least 943 B; worker, CSS and counts fit. Same-output cap swaps
247296/247808/248320 exit **1/1/0**, twice without rebuilding. The actual
budget-only resolved worktree also builds and passes its budget checker.

Unchanged frozen feature acceptance passes **20/20**. Checker selftests
**6/6**, checker tests **13/13**, parity-gate unit tests **67/67**, config
selftests **34/34**, lint, typecheck, asset drift, Hono asset budgets, docs
links and strict test inventory pass. The incoming error-shell suites report
**31 passed / 29 DB-gated skipped** without a test URL, not complete incoming
acceptance verification. Migration selftests report **23/23** but internally
omit the existing-role collision probe because another suite owns that role.
No acceptance test is edited. Full `npm run check`, browser parity, startup
latency and staging are not run or claimed; exact-head CI and independent
review remain required. Rollback restores main's 247296 B raw cap. The source
feature ref remains untouched.
