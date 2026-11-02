# Moderator row accessible names

The §4a accessible names on the moderator tables grow both Kit bundles
measured in
[2026-11-02-session-role-recheck-hardening-server.md](2026-11-02-session-role-recheck-hardening-server.md):
every row action now carries a name (`Publish {title}`,
`Cancel event {title}`, `Pause/Reopen RSVPs for {title}`, with the ISO
`sameTitleSuffix` disambiguator only for same-title rows), and the UTC
column headers spell out `(UTC)`. The Hono-rendered names ship inside the
Kit server output and the Svelte twin components ship the same strings in
the client bundle. No dependency, file-count, client-CSS, worker,
startup or user-facing speed target changes.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root
and web lockfiles. The feature tree was built twice.

| Metric | Feature build 1 / 2 | Hardening ceiling | Feature ceiling |
| --- | ---: | ---: | ---: |
| Server JS raw | 1219131 / 1219131 | 1217536 | 1219584 |
| Server JS gzip | 340593 / 340594 | 340224 | 340736 |
| Client JS raw | 261250 / 261250 | 260608 | 261632 |
| Client JS gzip | 104332 / 104332 | 103936 | 104448 |

Server and client file counts are unchanged (no `files` breach at either
build). Server delta over the hardening builds (1217202 raw,
340038/340039 gzip): +1929 raw and +555/+556 gzip bytes. Client delta
over the recovery builds (260403 raw, 103909 gzip): +847 raw and +423
gzip bytes.

## Sizing

Least-cover aligned steps (raw to 512 bytes, gzip to 256 bytes), not
25% headroom:

- Server raw 1217536 -> 1219584: +2048 bytes (0.168%); margin 453
  bytes. The lower 1219072 step rejects by 59.
- Server gzip 340224 -> 340736: +512 bytes (0.150%); margin 143 then
  142 bytes. The lower 340480 step rejects by 113 and 114.
- Client raw 260608 -> 261632: +1024 bytes (0.393%); margin 382 bytes.
  The lower 261120 step rejects by 130.
- Client gzip 103936 -> 104448: +512 bytes (0.493%); margin 116 bytes.
  The lower 104192 step rejects by 140.

Growth vs ceiling is 0.131% server raw, 0.109% server gzip, 0.246%
client raw and 0.381% client gzip — within the sub-0.5% pattern of
recent decisions. No gate, coverage floor, file-count cap or
user-facing performance target is changed or bypassed. Exact-head CI
must remeasure composition with later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1219584 and server gzip 340736 plus the client pair 261632/104448.
Fixed fixtures accept the measured sizes (server 1219131 raw,
340594 gzip; client 261250 raw, 104332 gzip) and the exact ceilings,
and reject one byte over each.

Undo: revert this PR, including its fragment change and oracle
controls.
