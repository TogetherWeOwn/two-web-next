# Restored-write client and server gzip allocation

Reconciled against main `0f8fdd17f21abe7d0f7c015001b9415b180efe99`, after
[#1858](https://github.com/TogetherWeOwn/two-web-next/pull/1858) split the budget
monolith. This prerequisite allocates only measured capacity for the frozen
[#1521](https://github.com/TogetherWeOwn/two-web-next/pull/1521) composition at
`cc1ce07c9458a806f3efaae097eac93161876f94`; it is not feature or release approval.

## Current allocation

- Preserve incoming client raw **256000B**, independently allocated by #1798.
  This branch adds no raw allowance.
- Client gzip **102912 -> 103168B**, one minimum 256B step. Retained measured
  composition **102950B** leaves **218B**. The lower step rejects by **38B**.
- Server gzip **335104 -> 335360B**, one minimum 256B step. Retained measured
  composition **335156B** leaves **204B**. The lower step rejects by **52B**.
- Every other cap, canonical inventory, loader and checker stays unchanged.
  Margins are not reserved capacity. Startup was not runtime-measured.

## Measurement provenance

Two retained locked Node 24.22.1/npm 11.19.1 builds per tree measured pristine
client **253949/102273B**, server **1178762/333875B**, and frozen composition
client **255735/102950B**, server **1182889/335156B**. Client files remain 54;
server files increase 115 to 116. Worker **2551/1219B** and CSS **2833/1006B**,
two files, fit unchanged.

No fresh build is claimed for this reconciliation. Git object comparison proves
`web/` tree `7eabd9d5aa22c48397763dd9e6354282b89fe20b` and both lockfiles are
byte-identical to the retained inputs. Both checkers now use the main fragment
loader; fresh fixture tests must verify their unchanged enforcement semantics.

Keep both frozen legacy-history archives and all incoming decision files
byte-for-byte. The preceding branch-only decision is preserved verbatim below;
its historical raw increment is superseded by main and adds no current capacity.
The independently authored shipping-test union must preserve incoming raw
coverage, literal gzip boundaries and unsupported-allocation rejection.

## Rollback

Revert only these two 256B gzip increases and this decision file, reconciling
companion literal tests. Keep incoming raw capacity and frozen history intact.
No runtime or data rollback applies. Required exact-head CI and independent
review remain mandatory.

## Preserved pre-fragment branch-only record

 2026-10-26 current-base allocation (restored-write prerequisite for #1521 at frozen cc1ce07c9458a806f3efaae097eac93161876f94): reconcile main a902d670f50dddd0576cdb73606038aff957fa7d after merged inventory-return server gzip #1826, upcoming search matches #1812 and agent-events bounds #1819. Preserve its complete 623430-character decision history verbatim; replace only this branch's superseded allocation once, without stacking. Incoming drift from 4d9ebeee5 leaves web/ tree hash 7eabd9d5aa22c48397763dd9e6354282b89fe20b and both lockfiles byte-identical, so the retained four-build measurement stands without re-execution in this continuation. Two retained locked Node 24.22.1/npm 11.19.1 production builds per tree; dependencies outside checkout, every database URL variable absent. Root/web lockfile SHA-256 023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d / feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e. Pristine client 54 files raw 253949/gzip 102273B, server 115 files raw 1178762/gzip 333875B. Composition client 54 files raw 255735/gzip 102950B, server 116 files raw 1182889/gzip 335156B; new main rejects composition only on client raw +759B, client gzip +38B and server gzip +52B over its 335104 ceiling. Paired cost client +1786/+677B, server +4127 raw/+1281 gzip and one server file. Credit #1826's independent server step: increments over current main are +1024/+256/+256. Raise client.js.maxRawBytes 254976->256000 (two minimum 512B steps, 265B margin), client.js.maxGzipBytes 102912->103168 (one minimum 256B step, 218B margin), server.js.maxGzipBytes 335104->335360 (one minimum 256B step, 204B worst margin). One lower step rejects client raw by 247B, client gzip by 38B and server gzip by 52B. Eighteen retained-output controls call the unchanged checker: main passes pristine twice/rejects composition twice; proposed passes all four; exact actual JS raw/gzip/file counts pass, one byte/file under each client/server axis rejects. Zero emitted client files matching drizzle-orm, postgres, kit-session, DATABASE_URL or SESSION_SECRET; restoredWrite in 26 composed chunks and zero pristine. This bounded string scan is not full data-flow proof. Keep server raw, both JS file caps, Worker 2551/1219B, CSS 2 files 2833/1006B (18B gzip margin) and startup 60000ms unchanged; startup not runtime-measured. No feature, dependency, checker, workflow, masking or security edit ships in this budget half relative to main; the companion shipping pins already support the 335360 allocation with lower 335104 rejecting by 52B. No feature approval, gate waiver or reserved capacity; remeasure advanced compositions. Undo only +1024B client raw/+256B client gzip/+256B server gzip and this appended record, preserving independent main history and limits.
