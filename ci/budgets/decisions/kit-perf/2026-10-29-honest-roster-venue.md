# Honest roster and venue states composed with current main

The event detail page now names the roster section for guests,
non-members and empty member views instead of hiding it, renders an
honest venue fallback when no location is recorded, and builds the
sign-in/join return destination from validated archive/attendee context
bounded to the auth byte cap instead of forwarding the raw query. No
dependency, asset-count, CSS, startup, or user-facing speed-target
changes ship; server and client file counts stay 116 and 53.

## Frozen inputs and repeated measurements

The initial admission used main `e2590f419` (host and joining details
on Kit detail). Main subsequently landed statement deadlines,
ongoing-night labels, and the refused-edit roster explanation. The
feature was merged with current main `14c39f57e` before this final
measurement; that main also compacts shared admin-error markup.

Canonical locked builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`, on Node v24.22.1. Gzip
measurements use Node's `gzipSync`, as the checker does. Both the
current main and composed feature were built twice.

| Metric | Composed build 1 | Composed build 2 | Current main build 1 / 2 | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| Server JS raw | 1206782 | 1206782 | 1204577 / 1204577 | 1205504 | 1207040 |
| Server JS gzip | 337545 | 337547 | 336984 / 336982 | 337408 | 337664 |
| Client JS raw | 259442 | 259442 | 258363 / 258363 | 258560 | 259584 |
| Client JS gzip | 103580 | 103580 | 103258 / 103258 | 103680 | 103680 (unchanged) |

Per-file raw attribution against current main: exactly three server
files change — `chunks/events.js` +1827 (the honest-state read model
and bounded return builder), `chunks/admin.js` +380 (the same builder
via the shared event routes), and `chunks/instance.js` -2 (rename
noise). Net +2205 raw. The auth byte-cap constant is inlined; no
join-service module ships in the events chunk. Client growth is
+1079 raw for the compiled EventDetail roster shells and venue
fallback. No accidental imports were found to remove.

## Least-cover sizing and bounded admissions

Aligned least-cover steps on each breached axis, not 25% headroom:

- Server raw 1205504 -> 1207040: +1536 bytes, 0.128%; margin 258 bytes.
- Server gzip 337408 -> 337664: +256 bytes, 0.076%; worst margin 117 bytes.
- Client raw 258560 -> 259584: +1024 bytes, 0.396%; margin 142 bytes.

Main's ceilings reject the composed worst build by 1278, 139, and 882
bytes respectively. Client gzip fits unchanged with 100 bytes of margin.
All raises are product-feature admissions inside the feature PR, not a
standalone budget change; each total raise versus current main is
under 0.5%. No Class-A budget is changed.

For the calendar week beginning 2026-10-26, the last preceding main
commit `2f9e60791d27378d4b07f0cfd615c8af86f04f76` has server raw 1203200,
server gzip 334080, and client raw 254976. Including this admission,
weekly increases are 0.319%, 1.073%, and 1.807% respectively, each below
2%.

The earlier unpushed server raw allocation 1205248 is superseded by
1207040, not an additional allowance. Earlier measured composition
on `e2590f419` was server 1204729 raw / 337312 worst gzip and client
259224 raw / 103522 gzip. The final ceiling includes the newer main
features rather than treating those bytes as accidental growth.

Exact-head CI and the merge queue must remeasure composition with later
features. No gate, coverage floor, file-count cap, or user-facing
performance target is changed or bypassed.

## Enforcement

Both shipping oracles retain main's previous approved allocations and
rejection fixtures. They additionally admit server raw 1207040, server
gzip 337664, and the client pair 259584/103680. Fixed literal fixtures
accept the newly allowed intervals (1206782, 337545, 259224) and exact
ceilings, and reject 1207041, 337665, and 259585. The fragment oracle
admits the new server raw only from its explicit allocation list and
still rejects one-byte drift on every axis.

Undo: revert this feature's fragment changes, oracle additions, and
decision together. Reverting the feature removes the reason for its
allocation; retain other features' independently shipped allocations.
