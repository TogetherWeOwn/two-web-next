# 2026-10-31 decision: admit the MCP result-budget server composition

The Kit server bundle imports the whole Hono app (`web/src/lib/server/hono.ts`
imports `src/index`), so the MCP event result budget lands in it. The fix
adds `eventResultBytes`, the serverInfo stamp it counts, and the shared
`src/mcp/identity.ts` constants. Main left 2 raw bytes of headroom, so any
server growth needs a new step. A chunk diff against main shows only that
code in `chunks/src.js`; no duplicate or unneeded import accounts for the
growth.

## Measurements

Node 24, committed root and web lockfiles: a clean `npm run build --prefix
web` followed by `node ci/check-kit-perf.mjs` (gzip is the checker's
per-file sum). Main and the feature used the same dependencies and
toolchain.

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Main `219c532a`, build 1 | 116 | 1207036 | 337630 | passes 1207040 / 337664 |
| Main `219c532a`, build 2 | 116 | 1207038 | 337629 | passes 1207040 / 337664 |
| Feature on main, build 1 | 116 | 1207358 | 337749 | passes 1207552 / 337920 |
| Feature on main, build 2 | 116 | 1207360 | 337750 | passes 1207552 / 337920 |

Feature delta: +322 raw / +121 gzip bytes, all in `chunks/src.js`. The
smallest fitting 256B-aligned ceilings are 1207552 raw (192B margin) and
337920 gzip (170B margin). The lower raw step, 1207296, rejects by 64B;
the previous gzip ceiling, 337664, rejects by 86B.

Client JS, client CSS and the Worker entry are unchanged. The main Worker
bundle still fits its own budget (`npm run worker-budget`).

## Bounded admission and tests

Raw rises by 512B (0.0424%) and gzip by 256B (0.0758%), each below the
0.5% per-feature byte-budget limit. The shipping oracle explicitly admits
this pair; fixed 1207552 / 1207553 raw and 337920 / 337921 gzip controls
prove exact-fit and one-byte-over behavior.

Undo: revert this PR, including its fragment change and admission
controls. No runtime target, scanner, coverage floor, required check, or
test skip is relaxed.
