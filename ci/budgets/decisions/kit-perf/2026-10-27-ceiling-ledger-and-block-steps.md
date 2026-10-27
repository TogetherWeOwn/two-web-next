# 2026-10-27 decision: derive the shipping oracle from the ceiling ledger; block-step allocations

No ceiling changes. The Kit shipping oracle in `ci/check-kit-perf.test.mjs`
and the aggregate pin in `ci/budget-fragments.test.mjs` carried literal
tables (five server-gzip allocations with fixed interval/exact/over
bytes, plus a pinned copy of every ceiling). Every ceiling raise therefore
needed a test-only literal PR beside its fragment PR: four were open and
three merged in 24 hours.

## What changes

- `ci/budget-ledger.mjs` reads `Ceiling: <key> = <value> (previous <n>)`
  lines from `decisions/kit-perf/*.md` (file-name order, last wins).
  `0001-ceiling-ledger-baseline.md` declares every current value.
- The shipping tests derive cap, cap+1 and the newly-allowed interval
  (previous+1) from the fragment and its decision. The aggregate pin
  asserts fragments and ledger describe exactly the same ceilings.
- Fail-closed both ways: a fragment value without a matching decision
  fails, and so does a declaration no fragment carries. Mutation check: a
  fragment raised without a decision fails the ledger and aggregate tests
  plus the server-gzip one-byte-over row; adding the declaration makes
  them pass with the new derived rows.
- Allocation policy moves from the 256B cover to 1024-2048B block steps
  (`ci/budgets/README.md`), so one raise lasts several features.

## Trade-off

A PR that raises a fragment and writes its own decision line passes by
construction; the safeguard is that the raise is now a reviewed, measured
decision file rather than an unreviewed literal edit. The evidence rows
no longer pin a ceiling independently of the fragment.

Undo: `git revert` this change; to restore the 256B-step policy without
reverting the oracle, replace the policy section of `ci/budgets/README.md`
in a new decision file.
