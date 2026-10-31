# 2026-10-31 decision: admit the MCP result-budget server composition

The Kit server bundle imports the whole Hono app (`web/src/lib/server/hono.ts`
imports `src/index`), so the MCP event result budget lands in it. The fix
adds `eventResultBytes`, the serverInfo stamp it counts, and the shared
`src/mcp/identity.ts` constants. Main left 2 raw bytes of headroom, so any
server growth needs a new step. No duplicate or unneeded import accounts
for the growth.

## Measurements

Node 24, committed root and web lockfiles: `npm run build --prefix web`
followed by `node ci/check-kit-perf.mjs` (gzip is the checker's per-file
sum). Main and the feature used the same dependencies and toolchain.

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Main `47dd89b8` | 116 | 1207038 | 337629 | passes 1207040 / 337664 |
| Feature, CI build | 116 | 1207104 | ≤ 337664 | raw exceeds 1207040 by 64 |
| Feature, local build 1 | 116 | 1207104 | 337665 | exceeds by 64 raw / 1 gzip |
| Feature, local build 2 | 116 | 1207104 | 337663 | passes 1207296 / 337920 |

Feature delta: +66 raw / +34 to +36 gzip bytes. The smallest fitting
256B-aligned ceilings are 1207296 raw (192B margin) and 337920 gzip
(255B margin). The previous raw ceiling rejects by 64B. Gzip sits within
1B of the previous 337664 ceiling across builds, so it takes one step
too, which keeps the gate from flaking.

Client JS, client CSS and the Worker entry are unchanged. The main Worker
bundle still fits its own budget (`npm run worker-budget`).

## Bounded admission and tests

Raw rises by 256B (0.0212%) and gzip by 256B (0.0758%), each below the
0.5% per-feature byte-budget limit. The shipping oracle explicitly admits
this pair; fixed 1207296 / 1207297 raw and 337920 / 337921 gzip controls
prove exact-fit and one-byte-over behavior.

Undo: revert this PR, including its fragment change and admission
controls. No runtime target, scanner, coverage floor, required check, or
test skip is relaxed.
