# Additive size budgets

`kit/*.json` and `bundle/*.json` are per-unit bases: existing byte ceilings may only be tightened directly. The existing
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

Only decrease existing `maxRawBytes` or `maxGzipBytes` fields in a base; all other operational fields and historical decisions remain frozen. Top-level `$` metadata in Kit and bundle fragments may be updated because the loaders ignore it. The policy gate checks each queued contribution, so a later PR cannot undo an earlier tightening. Current head bases are used conservatively for allowance calculations; a unit cannot be tightened and receive an admission in the same PR or queue batch. A PR/unit admission must have a recorded after measurement above the current effective ceiling. Measurements are review evidence, not automatically verified against build artifacts. Larger/unexplained growth and
exhausted allowance need an explicit maintainer performance decision outside
this delegated admission path.

### New assets, retirement and renames

A genuinely new served island or top-level CSS asset has no prior denominator.
In its feature PR, add one `bundle/<slug>.json` fragment and its own
`decisions/allocations/YYYY-MM-DD-<slug>.md` decision. The checker measures the
tracked asset's raw bytes and default-zlib gzip bytes directly from the event's
Git tree. Each base must be **measured size through floor(measured size * 1.02)**;
there is no minimum byte block. Record exact measurements, cause/import review
and the feature PR. For example, a 27B raw / 47B gzip island may use this record
(with the actual filename and measurements for your feature):

```markdown
---
{
  "action": "initial",
  "fragment": "ci/budgets/bundle/new.json",
  "budget": {"budgets": {"public/islands/new.js": {"maxRawBytes": 27, "maxGzipBytes": 47}}},
  "measured": {"bundle-public-islands-new-js-raw": 27, "bundle-public-islands-new-js-gzip": 47},
  "cause": "New island; checked imports for duplicate or accidental dependencies.",
  "pr": 123
}
---
Build commands, source revision and performance evidence.
```

`budget` must reproduce the fragment's complete JSON mapping (including any
metadata). Existing or previously retired unit identities cannot be initialized
again, and an initial allocation cannot also receive a byte delta in the same
batch. Subsequent growth uses ordinary additive decisions and the 0.5%/2% caps.

To retire an asset, delete it from the served inventory and delete its fragment
in the same PR. Add a separate allocation decision with `action: "retire"`, the
old `fragment` and exact old `budget`, `measured: {}`, cause and PR. Retirement
fails while the asset still exists in the inventory. Keep **all** earlier
decisions: prior deltas remain readable and immutable, but no longer create an
active asset ceiling. An island rename is a retirement plus a measured initial
allocation for the new identity, each with its own decision. Merely renaming a
fragment without these lifecycle changes is not a backdoor to rewrite a base.

Kit groups and the deploy worker have fixed canonical inventory identities;
ordinary lifecycle decisions cannot add or retire them. The deploy base's
measured-main +2% exception is restricted to the checker's installation run.
Changing a canonical Kit/deploy inventory requires a maintainer-reviewed policy
and inventory change with matching checker/tests, not a served-asset decision.

**Kit `maxFiles` admission:** byte decisions do not change file counts (or
`startup.maxMs`). Reuse existing file-count headroom first. If a feature truly
needs more files, supply the measured before/after enumeration and cause in that
feature PR and obtain an explicit maintainer-reviewed file-count policy change,
including the checker and independent boundary tests. Until that explicit policy
change lands, the existing count remains hard; neither an initial island
allocation nor a gzip/raw decision can raise `maxFiles`.

### Migration for the 13 in-flight fragment-editing PRs

Rebase onto this policy before queueing. For each **existing** unit whose JSON
fragment your PR raises, restore that fragment byte-for-byte from current main.
Compute `delta_bytes = requested effective ceiling - current main effective
ceiling` (base plus already merged decisions), then add the six-field decision
above in the **same feature PR** with your own PR number and fresh before/after
measurements. Do not copy the old ceiling into `delta_bytes`, edit legacy prose,
create a companion budget PR, or add another fixed allocation table to tests.
If main already supplies enough headroom, remove the fragment edit without adding
a decision. Multiple decisions for the same PR/unit share one allowance.

If the needed delta exceeds 0.5% of main's effective ceiling or the shared
seven-day allowance, optimize/defer the growth or seek an explicit maintainer
performance decision; do not split PRs to evade the cap. For genuinely new or
removed assets, use the lifecycle records above rather than a delta against zero.
The fragment-derived shipping oracle remains a supplemental boundary check;
it must consume the effective loader result, not reintroduce literal ceiling
admission rows.

## Enforced accounting

`ci/check-budget-admissions.mjs` runs hard on PRs and on `merge_group` (also main
pushes). It freezes history, permits only base byte-ceiling decreases, and validates:

1. **Per PR, per unit:** sum **all** new files for that PR/unit, then require
   `sum * 200 <= current_main_ceiling` (at most 0.5%). Splitting files cannot
   buy another allowance. All PRs in a queue batch use the same base-main
   denominator, without compounding sibling allowances.
2. **Rolling seven days, per unit:** sum prior main merges in `(now - 7d, now]`
   plus **all** new queue contributions. Require `sum * 50 <= window_start_ceiling`
   (at most 2%). The denominator is base plus older admissions. Exactly seven
   days old is outside the numerator and inside the denominator.
3. **Trusted provenance:** recent historical time/PR comes from the first-parent
   main introduction and GitHub's `merge_commit_sha`/`merged_at`, not the filename
   or agent-written date. Only units consuming new byte allowance need historical
   timestamps: unrelated PRs do not call the history API. On protected squash-only
   main, a GitHub-committed squash with a matching `(#PR)` suffix and committer
   date already outside the seven-day window bounds old history without an API
   lookup. Ordinary local author/committer dates never qualify; recent or
   nonstandard introductions still require the API. Lookups are cached per run.
   On PRs the event number owns every new decision, including lifecycle records.
   On the squash merge queue, each generated contribution must match its GitHub
   PR's added-file blobs; all files for the same PR are aggregated. Unsupported
   queue graphs and ambiguous attribution fail hard. Network errors, rate limits
   and 5xx responses retry at most three attempts with exponential backoff and
   jitter. Exhausted required evidence fails closed, never advisory; an unrelated
   PR does not fail because an unused historical API is unavailable.

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
tightening-only bases, frozen history and fail-closed behavior. Shipping-boundary tests are
supplemental mechanics, not a second authorization table. Hermetic legacy
single-file fixtures still load when no fragment directory exists; a legacy
file beside fragments remains ambiguous and fails closed.
