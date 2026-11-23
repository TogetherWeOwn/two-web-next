# Historical decision 0004 · Mobile Events LCP investigation

On 2026-11-07 the engineering lead chose to investigate removing four
render-blocking stylesheets on the Events schedule only, using the existing
shared CSS and hash machinery. This kept the rendered styles, CSP hashes and
2,000 ms budget as constraints. The [staging run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42414068853)
recorded a median mobile LCP of 2,005 ms. The hold at
[v2026.1107.2](https://github.com/TogetherWeOwn/two-web-next/releases/tag/v2026.1107.2)
motivated the investigation. The cause and the proposed change's effect still
needed measurement.

On 2026-11-14 the [migration-period quality policy](https://github.com/TogetherWeOwn/two-web-next/pull/2502)
made staging Lighthouse budgets report-only during the Ember and Kit
migration, retaining route thresholds and blocking origin web standards.
The later [v2026.1115.0 promotion](https://github.com/TogetherWeOwn/two-web-next/actions/runs/43671079084/job/132681549568)
passed production smoke. The release receipt establishes that promotion.
Validation of the proposed stylesheet change would require its own evidence.
See [current staging quality gates](../performance-budgets.md#staging-quality-and-journey-gates).
