# 2026-10-31 decision: admit the MCP truncation-notice server composition

The Kit server bundle imports the whole Hono app, so the MCP trimmed-result
notice lands in it: the two notice texts, the notice-aware
`fitByteBudget` and `eventResultBytes`, and the second text block in the
event tools. The REST routes share the same fitter. This builds on the
result-budget admission
([2026-10-31-mcp-result-budget-server.md](2026-10-31-mcp-result-budget-server.md)),
which sits on main `c0fadacb` (`GET /version`).

## Measurements

Node 24, committed root and web lockfiles: a clean `npm run build --prefix
web` followed by `node ci/check-kit-perf.mjs` (gzip is the checker's
per-file sum).

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Result budget on main `c0fadacb`, build 1 | 116 | 1207640 | 337840 | passes 1207808 / 337920 |
| Result budget on main `c0fadacb`, build 2 | 116 | 1207640 | 337835 | passes 1207808 / 337920 |
| Feature, build 1 | 116 | 1208874 | 338242 | passes 1209088 / 338432 |
| Feature, build 2 | 116 | 1208874 | 338243 | passes 1209088 / 338432 |

Feature delta: +1234 raw / +402 to +408 gzip bytes, mostly the two notice
strings, which tell an MCP caller how to read the text that was cut. The
smallest fitting 256B-aligned ceilings are 1209088 raw (214B margin) and
338432 gzip (189B margin). The lower raw step, 1208832, rejects by 42B;
the lower gzip step, 338176, rejects by 67B.

Client JS, client CSS and the Worker entry are unchanged. The main Worker
bundle still fits its own budget (`npm run worker-budget`).

## Bounded admission and tests

Raw rises by 1280B (0.1060%) and gzip by 512B (0.1515%), each below the
0.5% per-feature byte-budget limit. The shipping oracle explicitly admits
this pair; fixed 1209088 / 1209089 raw and 338432 / 338433 gzip controls
prove exact-fit and one-byte-over behavior.

Undo: revert this PR, including its fragment change and admission
controls. No runtime target, scanner, coverage floor, required check, or
test skip is relaxed.
