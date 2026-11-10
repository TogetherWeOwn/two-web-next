# RFC 5892 joiner tables in the shared text rule

`containsControlCharacters` (`src/admin/validation-shared.ts`) now admits
the RFC 5892 Appendix A.1/A.2 orthographic joiners: ZWJ/ZWNJ after a
virama, and ZWNJ between Arabic-joining letters. That needs the exact
Unicode 17.0.0 Joining_Type L/D, R/D and T sets plus the 69 viramas. The
Kit server bundles the admin validators, so the tables ship in
`chunks/admin.js`. No dependency, asset-count, CSS, client, startup or
user-facing speed-target changes.

## Measurements

Per-file attribution, measured on the feature built over `004ce006`:
exactly one server file changes, `chunks/admin.js`, +4225 raw and +1906
gzip. Kit client JS is byte-identical to main.

Exact-head CI measured the composed build (this branch merged with main
`2c86dc09`, merge ref `3d0a43fc`) at 1228316 raw across 114 files. Main
alone measured 1224091 at `2c86dc09`, so this feature adds 4225 raw,
matching the per-file attribution. The fixture interval value is the
1228316 measurement.

Main alone at `2c86dc09` is 1435 bytes over its own 1222656 ceiling. Its
server JS grew from 1222363 at `21a17861` through #2056 and #2001, each
of which fit on its own base. This step therefore also covers that main
growth; it is recorded here, not attributed to this feature. Earlier
measurements of this branch over `161462d2` (1226469) and `21a17861`
(1226590) fit 1226752 for the same reason.

Compaction already applied before sizing:

- The tables ship as base-36 "gap,length" range strings decoded to sorted
  bounds with a binary search, not as generated RegExp character classes.
  The RegExp form measured +7522 raw / +3159 gzip; the strings are 2217
  raw / 937 gzip on their own.
- Decoding is lazy (first call), not at module load. A top-level decode is
  a side effect, and it pulled the tables into a Kit client node that
  imports `src/admin/validation` for other names (+2691 raw / +1289 gzip
  client JS). With lazy decoding the client output is byte-identical to
  main.

Dropping the exact tables for `\p{Mn}`/`\p{Cf}` approximations would be
smaller, but it would tie the rule to the runtime's Unicode version and
lose the conformance test's exact-match guarantee, so this PR keeps them.

## Least-cover sizing

- Server raw 1222656 -> 1228800: +6144 bytes, 0.503%; the smallest
  512-byte step that covers the composed build (1228288 rejects it by
  28). Headroom over the `2c86dc09` measurement is 484 bytes. Of the
  6144, 1435 cover main's own overage at `2c86dc09` and 4225 this feature.
- Server gzip stays at 342272. Since
  `2026-11-04-server-gzip-runtime-boundary.md`, server gzip overages warn
  and do not gate, so this PR does not raise that ceiling.

This is a security-fix admission inside the feature PR, not a standalone
budget change. No Class-A budget changes.

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1228800 only from its explicit allocation list and keeps every earlier
allocation. The checker fixtures in `ci/check-kit-perf.test.mjs` pin the
interval, exact and one-over cases for the new ceiling.
