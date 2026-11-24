# Website decisions

Use the ADRs for technical direction and the contributing guide for current
merge and release policy.

| Decision | Record |
| --- | --- |
| SvelteKit is the single page renderer. Hono retains non-page contracts through renderer M0. | [ADR 0001](../adr/0001-sveltekit-page-renderer.md) |
| Source preparation may precede renderer M0. Production API family flips follow it and need separate evidence and approval. | [ADR 0002](../adr/0002-api-migration-amendment.md) |
| The website roadmap is the public direction entry point and includes approved Ember Hours core scope. The November 9, 2026 roadmap review preserved the previous post-cutover proposal as history. | [Roadmap](../../ROADMAP.md) · [Historical proposal](../post-cutover-milestone.md) · [Roadmap PR #2105](https://github.com/TogetherWeOwn/two-web-next/pull/2105) |
| Current merge, independent-review and release requirements. | [Contributing guide](../../CONTRIBUTING.md#merge-and-production-staging-evidence) |

## Historical decisions

- [2026-10-31 routine merge and advisory review policy](0003-gate-green-merge-and-advisory-review.md).
- [2026-11-02 production confirmation policy](0002-production-merge-confirmation.md).
- [2026-11-07 mobile Events LCP investigation](0004-critical-css-lcp-remedy.md).
