# Decisions

Material decisions that shape this repository, each with its context, the
actual decision, why it was made, the date and its provenance. Reversals and
supersession are preserved here, not smoothed away.

| Decision | Record |
| --- | --- |
| SvelteKit with Svelte 5 is the single page renderer; Hono keeps non-page APIs until the page-renderer milestone | [0001](0001-sveltekit-page-renderer.md) (also recorded as ADR 0001 at `docs/adr/0001-sveltekit-page-renderer.md`) |
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
