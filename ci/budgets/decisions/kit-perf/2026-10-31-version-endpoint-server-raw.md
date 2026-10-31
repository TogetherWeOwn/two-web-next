# GET /version composed with current main

`GET /version` answers `{ sha, deployedAt }` from the `version_metadata`
binding. The Kit server bundles the Hono app through
`web/src/lib/server/hono.ts`, so the new Hono route and `src/version.ts`
ship in Kit's server output, and `/version` joins the reserved paths in
`src/route-ownership.ts` that the hook never hands to Kit. No dependency,
asset-count, CSS, client, startup, or user-facing speed-target changes
ship; server and client file counts stay 116 and 53.

## Frozen inputs and measurements

Current main is `47dd89b8`. Canonical locked builds are
`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`.
Gzip uses Node's `gzipSync`, as the checker does.

| Metric | Current main | Composed build 1 / 2 | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1206784 | 1207064 / 1207062 | 1207040 | 1207552 |
| Server JS gzip | 337548 | 337633 / 337635 | 337664 | 337664 (unchanged) |

The main figures match exact-head CI on `2e55cb1e` (1206784 / 337548).

Per-file raw attribution against current main: exactly two server files
change. `chunks/src.js` grows by 269 bytes for the route and
`versionBody`. `entries/hooks.server.js` grows by 11 bytes for the
`"/version"` reservation. Net +280 raw. The first cut was +397 raw. It
was compacted to this size by folding the timestamp check into
`versionBody` and passing `no-store` through `c.json`. The response is
unchanged for every value the binding can carry. The only further cut found would drop the Kit reservation, so it
was kept.

## Least-cover sizing

One aligned step on the breached axis only:

- Server raw 1207040 -> 1207552: +512 bytes, 0.042%; worst margin 488 bytes.

Main's ceiling rejects the composed build by 24 bytes. Server gzip fits
unchanged with a worst margin of 29 bytes. This is a product-feature admission
inside the feature PR, not a standalone budget change. No Class-A budget
changes.

For the calendar week beginning 2026-10-26, the baseline server raw
ceiling is 1203200 (see `2026-10-29-honest-roster-venue.md`). Including
this admission, the weekly increase is 0.362%, below 2%.

Exact-head CI must remeasure composition with any later main features.

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1207552 only from its explicit allocation list and keeps every earlier
allocation. The checker fixtures in `ci/check-kit-perf.test.mjs` accept
the measured 1207064 and the exact ceiling, and reject 1207553.

Undo: revert this feature's fragment change, oracle additions, and this
decision together.
