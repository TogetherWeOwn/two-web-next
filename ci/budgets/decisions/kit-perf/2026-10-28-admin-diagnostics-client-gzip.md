# 2026-10-28 decision: admit diagnostic links at 103680 client gzip bytes

This admission ships inside feature PR #1700, rebuilt on main
`728b70054b50623e921ee8da1c8ad92132772a15`. Only
`client.js.maxGzipBytes` changes, from 103424 to 103680 (+256 bytes,
0.248%). The raw ceiling stays 258048 and the file ceiling stays 55. Worker,
CSS, startup, and user-facing performance targets are unchanged. The
independent server gzip admission has its own sibling decision.

## Measure and optimize first

With Node 24.22.1 and unchanged locked dependencies, the first rebuild on
main 789e8a66 measured 258013 raw / 103686 gzip client bytes. Removing the
redundant query parser from both dashboard renderers reduced that to
257760 raw / 103554 gzip: 253 raw and 132 gzip bytes saved. Both renderers
still use the canonical URL builder with the known page-one, empty-search
state. The destination parser and acceptance tests verify exact recorded
outcomes, including whitespace and URL-sensitive unknown strings. A stored
PostgreSQL text outcome cannot contain the NUL removed by the query parser.
No user-visible copy, escaping, URL, or behavior was changed to save bytes.

After the base advanced to 728b7005, production builds through
`npm run build --prefix web` and `node ci/check-kit-perf.mjs --format json`
measured these trees:

| Tree | Raw bytes | Gzip bytes | Files |
| --- | ---: | ---: | ---: |
| Pristine main 728b7005 | 257102 | 103192 | 54 |
| Main plus diagnostic states and optimized outcome links | 258043 | 103645 | 55 |

The feature adds 453 gzip bytes over current main. The old 103424 ceiling
rejects it by 221 bytes. 103680 is the least 256-byte-aligned cover and
leaves 35 gzip bytes. The unchanged raw ceiling has only 5 bytes of
headroom: re-measure on a changed base rather than treating this as a broad
allowance. Repeated final builds and exact-head CI remain separate proofs.

The calendar-week baseline immediately before 2026-10-26 was 102912 gzip
bytes at main `2f9e60791d27378d4b07f0cfd615c8af86f04f76`; the resulting
103680 ceiling is less than 0.75% above it. This feature's aggregate 0.248%
admission is below 0.5%, and calendar-week growth stays below 2%. This is a
Class B bundle-size admission, not a change to any Class A user target.

## Enforcement

The aggregate shipping oracle admits only the complete 258048/103680 pair,
while preserving prior pairs. It rejects neighboring raw/gzip pairs and
every unrelated-axis drift. Existing real-compressor cases accept exactly
103680 bytes and reject 103681. The prior negative test for the newly
admitted pair becomes a positive case; all other rejection points remain,
and four new neighboring invalid pairs are added. No assertions, scanners,
workflows, exclusions, dependencies, or user-facing targets are removed.

Undo: revert only this client gzip fragment step, its paired-allocation
controls, and this decision. Keep measuring in merge-queue order.
