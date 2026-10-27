# 2026-10-27 decision: client JS raw 257024 -> 257536 and gzip 103168 -> 103424 for the honest event-detail roster and venue on current main

`client.js.maxRawBytes` rises 257024 -> 257536 and `client.js.maxGzipBytes` rises 103168 -> 103424 in `ci/budgets/kit/client-js.json`; the file ceiling stays 55 (measured 54) and no other ceiling changes. This is the second least-aligned single step for the honest event-detail roster and TBD-venue slice (feature PR #1499) composed with current main. The first step (257024 raw, with the 103168 gzip kept) merged earlier; main has since grown and the composition no longer fits it.

## Frozen inputs

- Main: `227414575dd8fffe8ebe245086442ce5a20ca174`, which already carries client 257024/103168/55.
- Feature: actual #1499 head `26fd963642faef083e77db37c37d458217111a6a`, still open and unchanged.
- Union: `git merge --no-commit --no-ff` of the feature onto main conflicts only in the two legacy budget files main deleted (removed, never resurrected), four event screenshot binaries (kept main's, byte-irrelevant to client JS), and one `src/events/pages-detail.tsx` hunk (feature comment plus main's `duration` line, one `accessibilityNotes`; Hono SSR, immaterial to Kit client bytes). `web/src/lib/EventDetail.svelte` merges cleanly with both sides present. This decision ships no Hono change and is not authority for one.
- Toolchain: Node v24.22.1, npm 11.19.1, Vite 8.3.5, Wrangler 4.152.0. The feature changes no lockfile; dependencies were installed once from main's lockfiles and copied verbatim into the union tree.

## Repeated canonical measurements (twice per tree)

`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`. All four builds exit 0.

| Group | Pristine main (b1 / b2) | Union main + #1499 (b1 / b2) | Landed ceilings | Result |
| --- | --- | --- | --- | --- |
| Client JS raw | 255632 / 255632 | 257285 / 257285 | 257024 | union fails by 261 |
| Client JS gzip | 102846 / 102846 | 103235 / 103235 | 103168 | union fails by 67 |
| Client JS files | 54 / 54 | 54 / 54 | 55 | pass |
| Server JS gzip | 335837 / 335836 | 336411 / 336414 | 336128 | union fails; owned by the separate server gzip card, not this decision |

Pristine main checker exits 0 twice; the union exits 1 twice. Feature increment over current main: client +1653 raw / +389 gzip. Main itself grew +706 raw since the first step was sized and consumed its headroom.

## Attribution

52 of 54 client chunks are byte-identical across the union. Only the event-detail route node changes (17483 -> 19136 raw), plus the entry/app rehash (same raw, gzip hash noise). No duplication artifact: each union marker string appears once in the built node. The growth is the feature's required roster states and TBD-venue row; no behavior-preserving reduction exists inside a budget card.

## Least-cover sizing (no broad headroom)

- Raw: one 512B step to 257536 is the least aligned cover of the measured 257285 (251B margin). The README x1.25 default is deliberately not applied.
- Gzip: one 256B step to 103424 is the least aligned cover of the measured 103235 (189B margin).
- Files: unchanged at 55.

## Scratch accept/reject ladder (union build output, only the client ceilings varied)

Read from the `kit.client.js` group status in the checker JSON: 257024/103168 rejects; raw 257284 rejects and exact 257285 accepts; gzip 103234 rejects and exact 103235 accepts; 257536/103424 accepts. Every smaller value fails closed.

## Enforcement and coevolution

- The shipping allocation controls and the aggregate fragment pin still list 257024/103168 and, for gzip, only 103168 and 103680. They coevolve with the independent test owner's delivery (a 103424 gzip allocation with exact and one-byte-over cases, and the 257536/103424 aggregate pin); this decision edits no test assertion of its own.
- No worker, server, CSS, startup, file-count, Hono, feature, checker, dependency, workflow, mask or exclusion change ships. No staging, runtime or release acceptance is claimed; exact-head CI and independent review remain mandatory, and the fit is re-proved on the latest main and #1499 before this closes.

Undo: revert only this fragment's two values and this decision file.
