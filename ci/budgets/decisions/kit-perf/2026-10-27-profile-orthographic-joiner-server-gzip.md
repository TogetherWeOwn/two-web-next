# 2026-10-27 decision: server JS gzip ceiling 336384 -> 336896

`server.js.maxGzipBytes` rises 336384 -> 336896 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This independently
admits the measured server cost of profile Unicode validation in PR #1863.
336896 is the smallest 256B-aligned cover, not a blanket 25% allocation:
on the latest composition, 336384 rejects by 430B and 336640 by 174B.
The requested ceiling leaves 82B of margin. The initial pinned profile head
needed the same ceiling, with 199B of margin; both measurements are below.

## Source and measurements

Main `d6e9491c2216738cf016c7020c0ea84e7a5b7f91` and PR #1863 head
`a966e3c3038834109c9f02424a3ab118d97c48a8` were independently built from
immutable source archives. The profile head already includes that main.
Locked dependencies, Node 24.22.1 / npm 11.19.1, generated critical CSS,
`npm run build --prefix web`, two production builds per tree. The canonical
`measure(root)` from `ci/check-kit-perf.mjs` measured every build.

| Tree/build | Server files | Server raw bytes | Server gzip bytes | Full gate |
|---|---:|---:|---:|---|
| Main 1 | 116 | 1190242 | 336246 | exit 0 |
| Main 2 | 116 | 1190242 | 336248 | exit 0 |
| Profile 1 | 116 | 1191219 | 336696 | exit 1: server and client gzip |
| Profile 2 | 116 | 1191217 | 336697 | exit 1: server and client gzip |

Identical-tree rebuild jitter is included, not rounded away: server gzip
varied by 1–2B, and profile raw output by 2B. The worst gzip result governs.
On the final profile build, changing only the scratch server fragment proves
336384 and 336640 reject, while 336896 passes the server group. The full gate
still exits 1 for client gzip; this decision does not claim an overall fit.
The scratch fragment was restored byte-identically afterward.

## Fresh-main composition recheck

Before opening the capacity PR, main advanced to
`db2590d0cfc892956aa8f96f21e616fa47b6d6d2`. The product head is unchanged.
A clean `git merge-tree --write-tree` produces composition tree
`1f0e8870427b627415e60044fb4514166996741c`; neither source branch was changed.
Two production builds per tree, the same locked runtime and canonical checker:

| Tree/build | Server files | Server raw bytes | Server gzip bytes | Full gate |
|---|---:|---:|---:|---|
| Fresh main 1 | 116 | 1190765 | 336367 | exit 0 |
| Fresh main 2 | 116 | 1190765 | 336370 | exit 0 |
| Composition 1 | 116 | 1191742 | 336814 | exit 1: server and client gzip |
| Composition 2 | 116 | 1191740 | 336814 | exit 1: server and client gzip |

336896 remains the smallest aligned cover: actual scratch controls reject
336384 and 336640, admit the server group at 336896, and retain the client
failure. Fresh main client JS is 54 files / 256400 raw / 103000 gzip;
composition is 54 / 256691 / 103195, a separate 27B gzip breach. Worker and
client CSS bytes are unchanged. Main independently raised the CSS gzip cap
to 1280 in #1727; this PR neither includes nor reverses that allocation.
The observed server delta over fresh main is +975–977 raw / +444–447 gzip.

## Attribution and alternatives

Initial pinned pair's final-build per-file deltas, using the checker's Node
`gzipSync` semantics:

| Server output | Raw delta | Gzip delta |
|---|---:|---:|
| `chunks/admin.js` | +1004 | +481 |
| `chunks/profiles.js` | -27 | -31 |
| `chunks/instance.js` | -2 | 0 |
| `chunks/internal.js` | 0 | +1 |
| `nodes/23.js` | 0 | -2 |
| **Total** | **+975** | **+449** |

The source change adds contextual Unicode joiner admission in
`src/admin/validation-shared.ts` and reuses that shared refusal predicate in
`src/profiles/validation.ts`, removing the profile-only ASCII-control regex.
Shared validation is emitted in the admin chunk. The virama list is already
hex-delta encoded; the parent also already removed an intermediate boolean
array. No demonstrated behavior-preserving simplification closes the 313B
breach. Removing orthographic or emoji contexts would reject legitimate text;
returning to an unrestricted combining-mark exemption would weaken refusal.
Neither is a capacity optimization. Product code and its acceptance files
remain outside this change.

## Other axes and verification

Every build keeps Worker 2551 raw / 1219 gzip and client CSS 2 files /
2861 raw / 1019 gzip, within unchanged ceilings. Client JS is 54 files /
256371 raw / 102994 gzip on main and 54 / 256662 / 103189 on the profile
head. Its 21B gzip breach above 103168 has a separate prerequisite, PR #1952;
this server allocation must not duplicate or pre-approve that work. Server
raw and file count remain below 1203200 and 126.

The unchanged shipping ladder in `ci/check-kit-perf.test.mjs` already admits
336896 with fixed 336673 interval, 336896 exact and 336897 one-over probes.
These are synthetic boundary fixtures, not measurements of this profile head.
The aggregate allocation oracle in `ci/budget-fragments.test.mjs` incorporates
independent test-author commit `37a470978bdadc8ea49aa7f3cc0892e9ac8da649`
unchanged. It adds 336896 admission, refuses 336897 and 337152, and extends
all eight off-axis drift controls to the new rung without removing the old
ones. The integrated paired suites pass 73/73; the clean synthetic merge
with fresh main passes 75/75, including main's additional CSS boundary tests.

Before the capacity edit, both budget suites passed 72/72. The unchanged
profile archive passed 91/91 across the bidi/invisible acceptance,
orthographic-joiner, control-validation and NUL-rejection suites. Exact-head
CI and independent review remain required; this record does not claim full
local checks, staging, startup, runtime or release acceptance.

## Scope and undo

Only the server-gzip fragment, this decision and the independently authored
allocation admission belong in the capacity PR. No checker, product,
dependency, workflow, mask, exclusion or other-limit changes. Other pending
allocations were not merged at measurement time; recheck the premise and
remeasure composition if main or the product head moves.

Undo: revert this fragment step, its allocation admission and this record
after removing or reducing dependent product growth. Reverting the ceiling
first intentionally restores the server-size failure. No deployment, database
or runtime change is part of this decision.
