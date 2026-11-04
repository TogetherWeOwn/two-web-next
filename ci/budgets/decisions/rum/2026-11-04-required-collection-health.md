# Required production RUM collection health

## Evidence and decision

Seven completed nightly queries, read on 2026-11-04, reported these samples in
their rolling 24-hour windows: Oct 28 **21**, Oct 29 **20**, Oct 30 **21**,
Oct 31 **19**, Nov 1 **23**, Nov 2 **22**, Nov 3 **19**. All were green while
explicitly stating budgets were not enforced. These are query sample counts,
not distinct visitors or proof of complete calendar-day coverage.

The latest [run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41632688788)
used head `61cb82e136bd6f2bb3fe8e86c599bf467234f969`: LCP p75 **1288 ms**, CLS
**0**, INP **n/a**. At 19 samples none of those observations enforces the p75
budget. Full run links and bounded setup evidence are in
[the RUM runbook](../../../../docs/rum-web-vitals.md#observed-collection-evidence-2026-11-04).

Use `--require-collection` in the nightly production workflow. Before: missing
config or insufficient samples exited 0. After: both exit **2**, retaining the
`skipped` / `insufficient` kind and adding an explicit `collectionHealth` and
`metricVerdict`. Admitted sufficient data and actual breaches keep their metric
outcomes; malformed data and transport failures stay nonzero. Default diagnostic
runs keep their exit behavior but never label missing evidence as good metrics.
The 19-sample production fixture now reports `insufficient` / `not-evaluated`,
with INP `unavailable`, rather than `ok` rows.

No numeric ceiling changes: LCP **2500 ms**, CLS **0.1**, INP **200 ms**,
`minSamples` **50**, query window **24 hours**. Keep the **10,000 ms** total
attempt deadline, **65,536-byte** decoded-body ceiling, at most **one** 429 retry,
maximum **300,000 ms** cooldown and **8-minute** job timeout. Never retry a
credential failure or substitute a key. Provider payloads and identities stay
out of summaries.

## Product boundary and remaining prerequisite

No features, content, accessibility or design are cut to save bytes. A size-driven design trade-off needs a product/UX decision, not only a perf PR.

Summed-gzip chunk regrouping alone is not code savings. Duplicate Hono removal
belongs to the existing route migration, not this change. No UI, security
header, test, asset ceiling or visitor-facing threshold is removed or relaxed.
Server gzip/startup, route client accounting and automated lower-only proposals
are separate implementation work; the budget README must distinguish pending
interfaces from implemented gates until those changes land.

Nonzero historical results and browser-like public HTML with a CSP-matching
beacon nonce show some collection works, not that every visitor is captured.
Low observed RUM volume is proven; low real traffic versus partial collection
loss is not resolved without an independent denominator and route/browser
coverage evidence. No production/staging DB was probed and no beacon was sent.

The remaining prerequisite is an authorized read-only coverage/page-view
comparison and a real 24-hour window with at least 50 samples. This change does
**not** satisfy that acceptance requirement. Do not manufacture traffic or lower
the sample floor. Future low-sample nightly failures are expected missing-evidence
signals, not regressions in measured p75 performance.

REA angle: source-first study of the shipped checker, actual GitHub Actions
output, edge-injected beacon/CSP markup and public beacon transport script;
reuse the existing bounded transport rather than inventing proxy metrics.

Undo: revert this decision's checker, workflow and documentation changes together through a reviewed PR; keep all numeric budgets, transport/redaction bounds and product-safe constraints intact. Restoring diagnostic-only monitoring would remove required collection evidence and needs an explicit monitoring-policy decision, not a silent flag deletion.
