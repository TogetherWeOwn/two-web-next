# QA-token throttle server growth

`fix/qa-token-throttle` fails its own Kit server ceilings; this is not main
drift. Main `77de045d` passes `check` (server raw 1219341/1219584, gzip
340668/340736), while this branch measures raw 1220480/1220482 and gzip
341055/341055. The growth is the new per-client guess-attempt bucket in
`src/qa.ts` (take-before-compare with refund-on-match, 10-token capacity,
1/s refill, 1024-client LRU), which the Kit server bundles via
`web/src/hooks.server.ts` -> `src/route-ownership.ts` (imports
`STAGING_APP_URL` from `src/qa.ts`).

No dependency, file-count, CSS, worker, client, startup or user-facing
speed target changes; server and client file counts stay 116/126 and 54/55.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`. Gzip uses Node's `gzipSync`, as the checker
does. Build 1 is a local build of this branch head `0c60d85e`; build 2 is
CI's `check` run on the same head.

| Metric | Main 77de045d | Branch build 1 / 2 | Old ceiling | New ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1219341 | 1220482 / 1220480 | 1219584 | 1220608 |
| Server JS gzip | 340668 | 341055 / 341055 | 340736 | 341248 |

The branch costs +141 / +139 raw and +387 gzip over main on this base.

## Sizing

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1219584 -> 1220608: +1024 bytes (0.084%). The lower step
  1220096 rejects the worst build by 386. Worst margin 126.
- Server gzip 340736 -> 341248: +512 bytes (0.150%). The lower step
  340992 rejects by 63. Worst margin 193.

The security fix cannot ship without a ceiling that admits its measured
size, and no compaction inside `src/qa.ts` absorbs the bucket state the
fix requires. No gate, coverage floor, file-count cap or user-facing
performance target is changed or bypassed. Exact-head CI remeasures
composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1220608 and server gzip 341248. Fixed fixtures accept the measured sizes
and exact ceilings, and reject one byte over each.

Undo: revert this decision together with the `src/qa.ts` attempt bucket;
main alone stays under the old ceilings.
