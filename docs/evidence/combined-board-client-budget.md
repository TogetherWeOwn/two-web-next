# Combined board-caption and profile-composition budget

Measured 2026-10-22; refreshed 2026-10-25. This is a budget-history prerequisite for
[#1493](https://github.com/TogetherWeOwn/two-web-next/pull/1493), not approval
of that feature. No feature source, test, baseline, lockfile, checker or CI
wiring changes here. The integrated feature still needs exact-head CI and
independent review.

**Current decision after the twenty-seventh base-conflict reconciliation:** no additional
client ceiling increase. Every numeric ceiling equals merged base `fcb2b9459`;
main's independently merged allocations are not authored here. Earlier
proposals below are historical, not active allowances. The last repeated
frozen-feature measurements remain pinned to `d6a65b4fa`, which includes the
profile-client reduction from [#1673](https://github.com/TogetherWeOwn/two-web-next/pull/1673):
that client fits, but that union breaches server gzip and file count. The
[latest reconciliation](#twenty-seventh-base-conflict-reconciliation-history-only-limits-equal-base)
verifies history and unchanged ceilings only, not a new build or feature union. Neither
this client decision nor the prerequisite-tree build releases the source
feature's server HOLD or proves it is ready to merge.

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

## Fifth base-conflict reconciliation: client increase withdrawn

On 2026-10-23 GitHub confirmed the fourth reconciliation head was conflicting.
The merged base is pinned to `d6a65b4fa904eb2ab95e6c5033e3c1a481d15319`.
It includes hotzone recovery [#1505](https://github.com/TogetherWeOwn/two-web-next/pull/1505),
the root-lockfile update [#1656](https://github.com/TogetherWeOwn/two-web-next/pull/1656),
and the profile-client reduction [#1673](https://github.com/TogetherWeOwn/two-web-next/pull/1673).
Only `ci/kit-perf-budget.json` conflicts. Preserve main's complete history
verbatim, then the five unique prerequisite records above and this decision.
Incoming source, acceptance tests, lockfiles and baselines stay byte-identical
to that base. The change versus that base remains these three evidence/history
files, with **no numeric ceiling difference**.

Reproduce with `git archive d6a65b4fa`, the same frozen five-path overlay
`git diff 5f4f1c659 723957121b65 -- <five paths>`, and Node `v24.22.1`.
Install root and web dependencies externally with `npm ci --include=dev`,
then link them into both archives. The root lockfile is now SHA-256
`c3be97958e6967ae053106f3639d140b83a585f49295fc11cdcbdf1a23232af9`;
the web lockfile remains
`d02c1ee10d14e72934aa30b9182187d8509facf3bfbe4fa5961d812abcf8c9fc`.
Run `npm --prefix web run build && node ci/check-kit-perf.mjs` in each tree.
No database, credential or remote service is used for these measurements.
An initial archive-setup command used an absolute `git apply --directory`
path and was refused; the prematurely attempted build then lacked dependency
links. Applying from the archive directory and linking the installed dependencies
resolved both setup errors before the successful measurements below.

| Group | Main 1 | Main 2 | Combined 1 | Combined 2 | Base ceiling |
| --- | --- | --- | --- | --- | --- |
| Client JS raw/gzip | 244878/99249 | 244878/99249 | 245648/99511 | 245648/99511 | 251904/101632 |
| Client JS files | 53 | 53 | 53 | 53 | 54 |
| Server JS raw/gzip | 1118342/329330 | 1118342/329329 | 1119856/329842 | 1119856/329842 | 1203200/329472 |
| Server JS files | 126 | 126 | 127 | 127 | 126 |
| Worker raw/gzip | 2551/1219 | 2551/1219 | 2551/1219 | 2551/1219 | 3584/1536 |
| Client CSS raw/gzip | 2737/983 | 2737/983 | 2737/983 | 2737/983 | 3072/1024 |
| Client CSS files | 2 | 2 | 2 | 2 | 4 |
| Overall checker exit | 0 | 0 | 1 | 1 | 0 required |

Both builds per tree have identical client/CSS/worker path, byte and SHA-256
maps. All **730 rows** from both builds are appended to the TSV, labelled
`profile-trim-main-1`, `profile-trim-main-2`, `profile-trim-combined-1` and
`profile-trim-combined-2`. Groups use the existing `client`, `css`, `server`
and `worker` labels; paths are repository-relative emitted-output paths.
Server rebuild hash variation remains confined to `chunks/instance.js` and
`chunks/internal.js`; the 1 B total gzip wobble occurs only on main.

Across trees, **51/53 client path/hash pairs match**. Board structural node
28 changes **3595/1746 → 4365/2008 B (+770/+262 B)**. The app entry only
hash-relinks at **5576/1515 B** on both sides. Thus the complete client delta
is **+770/+262 B**, not the older delta from before main's profile optimization.
Both clients contain zero literal `drizzle-orm` references. There is no new
route or hydration in the frozen overlay.

### No additional client allowance

The refreshed feature fits main's existing client caps by **6256 raw / 2121
gzip B**, with one unused client file slot. The old proposal is withdrawn:
retain main's **251904/101632 B** client caps and **every other numeric
ceiling exactly**. Do not add the historical +512/+256 B again or tighten
main to the obsolete proposal. Existing measured optimization is sufficient;
no speculative feature rewrite is necessary. On the same second-build output,
the unmodified main budget passes the client group twice; the overall checker
remains exit 1 on the independent server breach. No cap-swap green claim is
needed or made when no client cap changes.

### Exact-union server HOLD remains

Main's larger server caps from #1505 do **not** cover this integration: it
still has **127/126 files** and gzip **329842/329472 B (370 B over)** in both
builds. Main passes with **142–143 B** gzip headroom. The new caption chunk
adds **349/283 B**, board SSR adds **635/138 B**, shared Hono `chunks/src.js`
adds **577/130 B**, and `chunks/members.js` shrinks **45/39 B**. Generated
node 28 adds **0/1 B**; the instance chunk shrinks **2 raw B**. These sum to
**+1514 raw / +513 gzip B** on the second-build comparison. Manifest/hash
relinking changes hashes but not the other totals. No server cap changes here.

The complete feature stays held until independently admitted server work
satisfies the checker on its exact then-current union, followed by its own
exact-head CI and independent review. Neither a client-only evidence merge
nor admission-policy adjudication supplies server acceptance or release
permission. The source feature ref was read only and remains untouched.

### Focused verification and limits

The unchanged frozen feature acceptance passes **20/20**. Incoming hotzone,
profile, machine-doc-link and Kit-error suites pass **155 tests**, with **one
existing live-DB test skipped** (no `DATABASE_URL` supplied); no test files are
edited. Checker selftests **6/6**, checker tests **13/13**, parity-gate unit
tests **67/67** and config selftests **34/34** pass. The actual resolved
prerequisite-tree build and additional gates are recorded in the PR body.
Full `npm run check`, browser parity, screenshots, startup latency and staging
are not rerun or claimed. The prior head had green CI and independent review,
but neither approves this new head. All current-head gates still apply.
Rollback reverts only this evidence/history decision; **there is no numeric
ceiling change to undo**. The measurements are pinned to the merged base;
later main movement is not silently represented as a measured union.

## Sixth base-conflict reconciliation: history-only merge

On 2026-10-23 GitHub reported a live conflict on `9ace8f00daa1`, despite
that head's green hosted CI and Paperclip Review. Merge pinned base
`2540adb21d03c0e36eab1ca9fd8c6fbbbdabe106`, resolving only the decision-history
conflict in `ci/kit-perf-budget.json`. Preserve main's complete comment verbatim
and each of the six earlier unique prerequisite records once. All numeric
ceilings equal this merged base. The client increase remains withdrawn.
No source, test, lockfile, baseline, checker or CI wiring differs from it;
the TSV remains the unchanged historical per-file evidence.

This reconciliation intentionally does **not** rerun the frozen feature overlay
or reinterpret the measurements above as measurements of newer main. The task
is a history-only conflict repair, not new server implementation or integration
admission. The source feature/server HOLD remains pending verification of its
own exact then-current union and independent CI/review. In particular, the
older one-file/370-gzip-byte breach is pinned to `d6a65b4fa`, not claimed as the
current size. No source feature ref was modified or pushed.

With Node `v24.22.1` and fresh external locked root/web
`npm ci --include=dev` installs, the actual resolved prerequisite-tree command
`npm --prefix web run build && node ci/check-kit-perf.mjs` passes:

| Group | Actual prerequisite tree | Unchanged base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 243912/98767 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1124086/327995 B | 1203200/329472 B |
| Server JS files | 118 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2737/983 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

This is one actual-tree build, not a repeated determinism or fresh integration
claim. No feature client/server hash rows are added for an unbuilt overlay.
The startup configuration remains 60000 ms, not a latency measurement.
Unchanged checker selftests **6/6**, checker tests **13/13**, parity-gate tests
**67/67**, and config selftests **34/34** pass; lint and root/CI typecheck pass.
Additional guards and the fresh local review are recorded in the PR body.
Full `npm run check`, feature acceptance, browser/visual gates, startup latency
and staging are not rerun in this reconciliation. No user-facing page differs
from the merged base. Prior-head CI/review is not approval of the new head;
all exact-head merge gates remain mandatory. Rollback reverts only the new
history/evidence record, with no numeric ceiling change to undo.

## Seventh base-conflict reconciliation: history-only merge

On 2026-10-23 GitHub reported a live conflict on `85f548dc18e9` against a base
that had advanced six commits past `2540adb21` (server co-compression, security
fixtures, throttle telemetry, calendar reads, RSVP history preservation, and
the check-gate skip). Merge pinned base
`e5ca18422c2457a9938eaee1de38c9ccc4685868`, resolving only the decision-history
conflict in `ci/kit-perf-budget.json`. Main's complete comment stays verbatim,
followed by this prerequisite's unique record once; each side's tail is absent
from the other, so no block is duplicated or dropped. All numeric ceilings
equal this merged base. The client increase remains withdrawn.
No source, test, lockfile, baseline, checker or CI wiring differs from it;
the TSV remains the unchanged historical per-file evidence.

This reconciliation intentionally does **not** rerun the frozen feature overlay
or reinterpret the measurements above as measurements of newer main. The task
is a history-only conflict repair, not new server implementation or integration
admission. The source feature/server HOLD remains pending verification of its
own exact then-current union and independent CI/review. In particular, the
older one-file/370-gzip-byte breach is pinned to `d6a65b4fa`, not claimed as the
current size. No source feature ref was modified or pushed.

With Node `v24.22.1` and fresh external locked root/web
`npm ci --include=dev` installs, the actual resolved prerequisite-tree command
`npm --prefix web run build && node ci/check-kit-perf.mjs` passes:

| Group | Actual prerequisite tree | Unchanged base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 243912/98767 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1124915/328346 B | 1203200/329472 B |
| Server JS files | 118 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2737/983 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

This is one actual-tree build, not a repeated determinism or fresh integration
claim. No feature client/server hash rows are added for an unbuilt overlay.
The startup configuration remains 60000 ms, not a latency measurement.
Unchanged checker selftests **6/6**, checker tests **13/13**, parity suites
**60/60** plus parity citations **12/12**, config selftests **34/34**, bundle
selftest **34/34**, and inventory **1135/1135** pass; lint, root/CI typecheck,
Hono bundle budget, floor guard, asset drift and doc links pass.
Additional guards and the fresh local review are recorded in the PR body.
Full `npm run check`, feature acceptance, browser/visual gates, startup latency
and staging are not rerun in this reconciliation. No user-facing page differs
from the merged base. Prior-head CI/review is not approval of the new head;
all exact-head merge gates remain mandatory. Rollback reverts only the new
history/evidence record, with no numeric ceiling change to undo.

## Eighth base-conflict reconciliation: history-only merge

On 2026-10-23 GitHub reported a live conflict on `fff8984db489` against a base
that had advanced one commit past `e5ca18422` (featured deceptive-link refusal,
#1586). Merge pinned base
`4c5d0c855dcdc716324799491a0129536bbffbf0`, resolving only the decision-history
conflict in `ci/kit-perf-budget.json`. Main's complete comment stays verbatim,
followed by this prerequisite's unique record once; each side's tail is absent
from the other, so no block is duplicated or dropped. All numeric ceilings
equal this merged base. The client increase remains withdrawn.
No source, test, lockfile, baseline, checker or CI wiring differs from it;
the TSV remains the unchanged historical per-file evidence.

This reconciliation intentionally does **not** rerun the frozen feature overlay
or reinterpret the measurements above as measurements of newer main. The task
is a history-only conflict repair, not new server implementation or integration
admission. The source feature/server HOLD remains pending verification of its
own exact then-current union and independent CI/review. In particular, the
older one-file/370-gzip-byte breach is pinned to `d6a65b4fa`, not claimed as the
current size. No source feature ref was modified or pushed.

With Node `v24.22.1` and fresh external locked root/web
`npm ci --include=dev` installs, the actual resolved prerequisite-tree command
`npm --prefix web run build && node ci/check-kit-perf.mjs` passes:

| Group | Actual prerequisite tree | Unchanged base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 244175/98865 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1126356/328882 B | 1203200/329472 B |
| Server JS files | 118 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2737/983 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

This is one actual-tree build, not a repeated determinism or fresh integration
claim. No feature client/server hash rows are added for an unbuilt overlay.
The startup configuration remains 60000 ms, not a latency measurement.
Unchanged checker selftests **6/6**, checker tests **13/13**, parity suites
**67/67** plus parity citations **12/12**, config selftests **34/34**, bundle
selftest **34/34**, gate selftest **6/6**, and inventory **1139/1139** pass;
lint, root/CI typecheck, Hono bundle budget, floor guard, asset drift and doc
links pass. Merged-tree featured suites **318/318** pass. Additional guards
and the fresh local review are recorded in the PR body.
Full `npm run check`, feature acceptance, browser/visual gates, startup latency
and staging are not rerun in this reconciliation. No user-facing page differs
from the merged base. Prior-head CI/review is not approval of the new head;
all exact-head merge gates remain mandatory. Rollback reverts only the new
history/evidence record, with no numeric ceiling change to undo.

## Ninth base-conflict reconciliation: history-only merge

On 2026-10-23 GitHub reported a live conflict on `695b5581924c` against a base
that had advanced three commits past `4c5d0c855` (hotzone chunk-cost record
#1654, board current-period shortcuts #1696, synthetic Kit-event fixtures
#1653). Merge pinned base
`ec313eab043d9a622b3adb7a9f4f119540f25f2d`, resolving only the decision-history
conflict in `ci/kit-perf-budget.json`. Main's complete comment stays verbatim,
followed by this prerequisite's unique record once; each side's tail is absent
from the other, so no block is duplicated or dropped. All numeric ceilings
equal this merged base. The client increase remains withdrawn.
No source, test, lockfile, baseline, checker or CI wiring differs from it;
the TSV remains the unchanged historical per-file evidence.

This reconciliation intentionally does **not** rerun the frozen feature overlay
or reinterpret the measurements above as measurements of newer main. The task
is a history-only conflict repair, not new server implementation or integration
admission. The source feature/server HOLD remains pending verification of its
own exact then-current union and independent CI/review. In particular, the
older one-file/370-gzip-byte breach is pinned to `d6a65b4fa`, not claimed as the
current size. No source feature ref was modified or pushed.

With Node `v24.22.1` and fresh external locked root/web
`npm ci --include=dev` installs, the actual resolved prerequisite-tree command
`npm --prefix web run build && node ci/check-kit-perf.mjs` passes:

| Group | Actual prerequisite tree | Unchanged base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 244777/99107 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1127469/329115 B | 1203200/329472 B |
| Server JS files | 118 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2737/983 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

This is one actual-tree build, not a repeated determinism or fresh integration
claim. No feature client/server hash rows are added for an unbuilt overlay.
The startup configuration remains 60000 ms, not a latency measurement.
Unchanged checker selftests **6/6**, checker tests **13/13**, parity suites
**67/67** plus parity citations **12/12**, config selftests **34/34**, bundle
selftest **34/34**, gate selftest **6/6**, and inventory **1141/1141** pass;
lint, root/CI typecheck, Hono bundle budget, floor guard, asset drift, doc
links (**125** Markdown files) and the internal-ref ratchet pass.
Merged-tree board-shortcut suites **118/118** pass and featured suites report
**655 passed, 189 DB-gated skips, 0 failed** (no live database configured).
Additional guards and the fresh local review are recorded in the PR body.
Full `npm run check`, feature acceptance, browser/visual gates, startup latency
and staging are not rerun in this reconciliation. No user-facing page differs
from the merged base. Prior-head CI/review is not approval of the new head;
all exact-head merge gates remain mandatory. Rollback reverts only the new
history/evidence record, with no numeric ceiling change to undo.

## Tenth base-conflict reconciliation: retain merged allocation, no new allowance

On 2026-10-23 GitHub confirmed a live conflict on `bc60f7153` against pinned
main `2b4f1902e` (seven commits: #1690, #1640, #1650, #1431, #1702,
#1686 and #1652). Only `ci/kit-perf-budget.json` conflicts. Preserve main's
complete comment verbatim, then the prerequisite's unique prior record once;
both tails were verified absent from the opposite side. All numeric ceilings
now equal this merged base. In particular, retain the independently merged
server gzip allocation **333312 B** from #1686, rather than restore the older
329472 B or add another allowance. The obsolete client increase remains
withdrawn. No source, tests, lockfiles, baselines, checker or CI wiring differ
from that base; the historical per-file TSV is unchanged.

This is a conflict repair, not refreshed feature-union admission. The frozen
feature overlay was not rebuilt. The old one-file/370-gzip-byte breach remains
pinned to `d6a65b4fa`, not asserted for this new base. The separately merged
server allocation is not proof that the source feature's exact union fits.
Keep the source feature/server HOLD until its own then-current union and
independent CI/review satisfy the gates. No source feature ref was modified
or pushed.

With Node `v24.22.1` and fresh external locked root/web
`npm ci --include=dev` installs, the actual resolved prerequisite-tree command
`npm --prefix web run build && node ci/check-kit-perf.mjs` passes:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 245331/99255 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1129528/328711 B | 1203200/333312 B |
| Server JS files | 117 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2878/1024 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

This is one actual-tree build, not repeated determinism or a feature-overlay
measurement. CSS gzip is exactly at its unchanged ceiling: zero margin is
reported, not loosened. Startup 60000 ms is configuration, not measured latency.
Unchanged checker selftests **6/6**, checker tests **13/13**, parity suites
**67/67**, config selftests **34/34**, gate selftest **6/6**, bundle selftest
**34/34**, parity citations **12/12**, and inventory **1151/1151** pass.
Lint, root/CI typecheck, asset drift, Hono bundle budget, floor guard, docs
links (**129 Markdown files**) and the internal-ref ratchet pass. No acceptance
test files were edited. Full `npm run check`, fresh feature acceptance,
browser/visual/quality gates, startup latency and staging were not rerun.
No user-facing page differs from the merged base. Prior-head green CI/review
is not approval of the new head; all exact-head merge gates remain mandatory.
Rollback reverts only this new history/evidence reconciliation relative to
the merged base; it must not undo the independent allocation from #1686.

## Eleventh base-conflict reconciliation: consume canonical dependency repair, no new allowance

On 2026-10-24 GitHub confirmed a live conflict on `b2bbe5d56` against pinned
main `4e9bf0a5d` (two commits: #1716 and #1712). Only
`ci/kit-perf-budget.json` conflicts. All numeric ceilings are byte-equal on
all three sides, so the resolution is history-only: base comment verbatim,
then main's unique tail, then the prerequisite's unique record once. Each
tail was verified absent from the opposite side and each record appears
exactly once in the merged comment. Every numeric ceiling equals the merged
base, including the independently merged server gzip allocation **333312 B**
from #1686. The obsolete client increase stays withdrawn.

The merge queue had ejected the prior head for the shared dependency-audit
failure: newly published high-severity advisories reject the old locks.
#1716 is the canonical repair (patched Lighthouse BiDi/Zod chain, patched
body-parser majors, Undici 7.30.1 in both lockfiles). This prerequisite
consumes it verbatim: root/web lockfiles, manifests and
`test/performance-ci.test.ts` are taken exactly as merged main, with no
allowance, exception, source, test, baseline, checker or CI-wiring change
authored here. The `#1712` RSVP evidence file is likewise main's verbatim
file. The historical per-file TSV is unchanged.

Red-before/green-after with the unchanged `npm run deps:audit` gate: the
pre-merge locks exit 1 with **10** root and **4** web high-severity rows
(Zod, body-parser and Undici families); the merged tree exits 0 with zero
blocked findings in either lockfile. Dependency-audit selftests **56/56**
pass on the merged tree.

This is a conflict repair, not refreshed feature-union admission. The frozen
feature overlay was not rebuilt. The old one-file/370-gzip-byte breach
remains pinned to `d6a65b4fa`, not asserted for this new base. Separately
merged allocations are not proof that the source feature's exact union fits.
Keep the source feature/server HOLD until its own then-current union and
independent CI/review satisfy the gates. No source feature ref was modified
or pushed.

With Node `v24.22.1` and fresh locked root/web `npm ci --include=dev`
installs, two actual-tree `npm --prefix web run build` runs both pass
`node ci/check-kit-perf.mjs`:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 245331/99255 B | 251904/101632 B |
| Client JS files | 53 | 54 |
| Server JS raw/gzip | 1129530/328710 B | 1203200/333312 B |
| Server JS files | 117 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2878/1024 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

A repeat build of the same tree reports server gzip 328711 B instead of
328710 B: plus-or-minus 1 B of gzip nondeterminism between identical-tree
builds, with thousands of bytes of margin on every ceiling. Both builds
exit 0. CSS gzip is exactly at its unchanged ceiling: zero margin is
reported, not loosened. Startup 60000 ms is configuration, not measured
latency. Unchanged checker selftests **6/6**, checker tests **13/13**,
parity suites **67/67**, config selftests **34/34**, gate selftest **6/6**,
bundle selftest **34/34**, parity citations **12/12**, inventory
**1151/1151**, and the merged-base performance suite **43/43** pass. Lint,
root/CI typecheck, asset drift, Hono bundle budget, floor guard, docs
links (**130 Markdown files**) and the internal-ref ratchet pass. No
acceptance test files were edited. Full `npm run check`, fresh feature
acceptance, browser/visual/quality gates, startup latency and staging were
not rerun. No user-facing page differs from the merged base. Prior-head
green CI/review is not approval of the new head; all exact-head merge gates
remain mandatory. Rollback reverts only this new history/evidence
reconciliation relative to the merged base; it must not undo the
independent allocation from #1686 or the canonical repair from #1716.

## Twelfth base-conflict reconciliation: absorb home/admin main-side work, no new allowance

On 2026-10-24 GitHub confirmed a live conflict on `db0898b43` against pinned
main `ee34b8e79` (two commits: #1698 admin read-retry and #1519 home
failure-recovery). Only `ci/kit-perf-budget.json` conflicts. All numeric
ceilings are byte-equal on all three sides, so the resolution is history-only:
base comment verbatim, then main's unique tail, then the prerequisite's unique
record once. Each tail was verified absent from the opposite side and each
record appears exactly once in the merged comment. Every numeric ceiling
equals the merged base. The obsolete client increase stays withdrawn. The
main-side feature files (home/admin routes, styles, tests, evidence) are
taken verbatim as merged; no allowance, exception, source, test, baseline,
checker or CI-wiring change is authored here. The historical per-file TSV is
unchanged.

This is a conflict repair, not refreshed feature-union admission. The frozen
feature overlay was not rebuilt. The old one-file/370-gzip-byte breach
remains pinned to `d6a65b4fa`, not asserted for this new base. Separately
merged allocations are not proof that the source feature's exact union fits.
Keep the source feature/server HOLD until its own then-current union and
independent CI/review satisfy the gates. No source feature ref was modified
or pushed.

With Node `v24.22.1` and fresh locked root/web `npm ci --include=dev`
installs, two actual-tree `npm --prefix web run build` runs both pass
`node ci/check-kit-perf.mjs`:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 246772/99953 B | 251904/101632 B |
| Client JS files | 54 | 54 |
| Server JS raw/gzip | 1131167/328484 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

A repeat build of the same tree reports server gzip 328489 B instead of
328484 B: plus-or-minus 5 B of gzip nondeterminism between identical-tree
builds, with thousands of bytes of margin on every ceiling. Both builds
exit 0. Client output is byte-identical between rebuilds. Startup 60000 ms
is configuration, not measured latency. Unchanged checker selftests **6/6**,
checker tests **13/13**, parity suites **67/67**, config selftests **34/34**,
gate selftest **6/6**, bundle selftest **34/34**, parity citations **12/12**,
inventory **1157/1157**, merged-base performance suite **43/43** and
dependency-audit selftests **56/56** pass; `npm run deps:audit` exits 0 with
zero blocked findings. Lint, root/CI typecheck, asset drift, Hono bundle
budget, floor guard, docs links (**132 Markdown files**) and the
internal-ref ratchet pass. `context-pack --base origin/main` reports 0
changed symbols. No acceptance test files were edited. Full `npm run check`,
fresh feature acceptance, browser/visual/quality gates, startup latency and
staging were not rerun. No user-facing page differs from the merged base.
Prior-head green CI/review is not approval of the new head; all exact-head
merge gates remain mandatory. Rollback reverts only this new history/evidence
reconciliation relative to the merged base; it must not undo the independent
allocation from #1686 or the canonical repair from #1716.

## Thirteenth base-conflict reconciliation: absorb soft-answer/calendar/event main-side work, no new allowance

On 2026-10-24 GitHub confirmed a live conflict on `a05462df` against pinned
main `c0e1582bd` (thirteen commits: #1463 RSVP soft-answer event page, #1717
Lighthouse Zod removal, #1723 admin inventory recovery, #1729 ZAP retry
verdicts, #1657 home teaser grouping, #1720 staging journey receipts, #1724
patch-coverage evidence, #1730 privacy policy history, #1701 adjacent event
previews, #1722 calendar phase attribution, #1647 Kit payload contract,
#1726 calendar recovery allocation, plus the #1710 FAQ stamp). Only
`ci/kit-perf-budget.json` conflicts: #1463 is the sole main-side commit that
touches it, appending its preserved soft-answer history. All numeric ceilings
are byte-equal on all three sides, so the resolution is history-only: base
comment verbatim, then main's unique tail, then the prerequisite's unique
record once. Each tail was verified absent from the opposite side and each
appears exactly once in the merged comment. Main's file encodes non-ASCII as
`\uXXXX` escapes (from the #1463 merge) while the base used literal UTF-8;
the resolution matches the main tip's exact encoding (`indent=2`,
`ensure_ascii=True`, round-trip verified byte-identical on the unmodified
object), so the file diff against the main tip is the single `$comment` line
and purely additive. Every numeric ceiling equals the merged base. The
obsolete client increase stays withdrawn. The main-side feature files are
taken verbatim as merged; no allowance, exception, source, test, baseline,
checker or CI-wiring change is authored here. The historical per-file TSV is
unchanged. While verification ran, main advanced by one commit (#1721
auth-perf probe settlement, 8 files, no budget touch); it was absorbed in a
second conflict-free merge, and every suite below was rerun on that final
tree.

This is a conflict repair, not refreshed feature-union admission. The frozen
feature overlay was not rebuilt. The old one-file/370-gzip-byte breach
remains pinned to `d6a65b4fa`, not asserted for this new base. Separately
merged allocations are not proof that the source feature's exact union fits.
Keep the source feature/server HOLD until its own then-current union and
independent CI/review satisfy the gates. No source feature ref was modified
or pushed.

With Node `v24.22.1` and fresh locked root/web `npm ci --include=dev`
installs, three actual-tree `npm --prefix web run build` runs (two before the
tip merge, one after) all pass `node ci/check-kit-perf.mjs`:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 249082/100853 B | 251904/101632 B |
| Client JS files | 54 | 54 |
| Server JS raw/gzip | 1140501/324289 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

Client output is byte-identical across all three builds. Server gzip reads
324290/324290/324289 B: 1 B of identical-tree gzip nondeterminism. Startup
60000 ms is configuration, not measured latency. Unchanged checker selftests
**6/6**, checker tests **13/13**, parity file suites **67/67**, parity gate
runner **81 passed / 0 failed**, config selftests **34/34**, gate selftest
**6/6**, bundle selftest **34/34** plus a fitting Hono budget, parity
citations **12/12**, inventory **1181/1181**, auth-perf selftest **19 cases**
plus file suites **12/15/2/10/46/8**, Kit-payload selftests plus **17/17**
with `--static-only` ok, proxy-peer selftest **10** plus check ok,
patch-coverage selftest **7** plus acceptance **266/266** and edge **15/15**,
and dependency-audit selftests **56/56** pass; `npm run deps:audit` exits 0
with zero blocked findings. Lint (**1947 files**), root/CI typecheck, asset
drift, floor guard, docs links (**137 Markdown files**), ratchet unit tests
**27/27** and the `--base origin/main --head HEAD` ratchet scan pass.
`context-pack --base origin/main` reports 0 changed symbols. No acceptance
test files were edited. Full `npm run check`, fresh feature acceptance,
browser/visual/quality gates, startup latency and staging were not rerun. No
user-facing page differs from the merged base. Prior-head green CI/review is
not approval of the new head; all exact-head merge gates remain mandatory.
Rollback reverts only this new history/evidence reconciliation relative to
the merged base; it must not undo the independent allocations from #1686 and
#1726, the canonical repair from #1716, or any absorbed main-side feature.

## Fourteenth base-conflict reconciliation: absorb events/markdown/admin/archive main-side work plus calendar tip, no new allowance

On 2026-10-24 GitHub confirmed a live conflict on `9da17fc43` against pinned
main `6003f577f` (five commits: #1630 duplicate-event drafts, #1737 markdown
host/join details, #1693 admin save feedback, #1699 archive detail return,
#1655 admin-review budget reconcile). Only `ci/kit-perf-budget.json` conflicts:
#1655 is the sole main-side commit that touches it. Unlike prior rounds, the
numerics are not identical on all three sides: #1655's own merged allocation
raises client `maxFiles` 54→55 next to its history record. The resolution
therefore takes the main tip's numerics verbatim and composes the comment as
base verbatim, then main's unique tail, then the prerequisite's unique record
once. Each tail was verified absent from the opposite side on the raw escaped
text and each appears exactly once in the merged comment. All three sides use
`\uXXXX` escapes with zero literal non-ASCII characters, so the file diff
against the main tip is the single `$comment` line and purely additive. Every
numeric ceiling equals the merged base, including the independently merged
#1655 file-count step. The obsolete client increase stays withdrawn; no
allowance is authored here. Main-side feature files are taken verbatim as
merged; no source, test, baseline, checker or CI-wiring change is authored
here. The historical per-file TSV is unchanged. While verification ran, main
advanced by one commit (#1735 calendar game-scope subscriptions, 23 files, no
budget or lockfile touch); it was absorbed in a second conflict-free merge,
and every suite below was rerun on that final tree.

This is a conflict repair, not refreshed feature-union admission. The frozen
feature overlay was not rebuilt. The old one-file/370-gzip-byte breach
remains pinned to `d6a65b4fa`, not asserted for this new base. Separately
merged allocations are not proof that the source feature's exact union fits.
Keep the source feature/server HOLD until its own then-current union and
independent CI/review satisfy the gates. No source feature ref was modified
or pushed.

With Node `v24.22.1` and fresh locked root/web `npm ci --include=dev`
installs, three actual-tree `npm --prefix web run build` runs on the final
tree all pass `node ci/check-kit-perf.mjs`:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 250421/101390 B | 251904/101632 B |
| Client JS files | 54 | 55 |
| Server JS raw/gzip | 1148190/326133 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 | 0 required |

Client output is byte-identical across all three builds. Server raw is stable
at 1148190 B; server gzip reads 326134/326133/326133 B: 1 B of identical-tree
gzip nondeterminism. Client margins are 1483 B raw and 242 B gzip; CSS gzip
keeps 5 B under its unchanged 1024 B limit. Startup 60000 ms is
configuration, not measured latency. Unchanged checker selftests **6/6**,
checker tests **13/13**, parity file suites **67/67**, parity gate runner
**81 passed / 0 failed**, config selftests **34/34**, gate selftest **6/6**,
bundle selftest **34/34** plus a fitting Hono budget, parity citations
**12/12**, inventory **1193/1193**, auth-perf selftest **19 cases** plus file
suites **12/15/2/10/46/8**, Kit-payload selftests plus **17/17** with the
check ok, proxy-peer selftest **10** plus check ok, patch-coverage selftest
**7** plus acceptance **266/266** and edge **15/15**, dependency-audit
selftests **56/56** plus `npm run deps:audit` exit 0 with zero blocked
findings, `test/performance-ci.test.ts` **43/43**, new-base-area vitest suites
**144 passed / 73 DB-gated skips / 0 failed**, and the machine-contract check
pass. Lint (**1967 files**), root/CI typecheck, asset drift, floor guard, docs
links (**140 Markdown files**), ratchet unit tests **27/27** and the
`--base origin/main --head HEAD` ratchet scan pass.
`context-pack --base origin/main` reports 0 changed symbols in 0 files. No
acceptance test files were edited. Full `npm run check`, fresh feature
acceptance, browser/visual/quality gates, startup latency and staging were
not rerun. No user-facing page differs from the merged base. Prior-head green
CI/review is not approval of the new head; all exact-head merge gates remain
mandatory. Rollback reverts only this new history/evidence reconciliation
relative to the merged base; it must not undo the independent allocations
from #1655, #1686 and #1726, the canonical repair from #1716, or any absorbed
main-side feature.

## Fifteenth base-conflict reconciliation: retain accessibility history, limits unchanged

On 2026-10-24 GitHub confirmed a live conflict on `3c3f98a34` against pinned
main `509cb40a7` (three commits: #1746 cancelled-event RSS signalling, #1748
independent Lighthouse navigation samples, and #1677 accessibility allocation
history). Only `ci/kit-perf-budget.json` conflicts. All numeric values are
identical on the merge base, branch head and incoming main. Each parsed
comment starts with the common-base comment; both unique tails were verified
absent from the opposite side. Resolution takes main's complete JSON and
appends the branch-only tail exactly once. Both tails occur once in the
result; the ASCII JSON encoding matches main. Against pinned main the budget
diff is one additive comment line; every non-comment value stays identical.
All other main-side source, test, lockfile, configuration and evidence changes
are retained verbatim. The original client increase stays withdrawn. The
historical per-file TSV is unchanged by this reconciliation.

This is history reconciliation, not refreshed feature-union admission. No
frozen-feature overlay was built or feature ref changed. The last repeated
union breach remains pinned to `d6a65b4fa` (127/126 server files, 370 gzip
bytes over), not asserted for this newer base. Keep the source feature/server
HOLD until its own then-current union and exact-head CI/review satisfy every
gate; this prerequisite's success is not release permission.

With Node `v24.22.1`, fresh external locked root/web `npm ci --include=dev`
installs and two actual-tree `npm --prefix web run build` runs, unchanged
`node ci/check-kit-perf.mjs` exits **0** both times:

| Group | Actual prerequisite tree | Unchanged merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 250421/101390 B | 251904/101632 B |
| Client JS files | 54 | 55 |
| Server JS raw/gzip | 1148524/326248–326250 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 twice | 0 required |

Client-output path/hash maps match across both builds; server gzip differs by
2 B. Client margins remain 1483 B raw/242 B gzip, CSS gzip 5 B. Startup
60000 ms remains a configured bound, not measured latency.

Fresh checks: checker selftests **6/6**, checker tests **13/13**, parity file
suites **67/67**, config **34/34**, gate **6/6**, bundle selftest **34/34** and
Hono budget pass. Incoming Lighthouse Vitest suites **209/209**, with the
separate Node evidence/origin suites **70/70**, and RSS-neighbor Vitest suites
**83 passed / 20 DB-gated skips / 0 failed** pass without test edits. The first
Lighthouse invocation incorrectly sent four Vitest files to `node --test`:
those four failed to initialize their runner, while the 70 Node tests passed.
Running the four unchanged files with `npx vitest run` passes all 209 tests;
no product correction or retry of red CI was involved.

Lint (**1970 files**), root/CI typecheck, asset drift, inventory
**1195/1195**, docs links (**12/12** citations, **140** Markdown files),
ratchet unit tests **27/27**, and `npm run deps:audit` (exit **0**, zero
blocked findings in both lockfiles) pass. No new dependency/audit change or
red-before proof is claimed. Full `npm run check`, fresh feature acceptance,
browser/visual/quality gates, startup latency and staging were not rerun.
No user-facing page differs from pinned main. All exact-head CI and
independent review gates remain required. Rollback reverts only this
history/evidence reconciliation relative to main, not any independently
merged allocation, dependency repair or feature.

## Sixteenth base-conflict reconciliation: absorb visual-accept roster gzip-reconcile and security-pin main-side work, limits equal base

On 2026-10-24 GitHub confirmed a live conflict on `4b7bf0650` against pinned
main `dd841a1ae` (four commits: #1742 visual-accept CLI safety, #1757 RSVP
roster status facet, #1761 inventory-return client-gzip reconcile, and #1736
Host-admission/CSP security-pin contracts). Only `ci/kit-perf-budget.json`
conflicts. Like the fourteenth round, numerics are not identical: main-side
#1761 moves client `maxGzipBytes` one 256 B step, 101632 to 101888, while the
branch head has zero numeric diffs against the merge base. Resolution takes
main's complete JSON verbatim and appends the branch-only tail exactly once.
Each parsed comment starts with the common-base comment; both unique tails
were verified absent from the opposite side and occur once in the result, so
the file equals base comment + main tail + branch record. All other 62
main-side files are blob-equal to pinned main. The original client increase
stays withdrawn. The historical per-file TSV is unchanged by this
reconciliation.

This is history reconciliation, not refreshed feature-union admission. No
frozen-feature overlay was built or feature ref changed. The last repeated
union breach remains pinned to `d6a65b4fa` (127/126 server files, 370 gzip
bytes over), not asserted for this newer base. Keep the source feature/server
HOLD until its own then-current union and exact-head CI/review satisfy every
gate; this prerequisite's success is not release permission.

With Node `v24.22.1`, installed locked root/web dependencies (lock SHA-256
verified byte-identical to pinned main:
`131c46575f340d700c1c3dd414c64d403289042b77fbaf7ec7e7a3d9449437e0` /
`feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`)
and two actual-tree `npm --prefix web run build` runs, unchanged
`node ci/check-kit-perf.mjs` exits **0** both times:

| Group | Actual prerequisite tree | Merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 251164/101622 B | 251904/101888 B |
| Client JS files | 54 | 55 |
| Server JS raw/gzip | 1151948/326918–326920 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 twice | 0 required |

Client-output path/hash maps match across both builds; server gzip differs by
2 B. Client margins are 740 B raw/266 B gzip, CSS gzip 5 B. Startup
60000 ms remains a configured bound, not measured latency.

Fresh checks: checker selftests **6/6**, checker tests **13/13**, parity file
suites **67/67**, config **34/34**, gate **6/6**, bundle selftest **34/34** and
Hono budget pass. New-area suites for the absorbed main-side work pass without
test edits: security-pins selftest **37/37** plus tests **16/16** and checker
ok (4 static pins, suites 93/93), visual-accept Node tests **48/48**, and
Vitest **204/204** across the roster-status, visual-accept-CLI,
host-admission and inline-style suites. Floor guard is clean with selftests
**59/59**.

Lint (**1979 files**), root/CI typecheck, asset drift, inventory
**1200/1200**, docs links (**12/12** citations, **142** Markdown files),
ratchet unit tests **27/27** plus the base-to-head scan, and
`npm run deps:audit` (exit **0**, zero blocked findings in both lockfiles)
pass. `context-pack --base origin/main` errored twice locally (MCP server
exited, no pack produced); the branch diff touches no functions (budget JSON
comment plus this evidence file only), so no caller updates apply. Full
`npm run check`, fresh feature acceptance, browser/visual/quality gates,
startup latency and staging were not rerun. No user-facing page differs from
pinned main. All exact-head CI and independent review gates remain required.
Rollback reverts only this history/evidence reconciliation relative to main,
not any independently merged allocation (#1761 included), dependency repair
or feature.

## Seventeenth base-conflict reconciliation: preserve the restored-write allocation, limits equal base

On 2026-10-24 GitHub confirmed the live conflict on `3ed7a6e8e` against
pinned main `e046a2040` (one commit, #1669's restored-write-banner allocation).
Only `ci/kit-perf-budget.json` changed on main. The branch has no numeric
delta against common base `dd841a1ae`; resolution takes main's numbers
verbatim: client raw 251904 to 253440 B and gzip 101888 to 102400 B are
#1669's independent allocation, not a new proposal here. Every other cap is
unchanged. The original board-client increase remains withdrawn.

Programmatic assertions verify the common comment prefix (347547 characters),
main's unique suffix (43315 characters) and this branch's unique suffix
(10900 characters). Each suffix is absent from the opposite side and appears
exactly once in the result: common base + main suffix + branch suffix. The
result preserves main's JSON representation with one additive comment-line
diff against main; every non-comment value equals main. No source, test,
lockfile, baseline, checker, workflow or historical per-file TSV changes.

Two fresh locked production builds on Node `v24.22.1` / npm `11.19.1`, using
external root/web dependencies, pass the unchanged checker (exit **0** twice):

| Group | Actual prerequisite tree | Merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 251164/101622 B | 253440/102400 B |
| Client JS files | 54 | 55 |
| Server JS raw/gzip | 1151946–1151948/326919 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 twice | 0 required |

All 54 client path/hash pairs match across rebuilds. Client margins are
2276 raw / 778 gzip B; CSS gzip margin remains 5 B. Root/web lock SHA-256s
remain `131c46575f340d700c1c3dd414c64d403289042b77fbaf7ec7e7a3d9449437e0`
and `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`,
byte-identical to pinned main. Startup 60000 ms is a configured bound, not a
latency measurement.

Fresh verification: checker selftest **6/6**; focused Node suites (checker,
parity, config and citation files) **107/107**; Hono bundle selftest **34/34**,
Hono budget and parity-gate selftest **13/13** pass. Lint **1979 files**,
root/CI typecheck, asset drift, floor guard plus **59/59** selftests,
inventory **1200/1200**, ratchet **27/27** plus scan, and dependency-audit
selftests **56/56** plus audit exit **0** pass. Docs links pass with **12/12**
citation tests and **142** Markdown files; aggregate gate selftests pass
**6/6**. `context-pack --base origin/main` failed with `RuntimeError: MCP
server exited`; no pack was produced. No functions differ from pinned main,
so no caller updates apply. Optional routed arithmetic review failed response
schema validation and supplied no verdict. Fresh-context local review found
no blocking issues, not hosted merge approval. No new audit repair or
red-before result is claimed. Full `npm run check`, fresh feature union or
acceptance, browser/visual/quality gates, startup latency and staging were
not rerun. No page differs from pinned main. The older union's server breach
remains pinned to `d6a65b4fa`, not asserted for current main; source-feature
server HOLD and its own exact-head CI/review remain mandatory. Rollback is
history/evidence only relative to main; do not undo #1669's allocation.

## Eighteenth base-conflict reconciliation: absorb config-warning record and fifteen main-side commits, limits equal base

On 2026-10-25 GitHub confirmed the live conflict on `2a666e47` against
pinned main `8df87c89f` (fifteen commits: #1697, #1707, #1706, #1718, #1741,
#1731, #1709, #1745, #1725, #1747, #1754, #1762, #1743, #1750, #1680). Only
#1680 changed `ci/kit-perf-budget.json` on main, appending its config-warning
record; the other fourteen commits touch sources, tests, CI wiring and docs.
The branch has no numeric delta against common base `e046a2040`; resolution
takes main's numbers verbatim. Every cap equals merged main, including #1669's
independent client raw 253440 / gzip 102400 allocation (not authored here).
The original board-client increase remains withdrawn.

Programmatic assertions verify the common comment prefix (390862 characters),
main's unique suffix (20571 characters) and this branch's unique suffix
(10900 characters). Each suffix is absent from the opposite side and appears
exactly once in the result: common base + main suffix + branch suffix. The
result preserves main's JSON representation (`\uXXXX` escaping, 2-space
indent, trailing newline) with one additive comment-line diff against main;
every non-comment value equals main. The merged tree differs from main in
exactly three files: the budget JSON and these two evidence docs. No source,
test, lockfile, baseline, checker or historical per-file TSV changes.

Two fresh locked production builds on Node `v24.22.1` / npm `11.19.1`, using
fresh root/web `npm ci --include=dev` installations (prior run's symlinked
deps had expired), pass the unchanged checker (exit **0** twice, byte-identical
across rebuilds):

| Group | Actual prerequisite tree | Merged-base ceiling |
| --- | --- | --- |
| Client JS raw/gzip | 253204/102307 B | 253440/102400 B |
| Client JS files | 54 | 55 |
| Server JS raw/gzip | 1160018/329218 B | 1203200/333312 B |
| Server JS files | 115 | 126 |
| Worker raw/gzip | 2551/1219 B | 3584/1536 B |
| Client CSS raw/gzip | 2861/1019 B | 3072/1024 B |
| Client CSS files | 2 | 4 |
| Overall checker exit | 0 twice | 0 required |

All 54 client path/hash pairs match across rebuilds. Client margins are
236 raw / 93 gzip B; CSS gzip margin remains 5 B. These thin margins are
main's own #1669 allocation, not a new proposal here. Root/web lock SHA-256s
remain `131c46575f340d700c1c3dd414c64d403289042b77fbaf7ec7e7a3d9449437e0`
and `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`,
byte-identical to pinned main. Startup 60000 ms is a configured bound, not a
latency measurement.

Fresh verification: checker selftest **12/12** (grew from 6 via main-side
#1745 canonical-inventory cases) plus checker tests **13/13**; parity gates
selftest **13/13** plus parity suites **67/67**; config **34/34**; Hono bundle
selftest **34/34**; aggregate gate selftest **6/6**; citations **12/12**.
Lint (**2018 files**), root/CI typecheck, asset drift, floor guard plus
**59/59** selftests, inventory **1226/1226**, ratchet **27/27** plus scan, and
dependency-audit selftests **56/56** plus audit exit **0** pass. Docs links
pass (**150** Markdown files). `context-pack --base origin/main` failed with
`RuntimeError: MCP server exited` (same as prior runs); no pack was produced.
The diff touches no functions, so no caller updates apply. Fresh-context
local review found no blocking issues, not hosted merge approval. The Hono
worker-bundle check was not run (needs a wrangler dry-run bundle; the Kit
checker already enforces the `_worker.js` entry). Full `npm run check`, fresh
feature union or acceptance, browser/visual/quality gates, startup latency
and staging were not rerun. No page differs from pinned main. The older
union's server breach remains pinned to `d6a65b4fa`, not asserted for current
main; source-feature server HOLD and its own exact-head CI/review remain
mandatory. Rollback is history/evidence only relative to main; do not undo
#1669's allocation.

## Twenty-fourth base-conflict reconciliation: history only, limits equal base

GitHub confirmed a base conflict on `3550ecfed`. Merged pinned main
`853f954bdf7b2c851b14185d58157b217e4454d7`, containing
[#1755](https://github.com/TogetherWeOwn/two-web-next/pull/1755) and
[#1692](https://github.com/TogetherWeOwn/two-web-next/pull/1692). The sole
conflict was the budget comment. Preserve the common history (560802
characters), main's unique suffix (22818) and this branch's unique suffix
(10900), in that order, for 594520 characters. Each suffix is absent from
the opposite input and occurs exactly once in the result. All non-comment
JSON values equal main; main and this branch also had equal numeric values
before the merge. No new allowance. Preserve main's ASCII-escaped JSON.

Two fresh external root/web `npm ci --include=dev` installs use unchanged
merged lockfiles and Node `v24.22.1`. Two `npm --prefix web run build` runs,
each followed by unchanged `node ci/check-kit-perf.mjs`, exit **0**:

| Group | Build 1 raw/gzip | Build 2 raw/gzip | Main ceiling raw/gzip |
| --- | --- | --- | --- |
| Client JS (54/55 files) | 253330/102135 B | 253330/102135 B | 254464/102912 B |
| Server JS (115/126 files) | 1174982/332941 B | 1174982/332938 B | 1203200/333568 B |
| Worker entry | 2551/1219 B | 2551/1219 B | 3584/1536 B |
| Client CSS (2/4 files) | 2833/1006 B | 2833/1006 B | 3072/1024 B |

All 54 client JS path/hash pairs match; zero literal `drizzle-orm` client
references. Margins: client 1134 raw / 777 gzip B, server 627–630 gzip B,
CSS 18 gzip B. Server gzip varies by 3 B; not fully deterministic. Startup
60000 ms is configured, not measured latency. These are actual prerequisite
tree measurements, not fresh frozen-feature-union measurements. The TSV
retains its historical measurements; no new rows are implied.

Fresh checks: unchanged Node checker/parity/config/citation suites
**100/100**, Kit checker selftest **12/12**, Hono bundle selftest **34/34**,
performance gate **6/6**, parity selftest **13/13**. Lint **2055 files**,
root/CI and E2E types, assets, Hono budgets, floor guard, inventory
**1246/1246** plus Playwright **54/54**, docs **159** Markdown files, ratchet
**27/27** plus scan, and dependency audit **exit 0** with zero blocked rows
in either lock pass. Incoming timezone/formatter/theme fixtures **67 pass,
48 browser-gated skips**, native-browser wiring **16/16**; no live browser
proof is claimed. Database variables were unset for these fixture checks.
No test files were edited here; all incoming non-budget paths equal main.

`context-pack --base origin/main` failed with `RuntimeError: MCP server
exited`; no pack produced. The three-path PR diff has no changed functions
or callers. Memory recall and the optional routed arithmetic check failed
response-schema validation and supplied no usable result; arithmetic is
directly asserted. Full `npm run check`, fresh feature union/acceptance,
browser parity, visual/quality gates, Hono worker dry-run, measured startup
and staging were not rerun. No user-facing page differs from main.
Exact-head CI and independent hosted review remain required. Source feature
ref is untouched; its server HOLD persists. UNDO: revert our history and
evidence only, never main's independent allocations or security repairs.

## Twenty-fifth base-conflict reconciliation: history only, limits equal base

GitHub confirmed a base conflict on `04d4081e1`. Merged pinned main
`847bf4647def72aebcb84d1defa9ec8726afa207`, including
[#1758](https://github.com/TogetherWeOwn/two-web-next/pull/1758) and
[#1518](https://github.com/TogetherWeOwn/two-web-next/pull/1518). The only
conflict was the budget comment. Common history (583620 characters) + main's
unique suffix (14776) + branch-only suffix (10900) = 609296 characters.
Each suffix is absent from the opposite input and retained once. All
non-comment values equal main and were equal on both sides before merging.
No new allowance; main's ASCII-escaped JSON representation is preserved.

Two fresh external locked root/web dependency installations, Node
`v24.22.1`, and two `npm --prefix web run build` runs followed by unchanged
`node ci/check-kit-perf.mjs` give **exit 0 twice**:

| Group | Build 1 raw/gzip | Build 2 raw/gzip | Main ceiling raw/gzip |
| --- | --- | --- | --- |
| Client JS (54/55 files) | 253949/102273 B | 253949/102273 B | 254464/102912 B |
| Server JS (115/126 files) | 1176054/333152 B | 1176054/333150 B | 1203200/333568 B |
| Worker entry | 2551/1219 B | 2551/1219 B | 3584/1536 B |
| Client CSS (2/4 files) | 2833/1006 B | 2833/1006 B | 3072/1024 B |

All 54 client JS path/hash pairs match; no literal `drizzle-orm` client
reference. Margins: client 515 raw / 639 gzip B, server 416–418 gzip B,
CSS 18 gzip B. Server gzip varies by 2 B. Startup 60000 ms is configuration,
not a latency measurement. These measurements cover this prerequisite,
not a fresh feature union. Historical TSV rows are unchanged.

Fresh verification: unchanged checker/parity/config/citation suites
**100/100**; Kit checker selftest **12/12**, Hono bundle selftest **34/34**,
performance gate **6/6**, parity selftest **13/13**. Lint **2059 files**,
root/CI and E2E types, asset drift, Hono budgets, floor guard, inventory
**1249/1249** plus Playwright **54/54**, docs links **160** Markdown files,
and internal-reference ratchet **27/27** plus scan pass. Incoming event/profile fixture
suites: **90 pass / 114 browser-gated skips / 0 fail**; browser wiring
**18/18**. Database variables were unset. Dependency audit **exit 0**,
zero blocked findings in both locks. No acceptance test files were edited;
all incoming source/test/workflow/lockfile paths equal pinned main.

`context-pack --base origin/main` failed with `RuntimeError: MCP server
exited`; no pack produced. No functions/callers differ from main. Memory
recall and optional routed arithmetic both failed response-schema validation;
no usable result or verdict. Arithmetic is directly verified. Full
`npm run check`, fresh feature union/acceptance, browser/visual/quality gates,
Hono worker dry-run, startup latency and staging were not rerun. No page
differs from main. Exact-head CI and independent hosted review still gate
merge; the source feature/server HOLD remains. UNDO: this PR's history and
evidence only, not main's independently approved allocations or repairs.

## Twenty-sixth base-conflict reconciliation: history only, limits equal base

GitHub confirmed the conflict on `545514d3c`. Merged pinned main
`826b40e85ab3201f199e4613f7f488a1e5d8b314`, which adds
[#1799](https://github.com/TogetherWeOwn/two-web-next/pull/1799).
That independently reviewed edit-form composition allocation raises server
JS gzip from 333568 to 333824 B. It is taken verbatim from main, not authored
or extended here, and does not establish this source feature's server fit.
All other numeric fields were identical on both sides and remain unchanged.

The sole conflict was the budget comment. Common history (598396 characters)
+ main's unique suffix (3907) + this branch's unique suffix (10900) = 613203
characters. Each suffix is absent from the opposite input and retained once.
Main's complete history remains a verbatim prefix. All non-comment values
and ASCII-escaped JSON representation equal pinned main. Only the comment
and these two evidence files differ from main; the TSV is unchanged.

Two fresh locked external root/web installs use Node `v24.22.1` and npm
`11.19.1`. Two `npm --prefix web run build` runs followed by unchanged
`node ci/check-kit-perf.mjs --format json` give **exit 0 twice**:

| Group | Build 1 raw/gzip | Build 2 raw/gzip | Main ceiling raw/gzip |
| --- | --- | --- | --- |
| Client JS (54/55 files) | 253949/102273 B | 253949/102273 B | 254464/102912 B |
| Server JS (115/126 files) | 1176056/333151 B | 1176056/333154 B | 1203200/333824 B |
| Worker entry | 2551/1219 B | 2551/1219 B | 3584/1536 B |
| Client CSS (2/4 files) | 2833/1006 B | 2833/1006 B | 3072/1024 B |

All 54 client JS path/hash pairs match; zero literal `drizzle-orm` client
references. Margins: client 515 raw / 639 gzip B, server 670–673 gzip B,
CSS 18 gzip B. Server gzip varies by 3 B. Startup 60000 ms is configuration,
not measured latency. These are prerequisite-tree measurements, not a fresh
frozen-feature union or acceptance run.

Fresh unchanged checker/parity/config/citation suites **100/100**;
checker selftest **12/12**, Hono bundle selftest **34/34**, performance gate
**6/6**, parity selftest **13/13**. Lint **2059 files**, root/CI and E2E types,
assets, Hono budgets, floor guard, inventory **1249/1249** plus Playwright
**54/54**, docs links **160** Markdown files, reference ratchet **27/27**
plus scan, and dependency audit **exit 0**, zero blocked rows in both locks,
pass. Fixture checks unset database variables. No tests were edited.

`context-pack --base origin/main` failed with `RuntimeError: MCP server
exited`; no pack. No functions or callers differ from main. Memory recall
and optional routed arithmetic failed response-schema validation, producing
no usable result; history and arithmetic are directly asserted. Full
`npm run check`, fresh feature union/acceptance, live browser/visual/quality
gates, Hono worker dry-run, startup latency and staging were not rerun.
No page differs from main. Exact-head CI and independent hosted review still
gate merge. The unchanged source ref is `723957121b65`; its server HOLD
persists. UNDO: this PR's history/evidence only, never #1799's independent
allocation or prior main-side repairs.

## Twenty-seventh base-conflict reconciliation: history only, limits equal base

GitHub confirmed the conflict on `c8f4f62e1`. Reconciled pinned main
`fcb2b94598bb60f33e7c2f982fb0415cde5855dd`, adding
[#1785](https://github.com/TogetherWeOwn/two-web-next/pull/1785).
Main changed only the budget comment since the preceding pinned base
`826b40e85`; all non-comment values are equal on every side. No runtime,
lockfile, checker, workflow, test or ceiling change is authored here.

The sole conflict was the comment. Exact merge-base history (602303
characters) + main suffix (3127) + branch suffix (10900) = 616330 characters.
Each suffix is absent from the opposite input and retained exactly once;
main's complete history is a verbatim prefix. Preserve its ASCII-escaped
JSON representation. Only the comment and this PR's two evidence files
differ from pinned main; the historical TSV remains unchanged.

Reuse the preceding pinned build measurements as historical evidence;
no fresh Kit build, build determinism or current feature-union claim is
made this round. Main's incoming change is comment-only and every runtime
input equals the preceding prerequisite tree. The client proposal remains
withdrawn and source-feature/server HOLD persists; neither this history
merge nor another feature's allowance grants release permission.

The first focused run failed because the external dependency symlink had
expired (`ERR_MODULE_NOT_FOUND: wrangler`). Restoring the committed root
lock with external `npm ci --include=dev` gives **100/100** unchanged
checker/parity/config/citation tests. Gate selftests pass: Kit **12/12**,
Hono bundle **34/34**, performance **6/6**, parity **13/13**. An early docs
check caught the new summary anchor before this section was written;
completing the section fixes that draft-only link. No tests were modified.

Full `npm run check`, Vitest, builds, fresh feature union/acceptance,
browser/visual/quality gates, Hono worker dry-run, measured startup and
staging were not rerun. No page differs from main. Exact-head hosted
CI/security and independent review remain mandatory; an active review
must not be superseded by a push. UNDO: our history/evidence only, not
main's independently approved allocations or prior repairs.
