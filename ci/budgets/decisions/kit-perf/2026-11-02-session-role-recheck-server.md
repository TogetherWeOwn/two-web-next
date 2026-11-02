# Session role recheck lands in the Kit server bundle

Sessions now re-derive their member/moderator bits from Discord
periodically during a live session instead of keeping the login-time
derivation until the 24h cap. The Kit server bundle reaches the refresh
through `src/kit-session.ts`, so the re-derivation lands in it:
`src/session-role-refresh.ts`, the tri-state guild-member lookup in
`src/roles.ts` that the refresh shares with the login derivation, the
QA fixture-id check, and the new session-store due/apply methods in
`src/sessions.ts`. This builds on the MCP truncation-notice step
([2026-11-01-mcp-truncation-notice-server.md](2026-11-01-mcp-truncation-notice-server.md)).
No dependency, file-count, client, CSS, worker, startup or user-facing
speed target changes.

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root
and web lockfiles. The feature tree was built twice; the base is
`a279b699`, the main commit the feature branch sits on.

| Metric | Feature build 1 / 2 | Base build | Truncation-notice ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1217003 / 1217003 | 1210945 | 1211392 | 1217024 |
| Server JS gzip | 339958 / 339958 | 338641 | 338688 | 339968 |

Feature delta over the base build: +6058 raw and +1317 gzip bytes, the
re-derivation path described above. Exact-head CI measured the same
raw size and 339956 gzip (2-byte builder variance, inside the margin
below). Server file count is unchanged at 116/126. Client JS
(260397 / 103901), client CSS and the Worker entry are unchanged.

## Sizing

Least-cover aligned steps (raw to 512 bytes, gzip to 256 bytes), not
25% headroom:

- Server raw 1211392 -> 1217024: +5632 bytes (0.465%); margin 21 bytes.
  The lower 1216512 step rejects by 491.
- Server gzip 338688 -> 339968: +1280 bytes (0.378%); margin 10 bytes.
  The lower 339712 step rejects by 246.

The truncation-notice ceilings reject this build by 5611 raw and 1270
gzip bytes. Each raise is under the 0.5% per-feature limit. No gate,
coverage floor, file-count cap or user-facing performance target is
changed or bypassed. Exact-head CI must remeasure composition with
later features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1217024 and server gzip 339968. Fixed fixtures accept the measured
sizes (1217003 raw, 339958 gzip) and the exact ceilings, and reject one
byte over each.

Undo: revert this PR, including its fragment change and oracle
controls.
