# 2026-10-28 decision: admit diagnostic states and native links at 337408 server gzip bytes

This admission ships inside feature PR #1700, rebuilt on main
`728b70054b50623e921ee8da1c8ad92132772a15`. Only
`server.js.maxGzipBytes` changes, from 336896 to 337408 (+512 bytes,
0.152%). Raw bytes (1203200), files (126), worker, CSS, startup, and
user-facing performance targets remain unchanged. The independent client
gzip admission is recorded in the sibling client decision.

## Measured attribution

Production builds use Node 24.22.1 and the unchanged locked dependencies.
Commands: `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`.

| Tree | Raw bytes | Gzip bytes | Files |
| --- | ---: | ---: | ---: |
| Pristine main 728b7005 | 1194062 | 336801 | 116 |
| Main plus diagnostic states and optimized outcome links | 1195287 | 337173 | 116 |

The feature adds 372 gzip bytes over current main. The old 336896 ceiling
rejects the combined build by 277 bytes. The next lower aligned ceiling,
337152, still rejects it by 21 bytes; 337408 is the least 256-byte-aligned
cover, with 235 bytes of measured headroom. The usual 1.25 multiplier is
not used. Repeated final builds and their observed results are recorded in
the PR; this decision does not substitute for exact-head CI.

The calendar-week baseline immediately before 2026-10-26 was 334080 bytes
at main `2f9e60791d27378d4b07f0cfd615c8af86f04f76`. The resulting 337408
ceiling is less than 1% above that baseline, within the 2% weekly bound.
This feature's aggregate admission is below 0.5% for this budget. These are
Class B bundle ceilings, not Class A user-facing performance targets.

## Enforcement

The shipping allocation oracle admits this exact server ceiling while
preserving all earlier allocations. The real compressor fixtures pin
337173 as the measured interval, 337408 as accepted, and 337409 as rejected.
The aggregate oracle also rejects 337407 and 337409 as unapproved ceiling
values and retains off-axis drift checks. No scanner, test, threshold in
another dimension, exclusion, workflow, or dependency changes.

Undo: revert this server fragment step, its added allocation controls, and
this decision. Re-measure if the base changes before merge.
