# Restored-write notice and stale-save rejection: server raw allocation

Main tip `66ee3682da324dc129ac53764956e7131dcbeeba` (theme migration #2032
merged onto main) measures 1232399 server raw bytes against the retained
1229312 ceiling and fails `check` at the Kit performance budget step
(main CI run 42939882535). This file records the least-cover raises to
1233408 so main is green again. No shipped product code is removed and no
other ceiling or gate changes.

## Why the growth is intentional

The 1229312 ceiling was allocated for the profile bidi and invisible-character
rule (composed build 1228751, see
[2026-11-07-profile-bidi-invisible.md](2026-11-07-profile-bidi-invisible.md)).
The theme migration was measured before it merged at 1223993 raw on its
integration build over base `1fe09ab868a6fea4a7873e4a096523b78747b232` and
did not breach. After that measurement, intentional product changes
landed on main and merged below the theme tip: the verified restored-write
notice (`fix(kit): show verified restored-write notices on documents`,
#2113), which forwards a boolean through the root load and the Shell,
AdminShell and ProfileView notice slots across the document routes, the
stale event and featured save rejection with draft preservation
(`fix(admin): reject stale event and featured saves without losing drafts`,
#2112), and, after the first sizing, the operator-settings warning
(`fix(config): warn safely on invalid operator settings`, #2111),
which emits fixed setting-name/action diagnostics from CspReport, headers,
image-policy and config paths. Re-measuring the composed main is therefore
growth from real, already-merged product features, not drift, tooling churn
or an unbounded relaxation.

## Measurements

Exact-head Actions CI measured the composed build on successive heads:

- Main tip `66ee3682`: 1232399 raw bytes, `check` failing only at
  `server js: raw 1232399B over 1229312B` (run 42939882535,
  `ci-ok` failed downstream).
- Test/proof-only PR #2110 head `647aeb502384768a34a8e521899125bc35011f2b`:
  1232397 raw bytes (run 42946370296, job `check` 130280218097). That PR
  changes only workflow/test/ci files, so its measurement is an independent
  confirmation of the same composed sources; the 2-byte round-trip variance
  matches the generated version/global length variation documented in
  [2026-11-04-ember-server-allocation.md](2026-11-04-ember-server-allocation.md).
- Main tip `fe707a0ec73bde223061e396dc0517a645bc6311` (operator-settings
  warning #2111 merged after the first sizing): 1233211 raw bytes,
  `check` failing at `server js: raw 1233211B over 1229312B` (run 42954334978,
  job `check` 130305771829; memoised on the client-budget-ratchet run 42954334887).
  This tip is the current base of this PR; the 1232896 step from the first
  sizing rejects it by 315 bytes, so it is not least-cover on the current main.

No local build was run to size either allocation.

## Least-cover sizing

- Server raw 1229312 -> 1232896: +3584 bytes, 0.29%. Of the 512-byte
  steps above 1229312, 1232384 rejects the composed worst (1232399) by 15,
  so 1232896 was the smallest 512-aligned ceiling that admitted it, leaving
  497 bytes of margin. It takes no additional headroom beyond this single
  least-cover step.
- Server raw 1232896 -> 1233408: +512 bytes, one further 512 step. 1232896
  rejects the current worst (1233211) by 315, so 1233408 is the smallest
  512-aligned ceiling that admits the current main, leaving 197 bytes of
  margin. The 1233408 floor is the shipped ceiling; 1232896 remains pinned
  as the earlier approved allocation in the oracles so history is explicit.
- Server raw's principle is otherwise unchanged: raw stays hard-gated, and
  the 126-file cap is untouched (no file-count breach on any head).
- Server gzip stays at 342272. The same heads measure 343365 gzip on the
  first main tip and 343669 gzip on the current main tip, which over
  342272 is a hard breach but is the advisory dimension under
  [2026-11-04-server-gzip-runtime-boundary.md](2026-11-04-server-gzip-runtime-boundary.md):
  gzip-only overage warns and does not gate, and CI reported only the raw
  breach as the failing step. This PR does not raise the gzip ceiling.

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1232896 and 1233408 only from its explicit allocation list and keeps every
earlier allocation. The checker fixtures in `ci/check-kit-perf.test.mjs`
pin the allowed intervals (1232399 / 1233211), exact ceilings
(1232896 / 1233408) and one-over cases (1232897 / 1233409) for both ceilings.

Undo: revert this PR, including its fragment change and oracle controls.
