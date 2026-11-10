# Session role recheck review hardening

Two review fixes on the session role recheck grow the same Kit server
path measured in
[2026-11-02-session-role-recheck-server.md](2026-11-02-session-role-recheck-server.md):
the guild-member lookup now classifies a 404 by Discord error code
(only 10007 Unknown Member is definitive), and session rotation mints
its successor with the least-privileged combination of caller and
source bits in both stores. No dependency, file-count, client, CSS,
worker, startup or user-facing speed target changes.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root
and web lockfiles. The hardened tree was built twice.

| Metric | Hardened build 1 / 2 | Recheck ceiling | Hardened ceiling |
| --- | ---: | ---: | ---: |
| Server JS raw | 1217202 / 1217202 | 1217024 | 1217536 |
| Server JS gzip | 340038 / 340039 | 339968 | 340224 |

Hardening delta over the recheck builds (1217003 / 339958): +199 raw
and +80 to +81 gzip bytes. Server file count is unchanged at 116/126.
Client JS (260397 / 103901), client CSS and the Worker entry are
unchanged.

## Sizing

Least-cover aligned steps (raw to 512 bytes, gzip to 256 bytes), not
25% headroom:

- Server raw 1217024 -> 1217536: +512 bytes (0.042%); margin 334 bytes.
  The lower 1217024 step rejects by 178.
- Server gzip 339968 -> 340224: +256 bytes (0.075%); margin 185 to 186
  bytes. The lower 339968 step rejects by 70 to 71.

Across the whole feature the ceilings move 1211392 -> 1217536 raw
(+6144 bytes, 0.507%) and 338688 -> 340224 gzip (+1536 bytes, 0.454%)
from the pre-feature steps. The raw total sits just over the 0.5%
per-feature guide earlier decisions cite: the least-cover steps give
no smaller covering step, and the excess is the two review fixes
above, measured after the first step landed. No gate, coverage floor,
file-count cap or user-facing performance target is changed or
bypassed. Exact-head CI must remeasure composition with later
features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1217536 and server gzip 340224. Fixed fixtures accept the measured
sizes (1217202 raw, 340039 gzip) and the exact ceilings, and reject one
byte over each.

Undo: revert this PR, including its fragment change and oracle
controls.
