# Featured stale-save recomposition on the ongoing-night main

GitHub reported this feature branch as conflicting after main advanced to
`813c0be2f` (#1872 agent-event statement deadlines, then #1907 ongoing-night
labels). Those features raised main's own server allowance to 1205504 raw /
337408 gzip. This feature PR integrates that main, keeps both allocation
histories, and carries its measured allowance, decision and boundary proofs
together. No runtime, staging, Lighthouse or other class-A limit changes.

## Locked measurements

Node 24.22.1; committed root and web lockfiles; `npm ci --include=dev` in
both package roots, then `npm run build --prefix web` and
`node ci/check-kit-perf.mjs`. The pristine-main tree uses identical
lockfiles and toolchain. Gzip totals are the checker's per-file sum.

| Tree | Build | Server files | Raw bytes | Gzip bytes |
| --- | --- | ---: | ---: | ---: |
| Pristine main `813c0be2f` | 1 | 116 | 1205293 | 337286 |
| Current main plus this feature | 1 | 116 | 1208152 | 338155 |
| Current main plus this feature | 2 | 116 | 1208152 | 338154 |

Pristine main fits its 1205504 raw / 337408 gzip ceilings and matches its
own #1907 decision measurements byte-for-byte. The composed tree exceeds
this feature's previous 1205760 / 337664 allowance by 2392 raw / 491 gzip
(worst). The feature footprint on this main is +2859 raw / +869 gzip, the
same `chunks/admin.js` stale-save cost measured on the previous base;
identical-tree gzip variation is 1 byte and is disclosed. No duplicate or
unneeded import accounts for the growth. Client JS (258533/103321), CSS
and the Worker entry fit unchanged ceilings.

## Bounded admission

The smallest 256B-step ceilings covering the worst build are 1208320 raw
(margin 168; the lower 1208064 step rejects by 88) and 338176 gzip (margin
21; the lower 337920 step rejects by 235). Against current main the raw
allowance rises by 2816B (0.234%) and the gzip allowance by 768B (0.228%),
each below the 0.5% per-feature byte-budget limit. Main's independent
1205504 / 337408 admission is not counted again as this feature's raise.

The shipping oracles in `ci/budget-fragments.test.mjs` and
`ci/check-kit-perf.test.mjs` admit exactly these allocations alongside
both retained histories; off-allocation raw/gzip values and any other
axis drift still fail. Undo: revert this feature PR including this
decision and its admission controls.
