# Performance budgets: what fails, what is unknown

No features, content, accessibility or design are cut to save bytes. A size-driven design trade-off needs a product/UX decision, not only a perf PR.

## Gates and evidence

| Surface | Enforced behavior in this revision |
| --- | --- |
| Client JS/CSS | `npm run budget` hard-gates each served island/stylesheet's raw and gzip bytes, including discovered dependencies. `npm run kit-perf` hard-gates aggregate Kit client raw/gzip bytes and file counts. Per-route manifest/dependency accounting is separate pending work; aggregates are not route ceilings. |
| HTML / inline CSS | Vitest's `homepage-mobile-lcp-acceptance.test.ts` hard-gates Hono homepage raw HTML and inline-CSS bytes; gzip is diagnostic. Do not describe this as all-route or Kit HTML coverage. |
| Lab / quality | `npm run lighthouse` enforces fixture mobile LCP/CLS/TBT and other assertions in `ci/lighthouserc.cjs`; `npm run lighthouse:quality` enforces category floors in `ci/quality-budget.json`. These fixtures render Hono, not Kit. `npm run lighthouse:origin` checks the deployed origin. |
| Real-user CWV | Nightly `node ci/rum-check.mjs --require-collection` requires configuration and 50 samples/24 h separately from p75 LCP/CLS/INP enforcement. Missing config/insufficient samples exits 2; breach, malformed data and transport failures exit 1. Explicit n/a stays unavailable, never an observed pass. |
| Server / Worker | `npm run worker-budget` preserves the whole-Worker raw/gzip hard tripwire. Kit server totals, entry bytes and file counts are hard gates in the current checker. The server-gzip-warning/startup replacement is pending, not shipped by the RUM change. Summed-gzip chunk regrouping alone is not code savings; duplicate Hono removal follows existing route migration work. |
| Startup vs readiness | `kit/startup.json` currently supplies the Playwright test-server readiness timeout, not measured Worker startup CPU. A genuine cold Worker startup measurement with warning/failure verdicts needs separate implementation and evidence; process boot/readiness wall time cannot stand in for it. |

Missing/malformed build artifacts fail closed, not as zero bytes. RUM reports
`collectionHealth` separately from `metricVerdict`; `partial`, `unavailable` and
`not-evaluated` are not green evidence for unobserved metrics. Diagnostic RUM
runs without the required flag may exit 0 on missing evidence; never use them
as production monitoring. The [RUM runbook](../../docs/rum-web-vitals.md) records
actual windows and the unresolved real-sample prerequisite. Visitor-facing
ceilings, security headers, accessibility and test gates are not relaxed here.

## Headroom, steps and automation

Measure the real build first. The default proposed byte ceiling is **measured
×1.25**, rounded **up to 512 B raw / 256 B gzip**, unless a decision explains
otherwise. There is no upward client-ceiling reset: preserve existing ceilings
and report any unmet headroom. File-count limits and runtime thresholds have
their own units; do not apply byte rounding to them. A lower-only proposal must
reduce the existing ceiling by **more than one rounding step** (512 B raw /
256 B gzip). Otherwise keep it unchanged; `min(existing, candidate)` is not
proof that ×1.25 headroom was restored.

Current main CI runs the full gates, not an automatic ceiling rewrite. The
separate main-only lower-only proposal automation is pending alongside route
accounting. Its contract is measured decreases only, a bounded draft PR, no
push to main or auto-merge, and ordinary review plus a decision/Undo record.
Do not claim that automation or server warning/startup semantics have shipped
until their implementations and exact commands are verified together.

## One authority and one decision per change

`ci/budget-fragments.mjs` loads `kit/*.json` and `bundle/*.json`: one atomic unit
per file, one authority per ceiling. Edit only the affected fragment; a new
served asset gets its own fragment. Duplicate units, or a legacy monolith next
to fragments, fail closed (exit 2). Scratch fixtures without fragments may use
the legacy format. Never edit the hash-pinned `0000-legacy-history-*` decisions.

Add a **new** `decisions/kit-perf/`, `decisions/bundle/` or `decisions/rum/`
`YYYY-MM-DD-<slug>.md` file with measurements, old/new ceilings or verdicts,
reason, evidence, and an explicit **Undo:** line. Do not append history to an
old decision or a fragment's one-line `$comment`. Whole-Worker, Lighthouse,
RUM and homepage-test limits remain in their existing checker/config/test
files; fragments are not a replacement for those gates. Decision records are
a review contract, not a claim that the fragment loader validates prose.
