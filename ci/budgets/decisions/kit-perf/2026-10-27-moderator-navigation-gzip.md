# 2026-10-27 decision: client JS gzip ceiling 103168 -> 103424 for moderator navigation

**Draft: the current-main recheck below rejects this proposal. Do not treat
these historical measurements as admission of the current composition.**

`client.js.maxGzipBytes` rises 103168 -> 103424 in
`ci/budgets/kit/client-js.json`; no other ceiling changes. This admits the
moderator-navigation change (activity-subject editor links plus
status-correct public/preview links, shared `src/admin/moderator-links.ts`
plus both Kit twins), whose new shared client chunk and two route-template
anchors grow the Kit client bundle past the current ceiling once merged
with current main. One 256B step, the smallest aligned cover for the
measured worst case: 103168 rejects it by 144B.

The server half of the original proposal is superseded and ships no
change: main now carries `server.js.maxGzipBytes` 336384 (via the
event-share-honesty raise), and the composition's worst server gzip
336232B fits with 152B of margin. Client raw (256544/257024B) and the
55-file ceiling (55/55) also fit unchanged. This record preserves every
incoming-main allocation verbatim and requests only the still-needed
client gzip step.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

- Pristine main: `b69eea7d7f8e99096cb497dce71210caf9af0502`
- Feature head: `aadfe9aadbd36f3c32b8bdfb518e9a3e4c4e8f71`
  (moderator-navigation links; still open and unchanged)
- Composition: scratch merge `0b277ebe859ba3ceca7f3648477c40450f17fa44`
  (clean merge, no conflict resolutions; the merge touches only
  `src/admin/moderator-links.ts`, two Hono admin pages, two Kit
  `+page.svelte` twins and three acceptance-test files — zero budget,
  checker, test-oracle or workflow files)

Pristine main (ceilings: server gzip 336384, client gzip 103168):

| Build | Server files | Server raw/gzip | Client files | Client raw/gzip | Gate |
|---|---:|---:|---:|---:|---|
| 1 | 116 | 1187398 / 335838 | 54 | 255632 / 102846 | exit 0 |
| 2 | 116 | 1187398 / 335836 | 54 | 255632 / 102846 | exit 0 |

Composition (same ceilings):

| Build | Server raw/gzip | Client files | Client raw/gzip | Gate |
|---|---:|---:|---:|---|
| 1 | 1188917 / 336231 | 55 | 256544 / 103312 | exit 1, client gzip 144 over |
| 2 | 1188917 / 336232 | 55 | 256544 / 103312 | exit 1, client gzip 144 over |

With the fragment set to 103424 the composed tree exits 0: every Kit
asset fits (client gzip margin 112B). One step below (103168) rejects by
144B, so 103424 is the smallest 256B-aligned ceiling that admits the
measured worst case. Client bytes are deterministic (byte-identical
across rebuilds within each tree); server gzip wobbled 2B across
identical-tree rebuilds (335838/335836 pristine, 336231/336232
composed) — disclosed jitter, not signal.

## Attribution

Client delta is +912 raw / +466 gzip bytes, +1 file (54 -> 55); 51 of
54 pristine chunks are byte-identical in the composition:

| Chunk | Pristine raw/gzip | Composed raw/gzip | Delta raw/gzip |
|---|---:|---:|---:|
| `chunks/lD4E9-gK.js` (new shared strict resolver) | — | 373 / 253 | +373 / +253 |
| `nodes/12` (activity-log route twin) | 3149 / 1565 | 3453 / 1689 | +304 / +124 |
| `nodes/14` (event editor route twin) | 11164 / 3738 | 11369 / 3813 | +205 / +75 |
| `entry/app` (import-graph churn) | 5596 / 1531 | 5626 / 1545 | +30 / +14 |

Zero `drizzle` references in the client bundle. Server delta (+1519 raw
/ +396 gzip, 116 files both trees, 111 byte-identical) concentrates in
`chunks/admin.js` (+1447 / +379, the Hono admin code including the
shared resolver's server twin) plus the two route nodes (+36 raw each);
it fits the inherited 336384 ceiling, so no server step ships here.

Rejected in-feature spellings: shorter labels save ~20B gzip (144B are
needed); load-precomputed hrefs contradict the acceptance fixtures,
which carry no precomputed hrefs; a looser key regex violates the
strict-minted-form contract. The growth is inherent to the approved
acceptance contract, not recoverable in-feature.

## Shipping tests

No checker, source, workflow, mask or exclusion changes ship here.
`ci/check-kit-perf.test.mjs` already carries 103424 in its
`SHIPPING_CLIENT_GZIP_ALLOCATIONS` (interval 103302, exact 103424, one
byte over 103425). The aggregate `SHIPPING_KIT_BUDGET` in
`ci/budget-fragments.test.mjs` mirrors the shipped fragments, so its
`client.js.maxGzipBytes` literal moves 103168 -> 103424 in this same PR
(one line, authored independently of the budget change; with that line
reverted the suite fails 1 of 33). The budget suites (`check-kit-perf`,
`budget-fragments`, `bundle-inventory-acceptance`) run against the new
fragment: 124 tests, 124 pass, 0 fail on Node 24.22.1.

Sibling open PRs also target client gzip (event-detail second step at
257536/103424, featured editorial-limits and profile-review at
258048/103680, archive game-facet at 257792/103680); all were open and
unmerged at measurement time. This step is the smallest cover for this
composition; whichever PR lands second re-measures on the new main.
Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, restore `SHIPPING_KIT_BUDGET.client.js.maxGzipBytes` in
`ci/budget-fragments.test.mjs` to 103168, and revert this record together.
If moderator navigation has merged, revert it or reduce its bundle first
so the built output fits the restored ceiling; re-run the budget suites
and `node ci/check-kit-perf.mjs` before landing the rollback.

## Current-main recheck: proposal no longer sufficient

Main advanced to `4e90a8bcfd70a46564f6bb363e1543304ec271c0`
(cancelled-event alternatives, on-request relative time and bounded job
statements). The feature head remains
`aadfe9aadbd36f3c32b8bdfb518e9a3e4c4e8f71`. A clean
`git merge-tree --write-tree` produces composition tree
`d7dda561b682e16a41874b45ae4c7529b55ccce9`; no branch was rebased or
merged. Root and web lockfiles match between the two archived trees.

Reinstalled both locked dependency roots outside the source worktree,
then ran two `npm run build --prefix web` production builds per tree on
Node 24.22.1 / npm 11.19.1, followed by
`node ci/check-kit-perf.mjs --format json`:

| Tree / build | Server raw/gzip | Client raw/gzip | Gate at main ceilings |
|---|---:|---:|---|
| Pristine main / 1 | 1190240 / 336250 | 256371 / 102994 | exit 0 |
| Pristine main / 2 | 1190242 / 336247 | 256371 / 102994 | exit 0 |
| Composition / 1 | 1191759 / 336652 | 257283 / 103459 | exit 1 |
| Composition / 2 | 1191761 / 336650 | 257283 / 103459 | exit 1 |

Main still carries client raw/gzip 257024/103168 and server gzip 336384.
Both compositions also exit 1 with this PR's proposed client gzip 103424:
client gzip is 35B over that proposal, client raw is 259B over its
unchanged ceiling, and worst server gzip is 268B over its unchanged
ceiling. Client and server file counts remain 55 and 116; other measured
asset groups pass. Identical-tree server rebuilds vary by 2B raw and up
to 3B gzip; both fail, so that variance cannot change the verdict.

The original 112B client and 152B server margins have been consumed by
main drift. This is not permission to widen another axis: no additional
ceiling, checker, source or test change is made. Keep this PR draft and
out of the merge queue pending a separate scope/capacity decision and any
independent test corrections. Re-measure after that decision or another
base/head move; the earlier green composition is not current evidence.
