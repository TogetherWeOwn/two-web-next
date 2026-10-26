# Global waitlist: measured server-gzip cost and composition allowance

## Allocation proposal

Move Kit server JavaScript gzip bytes from **334080 to 334848** (three
256-byte steps, +768) for the global-waitlist roster composition on current
main. Every other numeric ceiling, file cap, startup bound, checker,
inventory, workflow, runtime, test, manifest, lock and constraint stays
unchanged. The budget's complete incoming `$comment` history is preserved
byte-for-byte (622700 characters after reconciling current main). The independent
shipping-regression correction adds fixed literals for this measured allowance
alongside main's existing allocations: interval witness 334660, exact admission
334848, upper fixture 334849 and diagnostic ceiling 334848.

This allocation is neither feature approval nor release approval. The feature
owner must incorporate the reviewed decision, remeasure the actual integrated
head, and pass exact-head CI and independent review. No audit or gate is
skipped or disabled.

## Pinned inputs and method

- Main: `91b66a68d2d37bd2c717f3a75299300d3617b811` (tree
  `befcb537612fc61dd36146b787f54500adc945aa`).
- Combined source tree: `57e2f308628694dde7fa6e8d04eac456fbaebb06`, built by
  applying the frozen six-source-file waitlist delta (SHA256
  `7c4f49d3501d5d4ac37feb2b9c71ab18d03e44b2d7f628085985364a17c31d6c`)
  onto main with `git apply` (exit 0, no conflicts, no test changes):
  `src/admin/kit-event-edit.ts`, `src/admin/pages/event-form-roster.tsx`,
  `src/admin/reads.ts`, `src/admin/table-list.ts`,
  `src/db/read-classification.ts`,
  `web/src/routes/admin/events/[key]/+page.svelte`. The frozen delta is
  byte-identical to the `2fa2ef088..fb9d676c` product-source diff on branch
  `feat/admin-global-waitlist-order`; that branch's head `c7a4043660d88d46`
  adds only test corrections and screenshot documentation over source head
  `fb9d676cceee174cd5dd5638a2de67e83a69e1e4`.
- Runtime: Node `24.22.1`, npm `11.19.1`.

Root and web package manifests and committed lockfiles are byte-identical
between the trees (md5 `45c7a8b0c15e197ef4ba209722fc33a3` and
`6d9e46eea2217f1b0aaea10bbc7e605f`). Install each locked dependency root
outside the synced trees with `npm ci --include=dev --no-audit --no-fund`;
both measurement trees use the same root and web dependency installations.
Remove all database-URL variables from the build environment. Build twice per
tree:

```sh
NODE_ENV=production WRANGLER_SEND_METRICS=false npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four builds exit 0. Pristine main passes the unchanged canonical checker
twice; the combined composition fails both times on exactly server gzip.
Gzip sizes use the canonical Node checker (`gzipSync` per-file totals), not
another compressor.

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Client JS files | 54 / 54 | 54 / 54 |
| Client JS raw | 253949 / 253949 | 254249 / 254249 |
| Client JS gzip | 102273 / 102273 | 102421 / 102421 |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1178762 / 1178762 | 1181315 / 1181315 |
| Server JS gzip | 333874 / 333872 | 334660 / 334659 |

Worker entry stays 2551/1219 raw/gzip; client CSS stays 2 files at
2833/1006. The startup limit stays 60000ms; startup latency was not
measured. This reproduces the reported `2fa2ef088` evidence (pristine
333874, combined 334659, increment 785) within 2 bytes on the current base;
both agree the composition breaches the 334080 ceiling by 579-580 bytes
with a feature increment of about 786 bytes.

## Attribution and source-optimization assessment

Server growth is **+2553 raw / +786 gzip** on build 1 and **+2553 raw /
+787 gzip** on build 2. Exact per-chunk attribution (canonical checker
arithmetic on retained build-2 artifacts):

| Server output | Raw delta | Gzip delta |
| --- | ---: | ---: |
| `chunks/admin.js` | +2553 | +784 |
| `chunks/internal.js` | 0 | +1 |
| `nodes/14.js` | 0 | +2 |

The growing chunk carries the feature: the set-based full-event PostgreSQL
rank projection in the admin reads path, its fail-closed keyed-read SQL
classifier entries, and the read-only roster view, model and copy for the
moderator event-edit page. No new file, route, import or dependency is
added. The residual same-raw chunks shift by at most 2 gzip bytes each from
embedded ordering and hash substitution plus ordinary build variation.

Client growth is +300 raw / +148 gzip and fits with 727 raw and 491 gzip
bytes to spare. Pristine server headroom is only 206-208 bytes, so the
minimal +786-byte feature cannot fit the existing ceiling by construction.
A source-sharing experiment (common SQL prefix between the projection and
its classifier) saved only 16 gzip bytes and was discarded rather than
adding indirection that still fails; removing required rank copy or
classifier coverage would change the feature contract; changing compiler
settings or unrelated markup to save these bytes would broaden this slice.
Accept the attributed feature cost rather than introduce that behavior risk
or speculative optimization. No application edit and no feature
acceptance-test change ships with this decision.

## Minimality and unchanged enforcement

Run the unchanged canonical checker against the retained combined artifacts
with isolated budget copies (never edit the checker or the feature
artifacts):

| Server gzip ceiling | Expected and observed exit |
| ---: | --- |
| 334080 (current) | 1: server gzip fails |
| 334658 (retained measured minus one) | 1: server gzip fails |
| 334659 (retained measured) | 0: every group fits |
| 334592 (one aligned step below proposal) | 1: server gzip fails |
| 334848 (proposed) | 0: every group fits |

`ceil(334660 / 256) * 256 = 334848`: the proposal is the smallest
256-byte-aligned ceiling covering the maximum observed 334660 bytes across
all builds. One aligned step below it still fails. The proposal leaves at
least 188 server gzip bytes across all observed builds, deliberately far
below an x1.25 allocation. Pristine main also passes under the proposed
ceiling. Client raw stays 254976, client gzip stays 102912, server raw
stays 1203200, file caps stay 55/126, CSS stays 3072/1024/4, and worker
stays 3584/1536. Missing or invalid evidence and new files still fail
closed through the unchanged inventory and checker.

A production build of the standalone decision tree (main plus this budget,
note and regression alignment, without the feature) passes the canonical
checker: client 253949/102273, server 1178764/333874 raw/gzip, exit 0. No
feature source or feature acceptance-test changes ship on the decision
branch.

## Initial shipping-regression proof

Before main's independent mapping change in #1814,
`ci/check-kit-perf.test.mjs` moved only the three server gzip boundary
literals to the new ceiling, as the suite's own history requires of an
intentional budget decision. All helpers, existing assertions and remaining
cases were untouched. The following results record that original head; the
current-base reconciliation below supersedes its test-file alignment. Reproduce:

```sh
node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs
```

The suite passes 81/81 with no skips on Node 24.22.1. Without the alignment,
the suite fails exactly the stale `server gzip one byte over` case (334081
now admits). Independent scratch controls change only the copied shipping
ceiling and leave the checker unchanged:

| Control | Passed / failed | Observed protection |
| --- | ---: | --- |
| Server gzip reverted to 334080 | 28 / 2 | Exact admission and upper-bound diagnostic reject |
| Server gzip over-allocated to 334849 | 29 / 1 | Fixed upper-bound refusal incorrectly admits |
| Restored shipping budget | 30 / 0 | Every regression passes, no skips |

These results exercise checker behavior on synthetic complete fixtures, not
a substitute measurement of feature artifacts or a whole-app verdict.

## Current-base conflict reconciliation

The preceding measurements and literal controls record the original decision
on `91b66a68d`. After #1779 and #1814 merged, reconcile onto main
`4d9ebeee5b311dd5bedb606a57ea91183625c3c7` (tree
`e14030ae33c63ca1c1b791d0a044e5d7578bedeb`). Preserve the complete incoming
622700-character history, including #1779's allocation record. The only numeric
budget difference from this base remains server gzip 334080 to 334848.

Rerun the same frozen six-source-file patch on this base, with the same locked
dependencies and Node 24.22.1/npm 11.19.1, in two archived scratch trees; no
database-URL variable is available to either measurement build. The combined
source tree is `1afde3506e7b9694e65af7fe6c36c3491e019f7d`.

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Server JS raw | 1178764 / 1178764 | 1181315 / 1181317 |
| Server JS gzip | 333874 / 333876 | 334660 / 334662 |
| Client JS raw | 253949 / 253949 | 254249 / 254249 |
| Client JS gzip | 102273 / 102273 | 102421 / 102421 |

All four builds exit 0. Both pristine checks pass; both combined checks fail
only server gzip under 334080. Worker, CSS and file counts remain as above.
Build-2 server attribution is `chunks/admin.js` +2553 raw/+784 gzip;
`chunks/instance.js` 0/+2, `chunks/internal.js` 0/-2 and `nodes/14.js` 0/+2.
These sum to +2553/+786. The maximum measured 334662 still needs the same
smallest aligned ceiling, 334848, now leaving **186 bytes**. On retained
build-2 artifacts the unchanged checker rejects 334080, 334592 and 334661,
and admits 334662 and 334848. The merged standalone decision tree builds and
passes too: server 1178764 raw/333873 gzip, client 253949/102273, exit 0.

Main #1814 replaced the original boundary rows with an explicit fixed-literal
334080/335104 mapping. Keeping main's test file unchanged with the measured
334848 budget reproduces four refusals (allocation control plus three server
cases), 27/31 passing and no skips. This is an unsupported allocation in the
oracle, not evidence for widening the measured budget to 335104. An independent
test owner supplies the narrowly scoped 334848 mapping; the budget owner
incorporates that file unchanged, preserving both existing allocations and
all other-axis fixtures. The interval witness is fixed at the observed 334660,
exact admission at 334848 and one-byte-over refusal at 334849; no fixture is
computed as `cap` or `cap + 1`.

Consume the independent correction from
`5fce978627370f459a0b9da2f9a249ac2b4d3ea2` byte-for-byte (owned file
`ci/check-kit-perf.test.mjs`, SHA256
`3425c29fe3a2cd3b1ef71c02d034b15b03617c9de079fead1b3f266155da115e`).
The collected eight-file Kit checker suite passes **161/161**, with no skips.
Scratch controls with the unchanged checker prove 334080, 334848 and 335104 each
pass 31/31; unsupported 334849, 335105 and 334592 each fail exactly the allocation
control and three server cases (27 pass/4 fail). Client raw +1 to 254977 still
fails its one-byte-over case; reverting client raw to 254464 still fails three
client cases. Every other boundary fixture and assertion is unchanged from
main. Lint, typecheck, doc links, floor guard and strict test inventory pass;
full `npm run check`, browser suites and staging checks were not run for this
non-UI decision. `context-pack --base origin/main` still fails at tool startup
(`RuntimeError: MCP server exited`); manual consumer audit covers the canonical
checker, its shipping suite and the CI Kit selftest collection, with no product
caller or changed function signature.

ACT: allocate three 256-byte server-gzip composition steps with their
measurement record and regression alignment. WHY: repeated same-dependency
measurements attribute a real +786-byte combined cost that pristine main
does not incur and cannot fit. UNDO: revert only this allocation, note and
alignment if the feature is abandoned; do not revert unrelated budget
history or its independently reviewed ceilings.

These measurements establish build-size behavior only. They do not establish
browser behavior, accessibility, startup timing or deployment health. No
staging, production, deployment, host action, migration or new spend is
involved.
