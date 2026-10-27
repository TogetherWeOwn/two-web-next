# 2026-10-27 decision: server JS gzip ceiling 336384 -> 337152

`server.js.maxGzipBytes` rises 336384 -> 337152 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
deploy identity endpoints (`GET /version`, `GET /readyz`): the pure identity
decision in `src/deploy-identity.ts`, the generated build stamp and two route
registrations all live in the Hono app, which the Kit Worker bundles in
process. Three 256B steps, the smallest aligned cover for the measured worst
case: 336896 rejects it by 237B. The supported-allocation literal for 337152
in `ci/check-kit-perf.test.mjs` is not on main yet; it rides in a separate
test-only change, so this change carries only the fragment, the
`ci/budget-fragments.test.mjs` allocation list and this record.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs --format json`, two builds per tree. Worst case
governs.

Pristine main tip `4e90a8bcf`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1190242 | 336246 | exit 0, margin 138 |
| 2 | 116 | 1190240 | 336251 | exit 0, margin 133 |

The same tree with the deploy identity change:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336384 |
|---|---:|---:|---:|---|
| 1 | 116 | 1193125 | 337133 | exit 1, 749 over |
| 2 | 116 | 1193123 | 337130 | exit 1, 746 over |

Worst case overall is 337133B: 336384 rejects it by 749B, 336896 rejects it by
237B, and 337152 (256 x 1317) admits it with 19B of margin. Worker
(2551/1219B), client JS (54 files, 256371/102994B) and client CSS (2 files,
2861/1019B) are byte-identical to pristine main and fit their unchanged
ceilings, so the growth is server-only with no new files. Feature delta on the
server total is +2883 raw / +882 gzip bytes (paired worst minus pristine
worst), of which +2862 raw / +863 gzip is `chunks/src.js`.

Rebuild jitter is disclosed, not signal: gzip differs by up to 5B between
builds of the same tree.

## Why the growth is justified

The endpoints answer one question a rollback and a promotion both need: which
commit, build and deploy event the serving Version came from. The decision
fails closed on eight independent inputs (stamp shape, event ID shape and
suffix, environment, Deployment ID, Cloudflare Version ID, Version tag), each
a validated pattern rather than a prefix test, and the Hono app must own both
paths so Kit can never shadow them. The cost is that one decision, a
three-field generated module and two route registrations; the only cheaper
alternative is to drop an input check the acceptance contract requires.

## Contention with sibling budget changes

Other open budget changes target the same fragment and were each measured
against main alone. The 19B margin is tight: any server growth on main before
this lands means a re-measure of the true union and the next step. This record
is the measurement of main plus the deploy identity change only.
