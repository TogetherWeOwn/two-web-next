# Independent RSVP server-byte decision

Measured 2026-10-23. Prerequisite for [#1495](https://github.com/TogetherWeOwn/two-web-next/pull/1495), not delivery or approval of that feature.

## Current-base conflict reconciliation: no additional allowance

The original **329,984B** proposal below is **superseded**, not the current numeric change. Merge base update `2b4f1902e096d969ad4a909a085fb6e221ddfc3a` into this prerequisite after GitHub reports a conflict. Only `ci/kit-perf-budget.json` conflicts. Keep **every numeric limit identical to incoming main**, including its independently approved **333,312B** server gzip ceiling from [#1686](https://github.com/TogetherWeOwn/two-web-next/pull/1686). Do not add the old RSVP allowance to it or reduce main's allocation. The final PR changes only decision history and this evidence document relative to that base.

Preserve incoming main's complete **277,974-character** decision history as a verbatim prefix, then append the original **2,579-character** RSVP record exactly once and a superseding reconciliation. The original record refers only to its frozen inputs, not the current base.

### New frozen measurements

- Current main: `2b4f1902e096d969ad4a909a085fb6e221ddfc3a`.
- Same frozen RSVP feature: `d806da154fbe0ec1bd1e5805db1bfa469e45df36`.
- Scratch composition tree: `9107b24f3352505b9cf58a8e282c71b0eecab825`. Created with `git merge-tree --write-tree <main> <feature>`, resolving its sole budget conflict to main's exact budget. No feature ref was changed. All other paths are Git's normal merge result.
- Same root/web lock blobs listed below, Node `24.22.1`, npm `11.19.1`, fresh external `npm ci --include=dev --no-audit --no-fund` installs. Two clean production builds per pinned archive: `NODE_ENV=production npm run build --prefix web`. The unchanged checker measures default Node gzip per emitted file.

| Source / build | Server files | Server raw B | Server gzip B | Current cap 333,312B | Original cap 329,472B |
| --- | ---: | ---: | ---: | --- | --- |
| Current main 1 | 117 | 1,129,528 | 328,710 | pass | fits |
| Current main 2 | 117 | 1,129,528 | 328,710 | pass | fits |
| Current-base RSVP composition 1 | 117 | 1,132,085 | 329,218 | pass | fits, 254B margin |
| Current-base RSVP composition 2 | 117 | 1,132,085 | 329,218 | pass | fits, 254B margin |

Current main includes a profile-view co-compression rule in `web/vite.config.ts` absent from the original frozen base. Its emitted server count is now 117 rather than 118. This prerequisite changes neither grouping nor enumeration and claims no optimization of its own. Current RSVP growth is **+2,557 raw / +508 gzip B** relative to current main. Do not compare these deltas as identical to the historical builds below. Both current compositions fit even the original 329,472B limit: the new main allocation is not needed to justify this frozen RSVP integration. These results authorize no simultaneous integration with the distinct moderation feature whose prerequisite allocated 333,312B.

Other groups are stable across each tree's two rebuilds, including client paths and SHA-256 hashes:

- Current main client JS: **53 files, 245,331 raw / 99,255 gzip B**.
- Composed RSVP client JS: **53 files, 246,285 / 99,471B**, delta **+954 / +216B**; zero client `drizzle-orm` references in either tree.
- CSS in both trees: **2 files, 2,878 / 1,024B**. Gzip is exactly at its unchanged cap: **zero margin**, not permission to increase it.
- Worker entry in both trees: **2,551 / 1,219B**, identical SHA-256. All other byte, count and startup limits remain unchanged.

### Current verification and boundaries

- All four clean builds and their unchanged asset gates exit 0 under incoming main's budget.
- Scratch real-artifact boundary harness: **24/24 pass** (six per build): current main cap passes; exact measured server gzip passes; one byte under server gzip rejects; one byte under server raw rejects; one file under server count rejects; superseded 329,984B cap passes. Each negative control produces exactly one server-group error. Numeric equality to incoming main, full history-prefix preservation and exactly-once RSVP history are asserted separately.
- `node --test ci/check-kit-perf.test.mjs`: **13 passed, 0 skipped**; `npm run kit-perf:selftest`: **6 passed**. Checker and all test files remain unchanged.
- The same four RSVP regression files listed below run on the new scratch composition: **107 passed, no skips**. Feature-only acceptance files retain their frozen feature blobs; the prerequisite contains no test edit relative to main.
- The first scratch harness run misclassified the checker's informational startup line as an error. Correct the scratch collector to distinguish `log` from `error`, then rerun all 24 cases. No repository checker or test was changed to accommodate that harness mistake.
- Full `npm run check`, browser/staging/visual/deploy checks are not claimed. This PR changes no application/UI source relative to current main. Fresh exact-head CI and independent review remain required; after merge, #1495 must consume normally and remeasure its actual integrated head. CSS's zero margin and any further composition remain the feature owner's verification obligation.

Undo of this history/evidence-only prerequisite restores only its added records; it must not undo main's independently approved numeric limits.

## Original source-pinned proposal (superseded)

The sections below retain the original evidence and decision, valid only for main `46332992` and feature `d806da154`. Their proposed numeric edit and undo description are historical, not the current diff.

## Frozen inputs and method

- Pristine main: `46332992eb1b40ae729b47dbb092ec03c5af4c49`.
- Integrated feature: `d806da154fbe0ec1bd1e5805db1bfa469e45df36`.
- Root lockfile Git blob: `a7ff57064f68d32119c3561edc84972fbc0c3e21`.
- Web lockfile Git blob: `2a64d091787b0405097271b9d864e2d8de6dc7d0`.
- Node `24.22.1`, npm `11.19.1`; `npm ci --include=dev --no-audit --no-fund` for both committed dependency roots, outside the checkout. The frozen source archives use those identical locked installations.
- Run `npm run build --prefix web` twice per source tree, preserving each output before the next build. Run the unchanged `node ci/check-kit-perf.mjs` on each output. Totals below sum default Node `gzipSync` **per file**, not Vite's estimates or gzip of concatenated chunks.
- Source maps are attribution evidence, not counted assets. No file enumeration, build configuration, application source, test, dependency, lockfile or workflow changes ship here.

## Repeated measurements

All six builds succeed. Each server group has 118 JS files against the unchanged 126-file cap. The server raw ceiling remains 1,203,200B.

| Source / build | Server raw B | Server gzip B | Original cap 329,472B | Proposed cap 329,984B |
| --- | ---: | ---: | --- | --- |
| Pristine main 1 | 1,128,057 | 329,273 | pass | pass |
| Pristine main 2 | 1,128,055 | 329,271 | pass | pass |
| Frozen feature 1 | 1,130,612 | 329,739 | **fail, +267B** | pass, 245B margin |
| Frozen feature 2 | 1,130,610 | 329,737 | **fail, +265B** | pass, 247B margin |
| Standalone prerequisite 1 | 1,128,057 | 329,270 | fits | pass |
| Standalone prerequisite 2 | 1,128,055 | 329,272 | fits | pass |

The prerequisite builds use main's application sources with this budget edit. Their few-byte server variation is rebuild/import-name churn, **not a source-byte reduction**. Applying the proposed budget to the two preserved feature artifacts passes without rebuilding or changing any emitted byte. The feature plus budget overlay is the measured integrated tree; no feature source or feature ref was modified.

Client/other groups:

- Main and standalone prerequisite: client JS **53 files, 245,301 raw / 99,265 gzip B**.
- Frozen feature: client JS **53 files, 246,255 / 99,482B** in both builds: **+954 / +217B**. Paths and SHA-256 hashes match across its two builds.
- CSS throughout: **2 files, 2,737 / 983B**. Worker entry throughout: **2,551 / 1,219B**. Corresponding CSS paths/hashes and Worker bytes match.
- Main and prerequisite client paths/hashes are identical across all four builds. No client JS contains `drizzle-orm` in either frozen family.
- Client JS ceilings remain 54 files and 251,904 / 101,632B; CSS remains 4 files and 3,072 / 1,024B; Worker remains 3,584 / 1,536B; startup remains 60,000ms.

## Attribution and rejected reductions

Matched feature-minus-main deltas are **+2,555 raw / +466 gzip B** in both build pairs:

| Emitted server chunk | Raw delta B | Gzip delta B, first pair | Source-map attribution |
| --- | ---: | ---: | --- |
| `chunks/events.js` | +2,060 | +325 | Hono guest RSVP branch, Kit `EventDetail`, signed-in viewer signal |
| `chunks/site-shell.js` | +495 | +142 | Shared RSVP copy/test-ID contract, pulled in by the existing recursive shell group |
| Remaining changed chunks/imports | 0 net | -1 net | Export/import aliases and build hash strings |

The existing cap has only 199–201B spare on these pristine-main builds. The legitimate renderer/contract growth exceeds that spare; main itself is not red. The assignment's earlier frozen measurements reached 329,740B, consistent with this independently reproduced breach rather than evidence for a different source tree.

Before proposing an allowance, two narrowly scoped SSR-only grouping experiments were built on the frozen feature and then reverted:

1. Add only `contracts-rsvp-button.ts` to the existing events group. Its earlier recursive `site-shell` ownership wins, so the contract does not move. Gzip **329,742B**, still red; not a reduction.
2. Add only the pure Hono `rsvp-button.tsx` renderer to the shell group containing its contracts. Gzip worsens to **329,880B**. Rejected, not shipped.

Neither trial changes client JS/CSS totals or Worker size. Broad grouping reshuffles, different minification semantics, copy/design changes and feature rewrites are outside this prerequisite. These trials do **not** prove that every possible optimization is impossible; they show that the two targeted placement changes are not safe byte-saving fixes for this measured cost.

## Decision and boundary evidence

Propose **only** `server.js.maxGzipBytes: 329472 → 329984`, two existing 256B boundary steps. One step less, **329,728B**, fails both frozen artifacts by **11 / 9B**. This is the minimum in the existing 256B increment convention, not a claim that 329,984 is the smallest possible integer ceiling. Minimum measured margin is 245B, above the 2B paired rebuild variation and the earlier reported 329,740B maximum. Do not apply a multiplier or pre-approve later growth.

Preserve the entire preceding `$comment` history verbatim as a prefix, append this decision, and keep every other numeric ceiling unchanged.

Executed checks:

- Scratch `boundaries.mjs` calls the **unchanged checker** on the four preserved frozen outputs: **28/28 pass**. For each: original-cap verdict; proposed cap; one-step-less verdict; exact measured server gzip passes; one byte below actual server gzip rejects; one byte below actual raw rejects; one file below actual server count rejects. It also asserts the complete numeric-only diff and history-prefix preservation.
- `node --test ci/check-kit-perf.test.mjs`: **13 passed, 0 skipped**.
- `npm run kit-perf:selftest`: **6 passed**.
- On the restored frozen feature, `vitest run test/rsvp-truthful-prompts-acceptance.test.ts test/kit-rsvp-truthful-prompts-acceptance.test.ts test/islands-rsvp-button.test.ts test/kit-event-detail-rsvp-companion-acceptance.test.ts`: **4 files, 107 tests passed**, no skipped cases. All test files are unchanged.

The task artifact preserves build logs, before/after emitted output, per-file SHA-256/raw/gzip inventories, rejected trials, the extraction/build recipe and boundary harness. It is evidence, not a new CI/test implementation. No changed-test mapping is claimed.

## Limits and consumption

This configuration-only proposal changes no page or renderer. No browser, staging, production, visual-baseline, deployment or full-suite-green claim is made. Independent exact-head CI and review still decide whether this allowance can merge.

After the prerequisite squash merges, #1495 must consume it normally and remeasure **its actual integrated head**, with fresh exact-head CI/review. These frozen measurements authorize no later union. Undo: revert this standalone prerequisite squash, restoring the preceding ceiling and decision state.
