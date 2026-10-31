# 2026-10-31 decision: admit the MCP truncation-notice server composition

The Kit server bundle imports the whole Hono app, so the MCP trimmed-result
notice lands in it: the two notice texts, the notice-aware
`fitByteBudget` and `eventResultBytes`, and the second text block in the
event tools. The REST routes share the same fitter. This builds on the
result-budget admission
([2026-10-31-mcp-result-budget-server.md](2026-10-31-mcp-result-budget-server.md)).

## Measurements

Node 24, committed root and web lockfiles: a clean `npm run build --prefix
web` followed by `node ci/check-kit-perf.mjs` (gzip is the checker's
per-file sum).

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Result budget on main `219c532a` | 116 | 1207360 | 337750 | passes 1207552 / 337920 |
| Feature, build 1 | 116 | 1208592 | 338154 | passes 1208832 / 338176 |
| Feature, build 2 | 116 | 1208594 | 338157 | passes 1208832 / 338176 |

Feature delta: +1234 raw / +407 gzip bytes, mostly the two notice
strings, which tell an MCP caller how to read the text that was cut. The
smallest fitting 256B-aligned ceilings are 1208832 raw (238B margin) and
338176 gzip (19B margin). The lower raw step, 1208576, rejects by 18B;
the previous gzip ceiling, 337920, rejects by 237B.

Client JS, client CSS and the Worker entry are unchanged. The main Worker
bundle still fits its own budget (`npm run worker-budget`).

## Bounded admission and tests

Raw rises by 1280B (0.1060%) and gzip by 256B (0.0758%), each below the
0.5% per-feature byte-budget limit. The shipping oracle explicitly admits
this pair; fixed 1208832 / 1208833 raw and 338176 / 338177 gzip controls
prove exact-fit and one-byte-over behavior.

Undo: revert this PR, including its fragment change and admission
controls. No runtime target, scanner, coverage floor, required check, or
test skip is relaxed.
