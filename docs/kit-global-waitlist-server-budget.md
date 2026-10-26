# Global waitlist: measured server-gzip cost and composition allowance

## Allocation proposal

Move Kit server JavaScript gzip bytes from **334080 to 334848** (three
256-byte steps, +768) for the global-waitlist roster composition on current
main. Every other numeric ceiling, file cap, startup bound, checker,
inventory, workflow, runtime, test, manifest, lock and constraint stays
unchanged. The budget's complete `$comment` history is preserved byte-for-byte
(621575 characters). The three fixed server gzip shipping-regression literals
move with the ceiling: exact admission 334848, upper fixture 334849 and its
diagnostic ceiling 334848.

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

## Shipping-regression proof

`ci/check-kit-perf.test.mjs` moves only the three server gzip boundary
literals to the new ceiling, as the suite's own history requires of an
intentional budget decision. All helpers, existing assertions and remaining
cases are untouched. Reproduce:

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
