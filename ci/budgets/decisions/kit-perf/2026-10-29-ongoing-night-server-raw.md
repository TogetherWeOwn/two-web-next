# 2026-10-29 decision: server JS raw ceiling 1203200 -> 1204224

This feature PR (#1907) admits one server-raw step after merging main
`e2590f419968e98522d3ce76f7834d4c42d7c0b6`. The ongoing-night verdict in
the shared schedule renderers plus the Kit detail projection and notice
grow the merged server bundle past the raw ceiling; the gzip axis needs
no change here because main already admits 337152B (host/join, #1825) and
the merged gzip fits under it. This replaces the earlier same-PR record
that admitted 337152B gzip against the previous base: that ceiling step
landed independently on main, so this PR no longer raises gzip at all.

## Measurements

Node 24.22.1, committed root and web lockfiles: `npm run build --prefix
web` followed by `npm run kit-perf` (gzip is the checker's per-file gzip
sum, read from the same build output).

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Pristine main `e2590f419` | 116 | 1202522 | 336738 | passes 1203200 / 337152 |
| Merged feature, build 1 | 116 | 1203881 | 336994 | raw exceeds 1203200 by 681 |
| Merged feature, build 2 | 116 | 1203883 | 336993 | raw exceeds 1203200 by 683 |

Worst feature delta is +1361 raw / +256 gzip bytes; the 2B raw rebuild
jitter is disclosed. The next lower 512B-aligned raw step (1203712)
still rejects the worst build by 171B, so 1204224 is the smallest
aligned ceiling that fits, with 341B margin. Merged gzip keeps 158B
margin under main's existing 337152B ceiling.

Client JS on the merged build is 53 files at 258363 raw / 103258 gzip
(main 258144 / 103202), inside the existing 258560 / 103680 ceilings.
Client CSS is unchanged at 2861 raw / 1019 gzip; the Worker entry stays
2551 raw / 1219 gzip. No file-count, startup, island, or user-facing
Lighthouse/a11y target changes.

## Bounded admission and tests

The raw step is +1024B, 0.0851% of the 1203200B ceiling, inside the
0.5% per-feature limit for byte budgets. The shipping-fragment oracle
pin moves with the fragment ceiling, so any other raw value still fails
the aggregation deep-compare. The checker test literals move to the
exact 1204224B ceiling and the 1204225B one-byte-over breach. Every
other plan axis stays pinned.

Undo: revert this feature PR, including this fragment step and its
admission controls. No runtime target, scanner, coverage floor,
required check, or test skip is relaxed.
