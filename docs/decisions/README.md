# Decisions

Material decisions that shape this repository, each with its context, the
actual decision, why it was made, the date and its provenance. Reversals and
supersession are preserved here, not smoothed away.

The SvelteKit page-renderer decision's canonical record is
[ADR 0001](../adr/0001-sveltekit-page-renderer.md) under `docs/adr/`; this
directory is the index for repo-wide material decisions and links to that
record rather than restating it, so the two cannot drift apart.

| Decision | Record |
| --- | --- |
| SvelteKit with Svelte 5 is the single page renderer; Hono keeps non-page APIs until the page-renderer milestone | [ADR 0001](../adr/0001-sveltekit-page-renderer.md) (canonical) |
| Merges to `main` deploy production and need exact-head Release Manager confirmation | [0002](0002-production-merge-confirmation.md) |
| Gate-green PRs merge without owner approval; CodeRabbit is advisory | [0003](0003-gate-green-merge-and-advisory-review.md) |
| Critical CSS extraction is the chosen remedy for the mobile `/events` LCP release hold | [0004](0004-critical-css-lcp-remedy.md) |
| The post-cutover milestone proposal is superseded and kept only as history | [0005](0005-post-cutover-milestone-superseded.md) |
| `ROADMAP.md` is the public direction entry point, not a delivery schedule or task tracker | [0006](0006-roadmap-authority.md) |
| Cutover to the Cloudflare Worker completed; production serves the Worker | [cutover gates](../cutover-gates.md) and [parity matrix](../parity.md); operations consequences in the [runbook](../runbook.md) |

## How decisions are recorded

- Each numbered entry names the deciders, the date in UTC, and the source
  revision or commit SHA it was verified against where that is known.
- Superseded entries state what superseded them and when; they are not deleted.
- Decisions that live only in conversation and never reached the repository
  are outside the public record. The restricted provenance ledger on the
  coordinating card maps each public entry to its internal source; it is not
  published here. Public text in this directory contains enough substance to
  understand and resume the decision without any internal system.

For the continuing direction summary, see the [website roadmap](../../ROADMAP.md).
For the operations consequences of the cutover and renderer decisions, see the
[operations runbook](../runbook.md).
