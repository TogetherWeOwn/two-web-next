# Independent RSVP server-byte decision

Measured 2026-10-23. Prerequisite for [#1495](https://github.com/TogetherWeOwn/two-web-next/pull/1495), not delivery or approval of that feature.

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
