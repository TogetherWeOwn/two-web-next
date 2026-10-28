# 2026-10-27 decision: client JS raw 257024 -> 258048 and gzip 103168 -> 103424 for the honest event-detail roster and venue on current main

`client.js.maxRawBytes` rises 257024 -> 258048 and `client.js.maxGzipBytes` rises 103168 -> 103424 in `ci/budgets/kit/client-js.json`; the file ceiling stays 55 (measured 54) and no other ceiling changes. This is the second least-aligned single step for the honest event-detail roster and TBD-venue slice (feature PR #1499) composed with current main. The first step (257024 raw, gzip kept at 103168) merged earlier. Main has since grown again (event time-from-now and cancelled-event alternatives touched the event-detail route), so the composition no longer fits that step, and the 257536 raw ceiling first proposed here is also short.

## Frozen inputs

- Main: `f09dd15de149c0a0e6d7a00f699510f126d0a262` (`f09dd15de`), which carries client 257024/103168/55.
- Feature: actual #1499 head `26fd963642faef083e77db37c37d458217111a6a`, still open and unchanged.
- Union: `git merge --no-commit --no-ff` of the feature onto main conflicts only in the two legacy budget files main deleted (removed, never resurrected), four event screenshot binaries (kept main's, byte-irrelevant to client JS), and one `src/events/pages-detail.tsx` hunk (main's `accessibilityNotes` and `duration` lines plus the feature's comment, one `accessibilityNotes` declaration; Hono SSR, immaterial to Kit client bytes). `web/src/lib/EventDetail.svelte` merges cleanly with both sides present. This decision ships no Hono change and is not authority for one.
- Toolchain: Node v24.22.1, npm 11.19.1. The feature changes no lockfile; dependencies were installed once from main's lockfiles and copied verbatim into the union tree.

## Repeated canonical measurements (twice per tree)

`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`. All four builds exit 0.

| Group | Pristine main (b1 / b2) | Union main + #1499 (b1 / b2) | Landed ceilings | Result |
| --- | --- | --- | --- | --- |
| Client JS raw | 256371 / 256371 | 258023 / 258023 | 257024 | union fails by 999 |
| Client JS gzip | 102994 / 102994 | 103383 / 103383 | 103168 | union fails by 215 |
| Client JS files | 54 / 54 | 54 / 54 | 55 | pass |
| Server JS gzip | 336247 / 336247 | 336802 / 336800 | 336384 | union fails; owned by the separate server gzip card, not this decision |

Pristine main checker exits 0 twice; the union exits 1 twice. Feature increment over current main: client +1652 raw / +389 gzip. Main itself grew +739 raw / +148 gzip since the first step was sized and has consumed most of that step's headroom.

## Attribution

52 of 54 client chunks are byte-identical across the union. Only the event-detail route node changes (22.Ddn3SY80.js 17990 -> 22.CeBvTIDs.js 19642 raw) plus the entry/app rehash (5596 raw both). The growth is the feature's required roster states and TBD-venue row; no behavior-preserving reduction exists inside a budget card.

## Least-cover sizing (no broad headroom)

- Raw: 258048 is the least 512B-aligned cover of the measured 258023 (25B margin); the next lower step, 257536, rejects it by 487. The README x1.25 default is deliberately not applied. The margin is thin: any further event-detail growth on main re-opens this fit, and the owner of the next change measures it on the new base.
- Gzip: 103424 is the least 256B-aligned cover of the measured 103383 (41B margin); 103168 rejects it by 215.
- Files: unchanged at 55.

## Scratch accept/reject ladder (union build output, only the client ceilings varied)

Read from the `kit.client.js` group status in the checker JSON: 257536/103424 rejects (raw); 258022/103424 rejects and 258023/103424 accepts; 258048/103382 rejects and 258048/103383 accepts; 258048/103424 accepts. Every smaller value fails closed.

## Enforcement and coevolution

- The shipping allocation controls in `ci/check-kit-perf.test.mjs` already admit raw 258048 and gzip 103424 (landed independently). The aggregate fragment pin in `ci/budget-fragments.test.mjs` lists only the 257024/103168 client pair; admitting the 258048/103424 pair coevolves with the independent test owner's delivery. This decision edits no test assertion of its own.
- Open PRs #1817, #1919 and #1928 also move this fragment. Whichever lands second re-measures on the new base.
- No worker, server, CSS, startup, file-count, Hono, feature, checker, dependency, workflow, mask or exclusion change ships. No staging, runtime or release acceptance is claimed; exact-head CI and independent review remain mandatory, and the fit is re-proved on the latest main and #1499 before this closes.

Undo: revert only this fragment's two values and this decision file.
