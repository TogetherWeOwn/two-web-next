# Honest roster and venue states composed with host/join details

The event detail page now names the roster section for guests,
non-members and empty member views instead of hiding it, renders an
honest venue fallback when no location is recorded, and builds the
sign-in/join return destination from validated archive/attendee context
bounded to the auth byte cap instead of forwarding the raw query. No
dependency, asset-count, CSS, startup, or user-facing speed-target
changes ship; server and client file counts stay 116 and 53.

## Frozen inputs and repeated measurements

Base is main `e2590f419` (host and joining details on Kit detail). All
measurements are canonical locked builds (`npm run build --prefix web`,
then `node ci/check-kit-perf.mjs --format json`) on Node v24.22.1,
repeated twice per tree.

| Metric | Merged build 1 | Merged build 2 | Base alone | Current ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| Server JS raw | 1204729 | 1204729 | 1202520 | 1203200 | 1205248 |
| Server JS gzip | 337312 | 337311 | 336738 | 337152 | 337664 |
| Client JS raw | 259224 | 259224 | 258144 | 258560 | 259584 |
| Client JS gzip | 103522 | 103522 | 103202 | 103680 | 103680 (unchanged) |

Per-file attribution against the base build: exactly three server files
change — `chunks/events.js` +1827 raw (the honest-state read model and
bounded return builder), `chunks/admin.js` +380 (the same builder via
the shared event routes), `chunks/instance.js` +2 (rename noise). The
auth byte-cap constant is inlined; no join-service module ships in the
events chunk (0 references to its guild-membership entry points). Client
growth is the compiled EventDetail branches for the roster shells and
venue fallback. No accidental imports were found to remove.

## Least-cover sizing and bounded admissions

Aligned least-cover steps on each breached axis, not 25% headroom:

- Server raw 1203200 -> 1205248: +2048 bytes, 0.170%; margin 519 bytes.
- Server gzip 337152 -> 337664: +512 bytes, 0.152%; worst margin 352 bytes.
- Client raw 258560 -> 259584: +1024 bytes, 0.396%; margin 360 bytes.

The old ceilings reject the merged worst build by 1529, 160, and 664
bytes respectively. Client gzip fits unchanged with 158 bytes of margin.
All steps are product-feature admissions inside the feature PR, not a
standalone budget change; each raise is under 0.5%.

For the calendar week beginning 2026-10-26, the last preceding main
commit `2f9e60791d27378d4b07f0cfd615c8af86f04f76` has server raw 1203200,
server gzip 334080, and client raw 254976. Including this admission,
weekly increases are 0.170%, 1.073%, and 1.807% respectively, each below
2%.

Exact-head CI and the merge queue must remeasure composition with later
features. No gate, coverage floor, file-count cap, or user-facing
performance target is changed or bypassed.

## Enforcement

Both shipping oracles retain every previous approved allocation and
rejection fixture. They additionally admit server raw 1205248, server
gzip 337664, and the client pair 259584/103680. Fixed literal fixtures
accept the newly allowed intervals (1204729, 337312, 259224) and exact
ceilings, and reject 1205249, 337665, and 259585. The fragment oracle
admits the new server raw only from its explicit allocation list and
still rejects one-byte drift on every axis.

Undo: revert this feature's fragment changes, oracle additions, and
decision together. Reverting the feature removes the reason for its
allocation; retain other features' independently shipped allocations.
