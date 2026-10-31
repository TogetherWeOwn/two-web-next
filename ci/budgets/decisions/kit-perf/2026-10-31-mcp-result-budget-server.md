# 2026-10-31 decision: admit the MCP result-budget server composition

The Kit server bundle imports the whole Hono app (`web/src/lib/server/hono.ts`
imports `src/index`), so the MCP event result budget lands in it. The fix
adds `eventResultBytes`, the serverInfo stamp it counts, and the shared
`src/mcp/identity.ts` constants. After `GET /version` (#1974) took the
1207552 / 337920 step, main leaves 234 raw bytes of headroom, and the fix
needs 322. A chunk diff against main shows only that code in
`chunks/src.js`; no duplicate or unneeded import accounts for the growth.

## Measurements

Node 24, committed root and web lockfiles: a clean `npm run build --prefix
web` followed by `node ci/check-kit-perf.mjs` (gzip is the checker's
per-file sum). Main and the feature used the same dependencies and
toolchain.

| Tree | Server files | Raw bytes | Gzip bytes | Result |
|---|---:|---:|---:|---|
| Main `c0fadacb`, build 1 | 116 | 1207318 | 337717 | passes 1207552 / 337920 |
| Main `c0fadacb`, build 2 | 116 | 1207316 | 337719 | passes 1207552 / 337920 |
| Feature on main, build 1 | 116 | 1207640 | 337840 | passes 1207808 / 337920 |
| Feature on main, build 2 | 116 | 1207640 | 337835 | passes 1207808 / 337920 |

Feature delta: +322 raw / +118 to +123 gzip bytes, all in `chunks/src.js`.
Only the raw axis breaches: main's 1207552 ceiling rejects by 88B. The
smallest fitting 256B-aligned raw ceiling is 1207808 (168B margin). Gzip
still fits main's 337920 ceiling (80B margin), so it is unchanged.

Client JS, client CSS and the Worker entry are unchanged. The main Worker
bundle still fits its own budget (`npm run worker-budget`).

## Bounded admission and tests

Raw rises by 256B (0.0212%), below the 0.5% per-feature byte-budget limit.
The shipping oracle explicitly admits the 1207808 / 337920 pair; fixed
1207808 / 1207809 raw controls prove exact-fit and one-byte-over behavior.

Undo: revert this PR, including its fragment change and admission
controls. No runtime target, scanner, coverage floor, required check, or
test skip is relaxed.
