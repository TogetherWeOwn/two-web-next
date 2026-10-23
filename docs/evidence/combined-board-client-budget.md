# Combined board-caption and profile-composition budget

Measured 2026-10-22; refreshed 2026-10-23. This is a budget-only prerequisite for
[#1493](https://github.com/TogetherWeOwn/two-web-next/pull/1493), not approval
of that feature. No feature source, test, baseline, lockfile, checker or CI
wiring changes here. The integrated feature still needs exact-head CI and
independent review.

**Current proposal after the fourth base-conflict reconciliation:** raw client JS
250368 B (+512 B vs current main) and gzip client JS 100864 B (+256 B vs
current main). Earlier proposals below are historical. See the final section
for repeated measurements and unchanged guards. The client group fits these
caps, but the integrated feature now independently breaches server gzip and
file-count caps. Those caps remain unchanged here; this client-only prerequisite
is no longer sufficient by itself to make the integrated checker green.

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

## Third base-conflict reconciliation: raw and gzip move

On 2026-10-23 GitHub reported a third conflict, authorizing a merge of main
`114084bf8` ([#1445](https://github.com/TogetherWeOwn/two-web-next/pull/1445)).
Only `ci/kit-perf-budget.json` conflicted. Main raised client raw 247296 to
247808 B for its admin dashboard twin change. The resolution keeps main's
full admin decision history and all three unique prerequisite records, without
repeating their common history. Incoming source and acceptance tests are
unchanged. The PR still differs from main only in budget and this evidence.

Reproduce with the same five-path overlay described above, substituting
`git archive 114084bf8` for the main archive; the overlay applies cleanly
because main touched the admin route, not the board files. Node `v24.22.1`,
fresh external root/web `npm ci --include=dev` installations and both
lockfile hashes are unchanged. Two builds per tree give:

| Group | Current main 1 | Current main 2 | Current combined 1 | Current combined 2 |
| --- | --- | --- | --- | --- |
| Client JS raw/gzip | 247753/99617 | 247753/99617 | 248518/99867 | 248518/99867 |
| Client JS files | 52 | 52 | 52 | 52 |
| Server JS raw/gzip | 1111270/326489 | 1111268/326485 | 1112784/326979 | 1112784/326982 |
| Server JS files | 122 | 122 | 123 | 123 |
| Worker raw/gzip | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 |
| Client CSS raw/gzip | 2737/983 | 2737/983 | 2737/983 | 2737/983 |
| Client CSS files | 2 | 2 | 2 | 2 |

A third build per tree confirms every client, CSS and worker path/byte/hash
row is identical across rebuilds; only server `chunks/instance.js` (+2 B)
and `chunks/internal.js` (hash/gzip wobble) vary, the known build-ID
variation. Across trees, 50 of 52 client path/hash pairs match. The board
node remains 3600/1722 → 4365/1972 B (**+765/+250 B**); the app entry
hash-relinks at identical 5348/1488 B on both sides. Client `drizzle-orm`
references remain zero. First-build measurements append to the TSV as
`admin-main` (177 rows) and `admin-combined` (178 rows); earlier rows are
unchanged.

The current combined tree is **710 B over main's 247808 B raw cap and 27 B
over main's 99840 B gzip cap**, and **198 B over the prior 248320 B
proposal**. The new proposal is **248832 B raw** (+1024 B vs main) and
**100096 B gzip** (+256 B vs main): the first fitting 512/256 B boundaries,
with **314 B raw and 229 B gzip margins**, far below x1.25 (310647/124833).
The gzip move is necessary, not padding: on the same combined output, cap
pairs 247808/99840, 248320/99840, 248832/99840 and 248832/100096 exit
**1/1/1/0**, each twice without rebuilding, and 248832/99840 fails on gzip
alone. Every other numeric ceiling remains exactly main's. Combined server
gzip fits by at least 698 B; worker, CSS and counts fit.

Unchanged frozen feature acceptance passes **20/20** on the refreshed
integration. Checker selftests **6/6**, checker tests **13/13**, parity-gate
unit tests **67/67**, config selftests **34/34**, incoming admin suites
**48/48**, lint, typecheck, asset drift, Hono asset budgets, docs links,
floor guard and strict test inventory (**1116/1116**) pass on the resolved
prerequisite. No acceptance test is edited. The actual budget-only resolved
worktree builds byte-identical client output to the scratch main tree and
passes its checker. Full `npm run check`, browser parity, startup latency
and staging are not run or claimed; exact-head CI and independent review
remain required. Rollback restores main's 247808 B raw and 99840 B gzip
caps. The source feature ref remains untouched.

## Fourth base-conflict reconciliation: client-only scope, server hold

On 2026-10-23 GitHub reported a conflict against main `db0d82bb6`
([#1460](https://github.com/TogetherWeOwn/two-web-next/pull/1460)). Only
`ci/kit-perf-budget.json` conflicted. Main adds the board-filter error boundary
and raises its client caps to 249856/100608 B and server file cap to 124.
The resolution retains main's full decision history and all four unique
prerequisite records, once each. Incoming source and acceptance tests remain
byte-identical to main. The PR diff remains budget/evidence only.

Reproduce with the same five-path frozen overlay described above, substituting
`git archive db0d82bb6`. The overlay applies cleanly: main's new `+error.svelte`
is not one of the overlaid paths. Node `v24.22.1`, fresh external locked
root/web dependencies and both lockfile SHA-256 values remain unchanged.
Three builds per tree give:

| Group | Main 1 | Main 2 | Main 3 | Combined 1 | Combined 2 | Combined 3 |
| --- | --- | --- | --- | --- | --- | --- |
| Client JS raw/gzip | 249333/100464 | 249333/100464 | 249333/100464 | 250098/100715 | 250098/100715 | 250098/100715 |
| Client JS files | 53 | 53 | 53 | 53 | 53 | 53 |
| Server JS raw/gzip | 1113669/327606 | 1113667/327605 | 1113669/327605 | 1115183/328097 | 1115183/328100 | 1115185/328097 |
| Server JS files | 124 | 124 | 124 | 125 | 125 | 125 |
| Worker raw/gzip | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 |
| Client CSS raw/gzip | 2737/983 | 2737/983 | 2737/983 | 2737/983 | 2737/983 | 2737/983 |
| Client CSS files | 2 | 2 | 2 | 2 | 2 | 2 |

The second and third builds have identical client/CSS/worker path, byte and
hash maps; the first client outputs also match those maps. Server variation
is confined to the known `chunks/instance.js` and `chunks/internal.js`
build-ID wobble. The TSV appends **second-build**, not first-build, rows as
`boundary-main` (180 rows) and `boundary-combined` (181 rows). Across trees,
51 of 53 client path/hash pairs match. The board node is now node 27 and
still grows 3600/1722 → 4365/1972 B (**+765/+250 B**). The app entry has
identical raw size 5480 B, but hash relinking changes its gzip 1514 → 1515 B.
Thus the total client delta is **+765/+251 B**, not the earlier +765/+250 B.
Both clients still have zero literal `drizzle-orm` references.

### Client proposal and same-output controls

The combined client breaches main's 249856/100608 B caps by **242 raw / 107
gzip B**. The new proposal **250368 raw / 100864 gzip B** is the first fitting
512/256 B boundary, **+512/+256 B versus main**, with **270/149 B margins**.
It supersedes the previous 248832/100096 B proposal, rather than adding
allowances together. Every non-client-byte ceiling stays exactly main's.

On identical third-build combined output, the following controls run twice
without rebuilding. The overall exit remains **1 in every row** because the
server independently fails; only the client diagnostic changes:

| Client raw/gzip caps | Client result | Overall checker exit |
| --- | --- | --- |
| 249856/100608 | raw and gzip breach | 1 |
| 250368/100608 | gzip breach only | 1 |
| 249856/100864 | raw breach only | 1 |
| 250368/100864 | client group passes | 1 (server only) |

This is client red/green proof, **not an all-group combined green claim**.
The actual budget-only resolved worktree builds and passes all groups under
the proposed budget; it contains main's source, not the frozen feature overlay.

### Newly exposed server prerequisite (not authorized here)

The integrated feature now has **125 server files against 124** and gzip
**328097–328100 B against 327680 B**: **417–420 B over**. Its raw size still
fits 1203200 B. Main itself passes, so this is not a main-red incident.
The new `chunks/captions.js` contributes 349/283 B. The board SSR entry adds
635/~138 B, shared Hono `chunks/src.js` adds 577/~115 B, and
`chunks/members.js` shrinks 45/39 B, plus small build-ID/manifest variations.
No duplicated library explains this; the integration consumes main's remaining
74–75 B of server gzip headroom and the final server file slot.

This PR's scope is the dedicated client-byte decision. It does **not** raise
server gzip, server file count or any other fitting cap to hide that separate
breach. The source feature must resolve the server cost through a verified
reduction or a separately justified, independently reviewed prerequisite,
then consume both changes normally and pass its own exact-head gates. Merging
this client-only prerequisite does not authorize merging the feature.

### Verification and limitations

Unchanged frozen feature acceptance passes **20/20** in the combined archive;
incoming board-filter recovery acceptance passes **29/29** in the resolved
worktree. An initial feature-test command mistakenly ran in the budget-only
worktree and exited 1 with `No test files found`; the corrected command ran
in the overlay and passed. No test file is added or edited by this PR.
Checker selftests **6/6**, checker tests **13/13**, parity-gate unit tests
**67/67** and config selftests **34/34** pass. The additional local gates and
fresh-context review are recorded in the PR. Full `npm run check`, browser
parity, startup latency and staging are not rerun or claimed. Prior-head hosted
CI was green, but does not approve this new head; exact-head CI and independent
review remain required. Rollback restores main's client caps **249856/100608 B**.
The source feature ref remains untouched.
