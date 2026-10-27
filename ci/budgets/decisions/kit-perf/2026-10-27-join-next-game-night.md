# 2026-10-27 decision: join next-game-night Kit client and server allocations

Measured-budget allocation for the Kit cost of the join page's "Next game
night" card (server load read, page markup, shared time formatter). Each
ceiling that moves does so by the least aligned step that covers the
measured composition; every other limit is unchanged. The first table is the
original three-ceiling measurement; the re-measure sections track main
moving underneath (latest: main `e37975a07`, all three axes move one step).

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

### Re-measure on the merged tree (main `3baeb3793`)

Main moved after the first allocation (event-time #1803, event-detail #1895,
which raised client raw to 257024 and client gzip to 103168). Merged tree,
two builds, identical:

| Axis | Merged tree | Main ceiling | This branch ceiling | Margin |
| --- | --- | --- | --- | --- |
| client JS raw | 256535 | 257024 | 257024 (main's, unchanged) | 489 B |
| client JS gzip | 103261 | 103168 (over by 93) | 103424 | 163 B |
| server JS gzip | 336262-336263 | 335872 (over by 391) | 336384 | 121 B |

The raw client ceiling now comes from main, so this branch no longer raises
it. Client gzip and server gzip each take one 256 B step above main's
ceiling (103168 to 103424, 335872 to 336384; 336128 rejects the server
composition by 135 B, and 103168 rejects client gzip by 93 B). File counts
(client 55/55, server 116/126), worker, CSS and startup fit unchanged.

### Second re-measure on the merged tree (main `e37975a07`)

Main grew the Kit bundles again (Happening-now #1907/#1923 raised server
gzip to 336128; archive search #1487, the discovery cap #1913 and the
dependency bumps landed on top). Merged tree, three builds, worst governs
(server gzip read 336436/336437/336437; client axes identical):

| Axis | Merged tree | Main ceiling | This branch ceiling | Margin |
| --- | --- | --- | --- | --- |
| client JS raw | 257049 | 257024 (over by 25) | 257536 | 487 B |
| client JS gzip | 103444 | 103168 (over by 276) | 103680 | 236 B |
| server JS gzip | 336437 | 336128 (over by 309) | 336640 | 203 B |

Client raw and gzip take the 257536 / 103680 ceilings that main's
event-detail ladder (#1911) already admits, so no new client ladder entry
is needed (257024 rejects by 25 B, 103424 rejects by 20 B). Server gzip
takes one 256 B step above the highest ceiling that rejects it (336384
rejects by 53 B; 336639 rejects by 202 B), and 336640 is not yet admitted
by the ladder. File counts (client 55/55, server 116/126),
server raw (1189761/1203200), worker, CSS and startup fit unchanged.
Final raised values: client raw 257536, client gzip 103680, server gzip
336640.

`ci/budget-fragments.test.mjs` moves with the fragments. The additive
allocation entries in `ci/check-kit-perf.test.mjs` are owned by the test
correction handed back before this lands. No checker, gate, mask or
exclusion changes; over-ceiling fixtures still fail closed. Not a feature or
release approval. Undo: restore main's ceilings (client raw 257024, client
gzip 103168, server gzip 336128) in `ci/budgets/kit/` (the join card then
no longer fits) and delete this file; the 336640 test-ladder entry then become unused but harmless.

## Ported monolith history (verbatim, leading separator space kept)

This branch appended the record below to `ci/kit-perf-budget.json` `$comment`
before the budget-fragment split (#1858) deleted that file; it is preserved
here instead of being lost with the monolith. Earlier history stays frozen in
`0000-legacy-history-through-2026-10-26.md`. Its client file cap move
(52 to 53) is superseded: the cap is now 55 and 54 files are built.

 2026-10-22 decision (join next-game-night): the Kit join page renders the teaser's time label through the shared src/events/date-format formatter (cardTimeLabel/isValidZone, the same import the home page uses), so Vite hoists date-format out of the home client node into a shared chunk now that /join is its second importer (client nodes 7 and 25 both list the date-format chunk; the join route has no other client entries). Measured on this branch (Node 24.22.1, locked deps package-lock md5 eb2ebf45cb6949730200e6daef427b60 / web md5 e0531552dd4744903b123ff6e46b8e5a, npm run build --prefix web): client 53 files raw 246277/gzip 99122 under unchanged byte ceilings (247296/99840, margins 1019/718B); pristine origin/main (3eb3a6362) rebuilt the same way measures 52 files raw 245149/gzip 98630. The +1128/+492 delta is the shared chunk plus import stubs, not new code. Client file cap moves 52 to 53 exact, following the recent exact-move precedent (#1594, #1570). Server (122/123 files, raw 1103871/1203200, gzip 324465/327680), worker, CSS and startup fit unchanged.
