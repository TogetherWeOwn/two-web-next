# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336384

`server.js.maxGzipBytes` rises 335872 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
shared validation rule's RFC 5892 contextual-joiner tables (explicit
virama set plus the Arabic-joining ZWNJ context) that profile bio/game
refusals inherit, whose server-side code runs in the Kit server bundle.
Two 256B steps, the smallest aligned cover for the measured worst case: one
step (336128) rejects the worst build by 24B. The
supported-allocation literal for 336384 is added to
`ci/check-kit-perf.test.mjs` (`SHIPPING_SERVER_GZIP_ALLOCATIONS`) with the
paired interval/exact/over cases, following the existing ladder pattern.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `b5bef6810`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186500 | 335653 | exit 0, margin 219 |
| 2 | 116 | 1186500 | 335656 | exit 0, margin 216 |

Feature merged onto the same main tip (both builds identical):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187479 | 336104 | exit 1 against 335872, 232 over |
| 2 | 116 | 1187479 | 336104 | exit 1 against 335872, 232 over |

Feature delta on the server total is +979 raw / +448 gzip bytes (feature
worst minus pristine worst). The current 335872 ceiling rejects the
combined tree by 232B; 336384 (256 x 1314) admits it with 280B of margin
and passes the checker (exit 0). Worker, client JS and client CSS are
unchanged by this feature's measurement and fit their unchanged ceilings.

## Why the growth is justified

Paperclip Review (the security gate on profile spoofing text) rejected the
compact nonspacing-mark proxy for contextual joiners as both over- and
under-inclusive: it refused correctly spelled Persian ZWNJ text and Mc-virama
Indic text while admitting non-orthographic joiners. The mandated fix is an
explicit virama code-point set (69 UCD entries, Mn and Mc) plus an
Arabic-joining ZWNJ context, already shrunk to a hex-delta table decoded
once at load; the only cheaper alternative is to drop the behaviour the
security fix exists to deliver. No new route, island, query or dependency.
