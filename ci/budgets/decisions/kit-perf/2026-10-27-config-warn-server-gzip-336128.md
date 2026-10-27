# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
once-per-isolate invalid-operator-config warning (`src/config-warn.ts`,
called from `src/image-policy.ts`, `src/events/routes-shared.ts`,
`src/agent-events/route.ts` and `src/csp-reports.ts`) composed with current
main. The warning alone measured 335615 against the older main tip
(`4cd035fd8`, server gzip 335349; see
`2026-10-27-config-warn-server-gzip.md`); main has since grown its server
bundle to 335656, so the composition measures 335927 worst case, 55B over
the shared 335872 ceiling. One 256B step, the smallest supported cover: the
336128 allocation literal already exists in `ci/check-kit-perf.test.mjs`
(landed via #1909 for a larger 335977 measurement), so no change to that
file accompanies this raise.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree, same installed
dependencies (root and web lockfiles byte-identical across both trees).
Worst case governs.

Pristine main tip `3baeb3793`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186500 | 335656 | exit 0, margin 216 |
| 2 | 116 | 1186500 | 335654 | exit 0, margin 218 |

Feature merged with main tip (this head):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187241 | 335927 | exit 1 against 335872, 55 over |
| 2 | 116 | 1187241 | 335926 | exit 1 against 335872, 54 over |

Worst case 335927: the current 335872 ceiling rejects it by 55B and
336128 admits it with 201B of margin. Feature delta on server gzip is
+271B (merged worst minus pristine worst); server raw grows +741B to
1187241, inside its 1203200 ceiling. Client JS (54/55 files) is
255345/257024 raw and 102794/103168 gzip against 255118/102664 on main,
a +227/+130 delta that fits its unchanged ceilings with 1679/374B of
margin; worker and client CSS are byte-identical to main and fit.
Rebuild jitter of 1-2B on server gzip is disclosed, not signal.

## Update after merging main `227414575`

Main landed the same 336128 ceiling independently (#1923, happening-now
allocation), so `server-js.json` carries no diff from main here. On the
merged tree the server bundle measures 336100/336128 gzip (116/126 files,
`npm run kit-perf` exit 0), 28B margin; this file stays as the independent
measurement for the warning's share of that ceiling.
