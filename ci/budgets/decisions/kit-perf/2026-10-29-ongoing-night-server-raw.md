# 2026-10-29 decision: admit the ongoing-night server composition

This feature PR (#1907) reconciles its byte-only allocation after the
reported conflict with main `bae17ea8411abb6599c4dcf3fddacd5d8cdab015`.
Main's agent-event statement deadlines now consume the earlier raw and
gzip margin. Its budget controls were preserved before measuring the
combined tree; the ongoing-night verdict in the shared schedule renderers
and the Kit detail projection/notice add the same bounded server cost.
No duplicate or unneeded import accounts for the growth. The calendar
revision-race correction changes the separately served island, not the
Kit server bundle.

## Measurements

Node 24.22.1, committed root and web lockfiles: `npm run build --prefix
web` followed by `npm run kit-perf` (gzip is the checker's per-file sum).
Pristine main and the feature used the same dependencies and toolchain.

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Pristine main `bae17ea84` | 116 | 1203932 | 337032 | passes 1203968 / 337152 |
| Composed feature, build 1 | 116 | 1205293 | 337286 | exceeds main by 1325 raw / 134 gzip |
| Composed feature, build 2 | 116 | 1205293 | 337286 | passes 1205504 / 337408 |

Feature delta: +1361 raw / +254 gzip bytes. The smallest fitting
256B-aligned ceilings are 1205504 raw (211B margin) and 337408 gzip
(122B margin). The immediately lower raw step, 1205248, rejects by 45B;
the previous gzip ceiling, 337152, rejects by 134B.

Client JS is 53 files at 258363 raw / 103258 gzip (main 258144 / 103202),
inside the unchanged 258560 / 103680 ceilings. Client CSS is unchanged at
2861 raw / 1019 gzip; the Worker entry stays 2551 raw / 1219 gzip.
No file-count, startup, Lighthouse, accessibility or other class-A target
changes. Exact previous-head class-A CI passed; fresh CI and independent
review of the composed correction are still required before merging.

## Bounded admission and tests

Against current main, raw rises by 1536B (0.1276%) and gzip by 256B
(0.0759%), each below the 0.5% per-feature byte-budget limit. The shipping
oracle explicitly admits these allocations while retaining main's
history. Fixed 1205504 / 1205505 raw and 337408 / 337409 gzip controls
prove exact-fit and one-byte-over behavior; unsupported neighboring
allocations still fail. Every other plan axis stays pinned.

This supersedes the earlier same-PR raw-only 1204224 admission measured
on `e2590f419`: pristine main was 1202522 raw / 336738 gzip and that
composition's worst was 1203883 / 336994. The new main's independent
1203968 raw admission is not counted again as this feature's raise.

Undo: revert this feature PR, including its fragment changes and
admission controls. No runtime target, scanner, coverage floor,
required check, or test skip is relaxed.
