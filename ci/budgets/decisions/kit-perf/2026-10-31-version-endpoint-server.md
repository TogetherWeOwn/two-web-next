# GET /version composed with current main

`GET /version` answers `{ sha, deployedAt }` from the `version_metadata`
binding. The Kit server bundles the Hono app through
`web/src/lib/server/hono.ts`, so the new Hono route and `src/version.ts`
ship in Kit's server output, and `/version` joins the reserved paths in
`src/route-ownership.ts` that the hook never hands to Kit. No dependency,
asset-count, CSS, client, startup, or user-facing speed-target changes
ship; server and client file counts stay 116 and 53.

## Frozen inputs and measurements

Current main is `219c532a`. Canonical locked builds are
`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`.
Gzip uses Node's `gzipSync`, as the checker does. The two composed builds
are independent merges of this branch with `219c532a` (the author's and
the reviewer's).

| Metric | Current main | Composed build 1 / 2 | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1207036 | 1207318 / 1207316 | 1207040 | 1207552 |
| Server JS gzip | 337630 | 337717 / 337718 | 337664 | 337920 |

The reviewer's build of main alone measured 1207036 / 337631.

Per-file raw attribution: exactly two server files change.
`chunks/src.js` grows for the route and `versionBody`, and
`entries/hooks.server.js` grows by 11 bytes for the `"/version"`
reservation. Net +282 raw and +88 gzip on `219c532a`. The first cut was
+397 raw. It was compacted by folding the timestamp check into
`versionBody` and passing `no-store` through `c.json`. The response is
unchanged for every value the binding can carry. The only further cut
found would drop the Kit reservation, so it was kept. Main alone leaves
34 bytes of gzip headroom, so no compaction of an 88-byte addition fits
the old gzip ceiling.

## Least-cover sizing

One aligned step on each breached axis:

- Server raw 1207040 -> 1207552: +512 bytes, 0.042%; worst margin 234 bytes.
  Main's ceiling rejects the composed build by 278 bytes.
- Server gzip 337664 -> 337920: +256 bytes, 0.076%; worst margin 202 bytes.
  Main's ceiling rejects the composed build by 54 bytes.

This is a product-feature admission inside the feature PR, not a
standalone budget change. No Class-A budget changes.

For the calendar week beginning 2026-10-26, the baseline server raw
ceiling is 1203200 and the baseline server gzip ceiling is 334080 (see
`2026-10-29-honest-roster-venue.md`). Including this admission, the
weekly increases are 0.362% raw and 1.149% gzip, each below 2%.

Exact-head CI must remeasure composition with any later main features.

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1207552 and server gzip 337920 only from its explicit allocation lists
and keeps every earlier allocation. The checker fixtures in
`ci/check-kit-perf.test.mjs` accept the measured 1207318 raw and 337718
gzip and each exact ceiling, and reject 1207553 and 337921.

Undo: revert this feature's fragment change, oracle additions, and this
decision together.
