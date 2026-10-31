# Activity-log recovery links on current main

An empty activity-log page now says why it is empty and links back:
"First page of these results" on an empty later page, and "Clear
filters" on a filtered empty page. One shared helper,
`activityLogRecovery` in `src/admin/table-list.ts`, feeds both the Hono
page and the Kit page (`web/src/routes/admin/activity-log/+page.svelte`).
No dependency, file-count, CSS, worker, startup or user-facing speed
target changes; server and client file counts stay 116 and 53.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0. The feature merged into
main `0855896f` was built twice; main `0855896f` was built once with the
same dependencies.

| Metric | Merged build 1 / 2 | Main | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1209132 / 1209130 | 1207736 | 1208064 | 1209344 |
| Server JS gzip | 338013 / 338012 | 337829 | 337920 | 338176 |
| Client JS raw | 260403 / 260403 | 259746 | 260096 | 260608 |
| Client JS gzip | 103909 / 103909 | 103695 | 103936 | 103936 |

The feature costs +1396 server raw, +184 server gzip, +657 client raw
and +214 client gzip. Per-file attribution against main: server
`chunks/admin.js` +1394 (the helper plus the Hono and Kit renderers of
the two links, which the Kit admin chunk bundles together) and
`chunks/instance.js` +2 (rename noise); client `nodes/12.js` +657 (the
Kit activity-log node). The activity log is `csr = false` and never
hydrates, but SvelteKit still emits its client node. No accidental
imports were found to remove.

Main then landed #1986 (`7f5c60e2`). The feature merged into it
measures server 1209182 raw / 338027 gzip and the same client figures,
still inside every feature ceiling (margins 162 and 149 bytes).

## Sizing

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1208064 -> 1209344: +1280 bytes (0.106%); margin 212 bytes
  (162 on `7f5c60e2`).
- Server gzip 337920 -> 338176: +256 bytes (0.076%); margin 163 bytes
  (149 on `7f5c60e2`).
- Client raw 260096 -> 260608: +512 bytes (0.197%); margin 205 bytes.
- Client gzip stays 103936; margin 27 bytes.

Main's ceilings reject the merged build by 1068, 93 and 307 bytes on
the three raised axes. Each raise is under 0.25% and admits this
product feature inside its own PR. No gate, coverage floor, file-count
cap or user-facing performance target is changed or bypassed.
Exact-head CI must remeasure composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1209344, server gzip 338176 and the client pair 260608/103936. Fixed
fixtures accept the measured sizes and exact ceilings, and reject one
byte over each.

Undo: revert the whole PR. The helper, both renderers, these fragment
and oracle edits, this decision and the recovery cases in
`test/admin-activity-log.test.ts` and
`test/kit-activity-log-render.test.mjs` go together.
