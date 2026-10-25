# Admin clarity: current-base budget reconciliation

## Decision

No additional budget allowance is needed for the measured admin-clarity composition.
Keep every field in `ci/kit-perf-budget.json` exactly as it is on the pinned main.
This note preserves the earlier branch-only budget history without appending another
record to the shared, single-line `$comment`. Future unrelated budget-history entries
therefore do not conflict with this evidence-only change.

This is measurement evidence for [the admin-clarity feature](https://github.com/TogetherWeOwn/two-web-next/pull/1587),
not implementation approval, a reserved allocation, or release approval. The feature
owner must remeasure the actual integrated head and pass exact-head CI and independent
review. No gate is skipped, disabled, or weakened.

## Pinned inputs

- Main: `3ba597ca8ca1cc783459ef27bdd7c74c34f50792`.
- Frozen feature head: `8c3d03b9e41e532f802057fce59653600b8c1272`.
- Previously resolved composition ancestor: `a645f8fe38913be769bbe9e4599f1b0fbb80dacb`.
- Fresh measurement tree: `495fa267906e780db571ad704ec9c4a0ee4d8e83`.
- Runtime: Node `24.22.1`, npm `11.19.1`.

The measurement tree merges the previously resolved feature composition with pinned
main. Main's newer native RSVP-pause disclosure is retained; pause and reopen controls
retain the feature's per-event accessible names, including the server-rendered pause
review. The conflicting `e2e/admin-filters.spec.ts` and
`test/islands-paused-cancelled-a11y.test.ts` files are exactly pinned main in the
measurement tree. This source composition is a build experiment, not a validated
implementation merge. None of its application or test files ship in the budget PR.

Root and web package manifests and committed lockfiles are byte-identical between the
two measurement trees. Dependencies were installed outside the synced worktrees with
`npm ci --include=dev --no-audit --no-fund`. All database-URL variables were removed
from build environments. No staging, production, migration, or deploy operation was
part of the measurements.

## Repeated production builds

Run twice per tree:

```sh
NODE_ENV=production npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four builds and all four unchanged canonical checker invocations exit `0`.
Within each tree, all 54 client JavaScript paths, raw sizes, and SHA-256 hashes are
identical across the two builds. Gzip figures below come from the canonical Node
checker, not a different compressor.

| Client JavaScript | Files / cap | Raw bytes / ceiling | Gzip bytes / ceiling |
| --- | ---: | ---: | ---: |
| Pristine main, both builds | 54 / 55 | 252550 / 254464 | 101933 / 102912 |
| Admin-clarity composition, both builds | 54 / 55 | 253370 / 254464 | 102227 / 102912 |
| Feature delta | 0 | +820 | +294 |
| Combined remaining margin | 1 | 1094 | 685 |

The retained second combined build also fits every other group:

| Group | Files / cap | Raw bytes / ceiling | Gzip bytes / ceiling |
| --- | ---: | ---: | ---: |
| Worker entry | one canonical entry | 2551 / 3584 | 1219 / 1536 |
| Server JavaScript | 115 / 126 | 1173575 / 1203200 | 332781 / 333312 |
| Client CSS | 2 / 4 | 2833 / 3072 | 1006 / 1024 |

The server gzip margin is only **531 bytes** on that retained output; it is not a
reserved allocation. The startup ceiling remains `60000ms`; startup latency was not
measured. Both trees retain all current byte ceilings, file caps, and checker logic.

## Reproduction and limitations

Build pristine pinned main and the stated composition with the same locked
installations, then run the canonical checker on each output. Rebuild each tree and
compare the complete client path/size/SHA-256 manifests, not just the totals. Keep
main's budget byte-for-byte; a no-allowance result is not authority to change a limit.

The feature owner's actual merge may resolve the newer pause-review overlap
differently and must be measured again. Browser behavior, accessibility, deployed
pages, startup latency, and feature acceptance were not established by these builds.
The budget PR contains only this note; no acceptance-test, application, dependency,
workflow, checker, or numeric budget change is included.

ACT: resolve the shared budget-history conflict by preserving main's budget verbatim
and retaining the branch-only history below. WHY: fresh repeated measurements fit
all current limits, and a dedicated note avoids recurring single-line conflicts.
UNDO: revert this note; do not lower main's independently reviewed ceilings.

## Historical branch-only records

The following records are preserved verbatim from the previous PR head. They describe
their named historical bases, not the current composition or current budget authority.

<!-- Branch-only historical text is appended verbatim below. -->
 2026-10-24 decision (admin-clarity client gzip allocation vs main 509cb40a7): pristine main builds on Node 24.22.1 with committed lockfiles measure client JS 54/55 files at raw 250421/gzip 101390B with gate exit 0, 242B under the 101632B ceiling. Overlaying frozen admin-clarity head 8c3d03b9 (#1587; tree d40340cb0; budget restored to main verbatim; lockfiles, web manifests and vite config byte-identical main since the feature side is unchanged) measures client JS 54 files at raw 251262/gzip 101763B in all four locked builds, 131B over the 101632B ceiling with gate exit 1; client raw fits with 642B margin, files 54/55 fit, server fits at 115/126 files raw 1150564/gzip 326742-326744B (6568B minimum margin under 333312B), and worker plus CSS are unchanged. Feature delta is +841/+373B raw/gzip, matching the prior +841/+372B round on main 6003f577f; the extra overage is main growth (+91/+38B pristine), not feature growth. All 54 client files are byte-identical (names, bytes, SHA-256, gzip) across rebuilds, so the breach is fully deterministic with zero churn contribution. Only the breached gzip ceiling moves, one 256B step 101632 to 101888 (125B margin, deliberately far below x1.25 = 127204); one step less is current main, which fails, so no smaller step exists. Every other byte ceiling, file cap, startup bound and the checker stays fixed and fail-closed, and no security, accessibility, quality or exact-head review gate is skipped or disabled. 2026-10-24 reconciliation (admin-clarity client allocation vs main dd841a1ae): main advanced 4 commits (visual-accept CLI, roster-status facet, inventory-return gzip allocation to 101888, security-pin contracts) and pristine client JS grew raw 250421 to 251164 (+743B) and gzip 101390 to 101622 (+232B), consuming the prior 125B gzip margin; earlier measurements above describe their named historical bases, not this merged tree. Overlaying frozen admin-clarity head 8c3d03b9 (#1587; combined tree a645f8fe3 = dd841a1ae + 8c3d03b9; budget restored to main verbatim; lockfiles byte-identical to main, root 131c46575f340d700c1c3dd414c64d403289042b77fbaf7ec7e7a3d9449437e0 / web feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e) with NODE_ENV=production npm run build --prefix web (Node 24.22.1/npm 11.19.1, DB URL vars scrubbed, all builds exit 0) measures client JS 54/55 files at raw 252009/gzip 102000B in all four locked builds: 105B over the 251904B raw ceiling and 112B over the 101888B gzip ceiling, gate exit 1; pristine builds exit 0 at raw 251164/gzip 101622B, matching main-tip CI exactly. Feature delta is +845/+378B raw/gzip, matching the prior +841/+372B and +841/+373B rounds; the new raw breach is main growth, not feature growth. All 54 client files are byte-identical (names, bytes, SHA-256, gzip) across rebuilds, so both breaches are fully deterministic with zero churn contribution: 40/54 chunks identical to pristine, growth concentrated in the shared admin chunk (+262/+139B raw/gzip) and admin nodes 13 (+213/+69B) and 14 (+232/+99B), with entry/app re-hashing size-neutral. drizzle-orm stays out of the client (0 references both trees). Both breached ceilings move one minimal step: raw 251904 to 252416 (512B alignment, 407B margin) and gzip 101888 to 102144 (256B alignment, 144B margin), deliberately far below x1.25 (315011/127500). Minimality on identical fourth-round artifacts: raw-only or gzip-only fix still fails, measured-minus-one (252008/101999) fails both axes, proposed passes exit 0 with every group fitting; one step less on either axis is current main, which fails, so no smaller step exists. Server fits at 115/126 files raw 1153986-1153988/gzip 327405-327406B (5906B minimum margin under 333312B), worker plus CSS are unchanged, and file caps stay fixed and fail-closed. No gate skipped or disabled; this is not feature or release approval. 2026-10-24 reconciliation (admin-clarity client allocation vs main 5778dbf80): main now carries client ceilings raw 253440B and gzip 102400B from the separately reviewed restored-write banner allocation (#1669), superseding this branch's earlier proposed 252416/102144B limits. Two fresh locked builds each of pristine main and the frozen admin-clarity composition (#1587 at 8c3d03b9e; measurement tree d785ecef3, main budget restored verbatim) on Node 24.22.1/npm 11.19.1 prove NO additional allowance is needed. Pristine client: 54/55 files, raw 252270/gzip 101942B in both builds; combined: 54/55 files, raw 253115/gzip 102319B in both builds, delta +845/+377B. All four unchanged canonical checker runs exit 0. Combined margin is raw 325B/gzip 81B. All 54 client files are byte-identical across each tree's rebuilds (names, raw, SHA-256 and gzip); zero client churn. Server stays at 115/126 files, raw 1156649-1156651/gzip 328012-328015B, fitting with at least 5297B gzip margin; worker 2551/1219B, CSS 2 files 2861/1019B and startup 60000ms fit unchanged. Root/web lockfiles equal main, database URL variables are absent, and dependencies live outside the synced trees. Keep EVERY numeric limit and main's complete history verbatim; append only branch-only historical records once and this no-allowance decision. The previous records are evidence for their named historical bases, not authorization to lower or increase current ceilings. No application, test, checker, workflow or dependency change ships here, and no feature approval or reserved headroom is implied. The feature owner must remeasure the actual integrated head and pass exact-head CI and independent review. Undo: revert this history-only change. 2026-10-25 reconciliation (admin-clarity client allocation vs main b4b76ecc): two fresh locked production builds each of pristine main and the frozen admin-clarity composition (feature head 8c3d03b9e; resolved composition rooted at commit a645f8fe3 and advanced through current main b4b76ecc; budget plus root and web lockfiles began byte-identical to main) on Node 24.22.1/npm 11.19.1 with database URL variables scrubbed and dependencies outside the synced trees measure pristine client JS 54/55 files at raw 253204/gzip 102307B and combined client JS 54/55 files at raw 254049/gzip 102671B in every respective build. At this base the composition delta is +845/+364B raw/gzip; current ceilings 253440/102400B therefore fail the combined tree by 609/271B. The canonical checker exits 1 at current ceilings in both combined builds. Minimality controls after each combined build prove raw 253952/gzip 102912B still fails raw by 97B, raw 254464/gzip 102656B still fails gzip by 15B, and raw 254464/gzip 102912B exits 0. Only the breached aligned client JS ceilings move: raw 253440 to 254464 (+1024B, 415B measured margin) and gzip 102400 to 102912 (+512B, 241B measured margin); no smaller 512B/256B-aligned pair fits. Client file cap stays 54/55, combined server stays 115/126 files at raw 1162056-1162058/gzip 329697-329699B, worker stays 2551/1219B, CSS stays 2 files at 2861/1019B, and startup stays 60000ms. Every other byte ceiling, file cap, checker, lockfile, application, test, workflow, security, accessibility, quality and exact-head review gate stays fixed and fail-closed. This is a narrowly measured budget allocation, not feature or release approval; the feature owner must remeasure the actual integrated head and pass exact-head CI and independent review. Undo: revert this allocation and history entry if the measured feature composition is removed. 2026-10-25 conflict reconciliation (admin-clarity, no additional allowance vs main d01519a8f7d8ffccc3bc266311ea85876c07372b): current main already carries client JS ceilings 254464B raw and 102912B gzip from an independently reviewed allocation. Clean measurement tree 0c1a78693014e2e249cf89f5abe74780ffabf523 merges the previously resolved frozen #1587 composition (feature head 8c3d03b9e41e532f802057fce59653600b8c1272, composition ancestor a645f8fe3) with this main. Two locked production builds per tree on Node 24.22.1/npm 11.19.1 have byte-identical 54-file client hash manifests within each pair: pristine 253204B raw/102307B gzip; combined 254049B raw/102671B gzip, delta +845/+364B. The unchanged canonical checker accepts both trees at current-main limits; combined margins are 415B raw and 241B gzip. Combined server 115/126 files at raw 1162573B/gzip 329807B, worker 2551/1219B, CSS 2/4 files at 2861/1019B, and startup limit 60000ms remain unchanged. Root/web committed lockfiles and all numeric ceilings equal main; database URL variables are absent from builds and dependencies are outside synced trees. Retain main history as an exact prefix and prior branch-only decisions once. This resolution changes history only, not any budget, source, test, checker, workflow or dependency. No additional headroom or feature/release approval is granted; the feature owner must remeasure the actual integration and pass exact-head CI and independent review. Startup latency and deployed UI were not measured. Undo: revert this history-only addition.
