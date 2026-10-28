# Additive size budgets

`kit/*.json` and `bundle/*.json` are immutable, per-unit bases. The existing
canonical inventories and missing-output checks still apply. Byte ceilings are:

**effective ceiling = base + sum of all admitted `delta_bytes` for that unit**

There is no last-writer-wins declaration, shared counter, filename ordering,
allocation table in tests, or standalone admission/history PR. Existing prose
under `decisions/kit-perf/` and `decisions/bundle/` is frozen history, not new
capacity. Every historical decision, including a previously merged delta, is
immutable. Deleting or renaming it is a rewrite and fails validation.

## Gate classes and the conservative Kit transition

- **User outcomes:** Lighthouse, authenticated latency, RUM and staging quality
  targets are unchanged. Never raise one to admit a feature. A byte admission
  cannot bypass a red required performance, security or review check.
- **Browser bytes:** public/island JS and CSS and Kit client JS/CSS retain their
  hard raw/gzip ceilings. Only documented, bounded additive admissions are
  delegated. File-count and readiness limits are not byte admissions.
- **Server proxies:** Kit SSR raw/per-file gzip totals, file counts and the
  adapter `_worker.js` entry remain hard **for now**, including on the queue.
  The current Lighthouse/auth fixture exercises Hono, not built Kit, and
  low-sample nightly RUM is not positive PR performance evidence. Converting
  these protections to warnings needs representative built-Kit rendering,
  interaction and response-latency coverage first. A follow-up card alone is
  not a replacement measurement.
- **Final server artifact:** `deploy/worker.json` adds a required raw ceiling on
  the actual Wrangler dry-run modules, separately from the tiny adapter entry.
  Its initial base is measured main plus 2%; the retained CI-log measurement is
  a rounding-aware upper bound, explicitly not a fresh build. It is an artifact
  safeguard, **not** a Cloudflare plan limit or a user-performance guarantee.
  It uses the same 0.5%/2% admission policy as browser bytes.

No existing required check, security gate or class-A target is removed. Numeric
size failures remain hard on PRs as well as merge groups during this conservative
transition. Merge-group validation is the authoritative combined-tree result;
a stale green PR measurement is never a substitute.

## One feature PR, one or more additive decisions

First use already admitted headroom. Measure current main and the feature on a
locked build, check imports for accidental dependencies/duplication, and record
worst-case before/after bytes. Do not raise for unexplained growth or when a
user-outcome check is red. Keep ordinary independent review and all CI.

Add `decisions/<unit>/YYYY-MM-DD-<unique-slug>.md`. Front matter is a JSON
mapping (valid YAML), with exactly these fields; prose carries build commands,
source revisions, optimization checks and reviewer evidence:

```markdown
---
{
  "unit": "kit-client-js-gzip",
  "delta_bytes": 400,
  "before_bytes": 103000,
  "after_bytes": 103500,
  "cause": "Feature adds the shared panel; checked for duplicate/import growth.",
  "pr": 123
}
---
Locked build commands, revisions, worst-case measurements and rationale.
```

Unit IDs derive from the base path plus `raw` or `gzip`: for example
`kit-client-js-gzip`, `kit-server-js-raw`,
`bundle-public-islands-copy-link-js-gzip`, and `deploy-worker-raw`.
`budgetUnits` in `ci/budget-ledger.mjs` is the canonical mapping; collisions fail
closed. File counts and startup time are deliberately not admissible units.
Unknown units, duplicate identities/keys, symlinks, malformed records, noninteger
or nonpositive deltas, unsafe totals and unsupported provenance fail closed.

Do not edit a base or historical decision. New assets require a separately
reviewed **initial-allocation policy/inventory change**, not a percentage of an
imaginary zero base or an automatic minimum block. Larger/unexplained growth,
new allocation policy and exhausted allowance need an explicit maintainer
performance decision outside this delegated admission path.

## Enforced accounting

`ci/check-budget-admissions.mjs` runs hard on PRs and on `merge_group` (also main
pushes). It freezes bases/history and validates:

1. **Per PR, per unit:** sum **all** new files for that PR/unit, then require
   `sum * 200 <= current_main_ceiling` (at most 0.5%). Splitting files cannot
   buy another allowance. All PRs in a queue batch use the same base-main
   denominator, without compounding sibling allowances.
2. **Rolling seven days, per unit:** sum prior main merges in `(now - 7d, now]`
   plus **all** new queue contributions. Require `sum * 50 <= window_start_ceiling`
   (at most 2%). The denominator is base plus older admissions. Exactly seven
   days old is outside the numerator and inside the denominator.
3. **Trusted provenance:** historical time/PR comes from the first-parent main
   introduction and GitHub's `merge_commit_sha`/`merged_at`, not the filename,
   agent-written date or local commit timestamp. On PRs the event number owns
   every new admission. On the squash merge queue, each generated contribution
   must match its GitHub PR's added-file blob; all files for the same PR are
   aggregated. Unsupported queue graphs, API failures or ambiguous attribution
   fail hard, never fall back to a guessed PR or advisory policy validation.

Queue batches can exhaust the shared allowance even when individual PRs fit.
Read the per-unit failure, remove/defer an admission or seek a larger reviewed
performance decision; eject/requeue the affected PR once after fixing it. Do not
repeatedly rebuild/requeue an unchanged over-cap batch or weaken another gate.

## Headroom and warning target

`admissionHeadroom(ceiling, measured)` suggests overage plus one block, **capped
at** `floor(ceiling / 200)` total bytes. For large units the block is that cap
rounded down to a multiple of 256; for small assets it is byte-scale. There is
no 256-byte minimum: a 1024-byte ceiling allows at most 5 bytes. At 336640 bytes,
a 160-byte overage plus a 1536-byte block would exceed the cap; the total delta
is clipped to 1683, not 1696. If the necessary overage exceeds the cap, stop.
Weekly headroom and other files in the PR can further reduce that allowance.

These percentages are governance guardrails, not measured user-performance
thresholds or an indefinite growth entitlement. Review this pilot after 14 days
using product throughput, deduplicated usage and actual user outcomes; a rolling
rate limit does not replace a longer-horizon performance envelope. No automatic
ratchet or host timer is introduced.

## Tests

Independent fixed fixtures test boundaries, cap+1, additive composition,
per-PR aggregation, the exact seven-day boundary, five-PR batches, provenance,
frozen bases/history and fail-closed behavior. Shipping-boundary tests are
supplemental mechanics, not a second authorization table. Hermetic legacy
single-file fixtures still load when no fragment directory exists; a legacy
file beside fragments remains ambiguous and fails closed.
