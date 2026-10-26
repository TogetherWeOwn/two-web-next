# Admin clarity: measured cost and shipping-budget coverage

## Current integration outcome

The conflict-resolution base is `2f9e60791d27378d4b07f0cfd615c8af86f04f76`.
While this proposal was in review, independent decisions
[#1785](https://github.com/TogetherWeOwn/two-web-next/pull/1785),
[#1799](https://github.com/TogetherWeOwn/two-web-next/pull/1799) and
[#1800](https://github.com/TogetherWeOwn/two-web-next/pull/1800) landed. Main now
already supplies client raw **254976** and server gzip **334080**. This integration
preserves that complete budget byte-for-byte, including all 605430 characters of
its historical comment (full-file SHA256
`13e6ffd97bb226cd92eaed1a7ec215539a3501005bcdbd84cfd7255a6978cc66`).
**No additional numeric allowance ships relative to this base.** Do not lower
main's reviewed server cap to recover the earlier 333824 boundary, and do not
reserve another allocation for this feature.

The only changes on main since the original measurement base are the budget and
two decision notes; no application, checker, manifest or lockfile changed. The
historical proposal and regression results below remain pinned evidence, not the
current shipping plan. Feature and release approval still require the actual
integrated head's exact-head CI and independent review. No gate is bypassed.

### Repeated proof on the conflict-resolution base

Rebuilt pristine main and the actual combined source twice each with the same
locked external dependency roots, Node 24.22.1 and the unchanged canonical
checker. The feature pin remains `ae7ad4acb0229bfc88d90b5a4641bc08a48c0b80`;
its scratch merge with the base has only a budget conflict, resolved to exact main
budget bytes for measurement. The resulting combined tree is
`e1a0f65fc6485571b6b5bfe914ba5d666cd144cd`. No feature branch was modified.
Manifests, lockfiles and checker are byte-identical across both measured trees.

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Client JS files | 54 / 54 | 54 / 54 |
| Client JS raw | 253949 / 253949 | 254769 / 254769 |
| Client JS gzip | 102273 / 102273 | 102569 / 102569 |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1176056 / 1176054 | 1178100 / 1178100 |
| Server JS gzip | 333150 / 333150 | 333637 / 333636 |

All four production builds and canonical checks pass without changing any main
ceiling. The tightest target margins are 207 client raw bytes and 443 server gzip
bytes. Worker entry remains 2551/1219 raw/gzip; CSS remains two files at
2833/1006. Client paths, sizes and SHA256 hashes match within each rebuild pair.
Startup timing was not measured; its bound remains 60000ms.

### Shipping regressions after base integration

The current shipping test file is incorporated unchanged from the independent
[boundary correction](https://github.com/TogetherWeOwn/two-web-next/commit/bb570b18de167d105e1d13ac88e70e2d37da0433),
SHA256 `211c6bad14002b67f44268e661ff1f35b45599551ac4e7b61e9a05bc3ae19786`.
Only three server-boundary literals differ from the earlier authored file: exact
334080, upper fixture 334081 and its diagnostic ceiling 334080. All helpers,
existing assertions and 17 shipping cases remain intact. The fixed 333639 server
feature-interval admission and client 254769/254976/254977 cases are unchanged.
The unchanged CI step already collects the file.

On the merged budget, the old file produces 80 passes and one expected stale
server-upper-bound failure. The corrected file passes 81/81 checker/inventory
cases with no skips. Independently repeated scratch controls use the real checker
and alter only one copied shipping field:

| Control | Passed / failed | Observed protection |
| --- | ---: | --- |
| Server gzip 334080 to 333568 | 78 / 3 | Fixed feature-interval and exact admissions reject |
| Server gzip 334080 to 333824 | 79 / 2 | Current exact admission rejects |
| Server gzip 334080 to 334081 | 80 / 1 | Fixed upper-bound refusal incorrectly admits |
| Client raw 254976 to 254464 | 78 / 3 | Fixed interval and exact admissions reject |
| Client raw 254976 to 254977 | 80 / 1 | Fixed upper-bound refusal incorrectly admits |
| Restored byte-identical main budget | 81 / 0 | Every regression passes, no skips |

The complete existing collected checker step passes 160/160. The Builder consumed
the authored bytes unchanged; no budget or production checker was changed to make
the tests pass. These results exercise checker behavior on synthetic complete
fixtures, not a substitute measurement of feature artifacts or a whole-app verdict.

Current ACT: preserve main's budget and add independently authored shipping-limit
coverage plus composition evidence. WHY: the original requested allowance has
already been supplied by reviewed base decisions. UNDO: remove only this note
and the added regressions through normal review if superseded; never revert
unrelated base allocations or historical records.

## Historical allocation proposal

Allocate only the measured combined cost of [admin clarity](https://github.com/TogetherWeOwn/two-web-next/pull/1587)
in this separate budget decision. Move client JavaScript raw bytes from **254464 to
254976** (one 512-byte step) and server JavaScript gzip bytes from **333568 to
333824** (one 256-byte step). Every other numeric ceiling, file cap, startup bound,
checker, dependency and application file stays unchanged. Preserve the budget's
complete `$comment` history byte-for-byte. Independently authored regression cases
protect the shipping allocations without changing existing assertions.

The [earlier no-allowance result](kit-admin-clarity-client-budget.md) describes its
pinned historical base, not this newer composition. This allocation is neither
feature approval nor release approval. The feature owner must incorporate the
reviewed decision, remeasure the actual integrated head, and pass exact-head CI and
independent review. No audit or gate is skipped or disabled.

## Pinned inputs and method

- Main: `847bf4647def72aebcb84d1defa9ec8726afa207`.
- Combined feature head: `ae7ad4acb0229bfc88d90b5a4641bc08a48c0b80`.
- Combined source tree: `d63260285d8a07a67314e5b26c852679c4ca5cfb`.
- Runtime: Node `24.22.1`, npm `11.19.1`.

Root and web package manifests and committed lockfiles are byte-identical between
the trees. Install each locked dependency root outside the synced trees with
`npm ci --include=dev --no-audit --no-fund`; both measurement trees use the same
root and web dependency installations. Remove all database-URL variables from the
build environment. Build twice per tree:

```sh
NODE_ENV=production WRANGLER_SEND_METRICS=false npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four builds exit 0. Pristine main passes the unchanged canonical checker twice;
the combined feature fails both times on exactly client raw and server gzip.
Gzip sizes use the canonical Node checker, not another compressor.

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Client JS files | 54 / 54 | 54 / 54 |
| Client JS raw | 253949 / 253949 | 254769 / 254769 |
| Client JS gzip | 102273 / 102273 | 102569 / 102569 |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1176056 / 1176054 | 1178100 / 1178102 |
| Server JS gzip | 333150 / 333151 | 333637 / 333636 |

Worker entry stays 2551/1219 raw/gzip; client CSS stays 2 files at 2833/1006.
The startup limit stays 60000ms; startup latency was not measured. All 54 client
paths, raw sizes and SHA-256 hashes are identical within each tree's rebuild pair.
Server runtime chunks have small build-generated variation; the two admin chunks
are byte-identical within each pair. The allocation covers both observed builds.

## Attribution and source-optimization assessment

The client delta is **+820 raw / +296 gzip**. Forty of the 54 client files have
identical content across the two trees. The raw growth is entirely explained by:

| Client output | Raw delta | Gzip delta |
| --- | ---: | ---: |
| Shared AdminShell chunk (`CVVeJUzZ.js` to `CsseizEO.js`) | +262 | +137 |
| Activity-log node 12 | +44 | +26 |
| Events-list node 13 | +204 | +44 |
| Event-editor node 14 | +216 | +65 |
| Featured-list node 16 | +50 | +20 |
| Join-attempts node 19 | +44 | +21 |

These rows sum to +820 raw / +313 gzip. The remaining renamed import-bearing
chunks are raw-size-neutral and contribute -17 gzip bytes, for +296 overall.
The shared snippet announces dropped searches once for all five pages; the other
changes add per-event accessible action names and explicit UTC headings. No new
client chunk is added. The admin layout retains `csr = false`; these are structural
SvelteKit outputs, not newly enabled hydration. No `drizzle-orm` code enters the
client.

On the retained second build, server growth is **+2048 raw / +485 gzip**:
`chunks/admin.js` adds 1746/397 raw/gzip bytes and `chunks/admin-errors.js` adds
298/97. The latter includes the shared AdminShell snippet under the existing SSR
chunk grouping. The remaining runtime chunks contribute +4/-9. These changes
reflect the Hono and Kit markup twins plus shared filter normalization, not a new
runtime dependency or route.

The shared notice and existing SSR co-compression already avoid repeated notice
implementations and separate compression overhead. Removing required labels,
notice copy or UTC context would change the feature contract. Changing compiler
settings or unrelated markup to save these bytes would broaden this slice. Accept
the attributed feature cost rather than introduce that behavior risk or speculative
optimization. No application edit ships with this decision; feature acceptance
tests remain unchanged.

## Minimality and unchanged enforcement

Run the unchanged canonical checker against the retained combined artifacts with
isolated budget copies (never edit the checker or the feature artifacts):

| Client raw ceiling | Server gzip ceiling | Expected and observed exit |
| ---: | ---: | --- |
| 254464 | 333568 | 1: both fail |
| 254976 | 333568 | 1: server gzip fails |
| 254464 | 333824 | 1: client raw fails |
| 254976 | 333824 | 0: every group fits |
| 254768 (measured minus one) | 333824 | 1: client raw fails |
| 254976 | 333635 (measured minus one) | 1: server gzip fails |

One smaller aligned step on either target is the existing failing ceiling. The
proposed pair leaves 207 raw client bytes and at least 185 server gzip bytes across
all observed builds, deliberately far below an x1.25 allocation. Client gzip remains
102912, server raw remains 1203200, file caps remain 55/126, CSS remains
3072/1024/4, and worker remains 3584/1536. Missing or invalid evidence and new files
still fail closed through the unchanged inventory and checker.

Two further production builds of the exact combined source with only the proposed
budget overlay both pass the canonical checker: client 254769/102569 both times,
server 1178100/333639 then 1178102/333636 raw/gzip. A production build of the
standalone decision tree (main plus this budget and note, without the feature)
also passes: client 253949/102273, server 1176054/333152. No feature source or
feature acceptance-test changes ship on the decision branch.

## Historical shipping-regression proof (head `6209d6981`)

`ci/check-kit-perf.test.mjs` adds 17 independently authored cases, incorporated
unchanged from [the test-only handoff](https://github.com/TogetherWeOwn/two-web-next/commit/883b5f7bbe76cbb00c31c26bcf36a0928a8dd620).
The existing CI checker step already runs this file; no workflow or production
checker change is needed. Each case copies the committed budget byte-for-byte
into complete hermetic artifact fixtures and invokes the real `runJson()` checker.
The fixtures use actual raw bytes and default Node `gzipSync` per-file totals,
not mocked measurements or a fixture-generated budget.

Fixed client raw evidence at 254769 and 254976 bytes must pass; 254977 must fail.
Fixed server gzip evidence at 333639 and 333824 bytes must pass; 333825 must fail.
These literals do not follow a changed cap, so accidental over-allocation cannot
move the refusal boundary. Client gzip 102912/102913 and server raw
1203200/1203201 exercise the unchanged other-axis boundaries. Additional cases
retain Worker, CSS and file-count refusals. Every case verifies measured totals,
the complete four-group inventory and the single targeted refusal, with every
unrelated group and axis still in bounds. Synthetic fixtures establish checker
behavior, not a new measurement of feature artifacts.

Reproduce the shipping regression suite:

```sh
node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs
```

The suite passes 81/81 with no skips on Node 24.22.1. Independent scratch controls
change only one shipping budget field at a time and leave the checker unchanged:

| Control | Original tests | With shipping regressions |
| --- | --- | --- |
| Server gzip reverted to 333568 | 64/64 pass | 78 pass, 3 fail; fixed interval admission rejects |
| Client raw reverted to 254464 | 64/64 pass | 78 pass, 3 fail; fixed interval admission rejects |
| Server gzip over-allocated to 333825 | Not rerun | 80 pass, 1 fail; fixed upper-bound refusal admits |
| Client raw over-allocated to 254977 | Not rerun | 80 pass, 1 fail; fixed upper-bound refusal admits |
| Restored shipping budget | 64/64 previously passed | 81/81 pass, no skips |

The Builder independently repeated all four controls on the decision tree plus
the unchanged authored test bytes and restored the original budget afterward.
Neither shipping ceiling, existing assertion nor enforcement code was edited in
this review-fix round. A later intentional budget decision must deliberately
update the corresponding fixed regression boundary with its own evidence.

Historical ACT: propose a separate, independently reviewed two-ceiling allocation. WHY: repeated
same-dependency measurements attribute a real combined cost that pristine main does
not incur. UNDO: revert only this allocation and note if the feature is abandoned;
do not revert unrelated budget history or its independently reviewed ceilings.

These measurements establish build-size behavior only. They do not establish
browser behavior, accessibility, startup timing or deployment health. No staging,
production, deployment, host action, migration or new spend is involved.
