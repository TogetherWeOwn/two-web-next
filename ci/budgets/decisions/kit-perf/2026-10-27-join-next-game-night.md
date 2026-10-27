# 2026-10-27 decision: join next-game-night Kit client and server allocations

Measured-budget allocation for the Kit cost of the join page's "Next game
night" card (server load read, page markup, shared time formatter). Three
ceilings move, each by the least aligned step that covers the measured
composition; every other limit is unchanged.

Measured with `npm run build --prefix web` then `node ci/check-kit-perf.mjs`
(Node 24.22.1, locked deps; two builds per tree on main `cb0f15736` plus its
`a05e3719a` follow-up, pristine tree vs this branch):

| Axis | Pristine main | This branch | Old ceiling | New ceiling | Margin |
| --- | --- | --- | --- | --- | --- |
| client JS raw | 254926 | 256343 | 256000 | 256512 | 169 B |
| client JS gzip | 102621 | 103218 | 103168 | 103424 | 206 B |
| server JS gzip | 335351-335353 | 335939-335941 | 335360 | 336128 | 187 B |

- Client raw/gzip grow +1417/+597 B: `/join` is now a second importer of the
  shared time formatter, so Vite hoists it into its own shared chunk and adds
  import stubs to the home and join client nodes. The page needs the
  formatter itself (the acceptance suite renders the page from `nextEvent`
  data, so the label cannot be pre-computed in the load without changing the
  load-data contract).
- Server gzip grows +588 B: the join load, the page block and the Hono
  screen block. Pristine main leaves only 7-9 B of headroom under 335360, so
  no join change fits without a raise. Raw server bytes, file counts (client
  54/55, server 116/126), worker, CSS and startup limits fit unchanged.
- Server gzip needs the 336128 step: 335872 stays 67-69 B short.

### Re-measure on the merged tree (main `d939263e8`)

Merging the event-time commit (#1803) into this branch re-measured both
server and client over the first allocation (two builds, identical):

| Axis | Merged tree | Ceiling | Next least aligned step | Margin |
| --- | --- | --- | --- | --- |
| client JS raw | 256535 | 256512 (over by 23) | 256768 | 233 B |
| client JS gzip | 103261 | 103424 | unchanged | 163 B |
| server JS gzip | 336262-336263 | 336128 (over by 134-135) | 336384 | 121 B |

Client raw and server gzip each move one 256 B step above the first
allocation (256512 to 256768, 336128 to 336384); 336128 rejects the merged
server composition by 135 B and 256512 rejects the client by 23 B. Client
gzip, file counts (client 55/55, server 116/126), worker, CSS and startup
fit unchanged. Final raised values: client raw 256768, client gzip 103424,
server gzip 336384.

`ci/budget-fragments.test.mjs` moves with the fragments. The additive
allocation entries in `ci/check-kit-perf.test.mjs` are owned by the test
correction handed back before this lands. No checker, gate, mask or exclusion
changes; over-ceiling fixtures still fail closed. Not a feature or release
approval. Undo: revert the three fragment values (client raw 256000, client gzip 103168, server gzip 335872 on the current main) and delete this file; the 336128/336384 and 256512/256768 test-ladder entries then become unused but harmless.

## Ported monolith history (verbatim, leading separator space kept)

This branch appended the record below to `ci/kit-perf-budget.json` `$comment`
before the budget-fragment split (#1858) deleted that file; it is preserved
here instead of being lost with the monolith. Earlier history stays frozen in
`0000-legacy-history-through-2026-10-26.md`. Its client file cap move
(52 to 53) is superseded: the cap is now 55 and 54 files are built.

 2026-10-22 decision (join next-game-night): the Kit join page renders the teaser's time label through the shared src/events/date-format formatter (cardTimeLabel/isValidZone, the same import the home page uses), so Vite hoists date-format out of the home client node into a shared chunk now that /join is its second importer (client nodes 7 and 25 both list the date-format chunk; the join route has no other client entries). Measured on this branch (Node 24.22.1, locked deps package-lock md5 eb2ebf45cb6949730200e6daef427b60 / web md5 e0531552dd4744903b123ff6e46b8e5a, npm run build --prefix web): client 53 files raw 246277/gzip 99122 under unchanged byte ceilings (247296/99840, margins 1019/718B); pristine origin/main (3eb3a6362) rebuilt the same way measures 52 files raw 245149/gzip 98630. The +1128/+492 delta is the shared chunk plus import stubs, not new code. Client file cap moves 52 to 53 exact, following the recent exact-move precedent (#1594, #1570). Server (122/123 files, raw 1103871/1203200, gzip 324465/327680), worker, CSS and startup fit unchanged.
