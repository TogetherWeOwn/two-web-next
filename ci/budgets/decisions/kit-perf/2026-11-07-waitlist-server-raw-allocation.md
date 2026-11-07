# Bounded server-JS raw allocation for global waitlist positions

Allocate 1,024 raw server-JS bytes for the global waitlist-position composition
in [#2002](https://github.com/TogetherWeOwn/two-web-next/pull/2002), supporting
[#2001](https://github.com/TogetherWeOwn/two-web-next/issues/2001). This is a
separate measured feature allocation, not a runtime correction or automatic
25% headroom. Only the server fragment, independent shipping oracle fixtures
and this decision change.

## Immutable Actions measurements

The shipping checker is `node ci/check-kit-perf.mjs`, after the locked Kit
adapter build in GitHub Actions. It sums raw bytes and default Node per-file
gzip bytes over the generated inventory; rounded Vite totals are not evidence.

- Base main: `9822a6e60c6b2229c8b823bb481c87fb29fa85c9`.
  [Ratchet measurement job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42357800396/job/128359627749)
  passed: server **114/126 files**, **1,221,826/1,222,656 raw B** and
  **340,982/342,272 gzip B**. The workflow later failed its proposal job;
  that does not turn the successful measurement into a failed checker.
- Feature: `cad8b17c3bc7064d33ea4eed1e71729acffc5018`.
  [Exact-head check job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42358851525/job/128362743446)
  failed the shipping checker at **1,223,241/1,222,656 raw B**, a **585 B**
  deficit. This is not a green full CI run. Lint, types and coverage passed
  (26,416 tests passed / 676 skipped; 1,264 files passed / 5 skipped).
  Later runtime, Semgrep and dry-run steps were skipped after the budget
  failure; their absence is not passing evidence.

The combined feature delta from that base is **1,415 raw B**. The feature head
already includes its permitted shared-prefix correction while retaining SQL,
classifier semantics and hostile tests. These totals do not establish an
isolated saving from that correction. No source or generated build output is
rewritten here. The allocation PR and later composed feature head still need
their own exact-head Actions evidence; these measurements do not stand in for
those checks. Recheck the live fragment and measurements if these inputs drift;
there is no authorization to silently enlarge this allocation.

## Sizing and benefit

| Server dimension | Old ceiling | New ceiling | Observed evidence |
| --- | ---: | ---: | --- |
| Raw bytes | 1222656 | 1223680 | Feature 1223241; margin 439 |
| Per-file gzip bytes | 342272 | 342272 | Base 340982; no allocation increase |
| Files | 126 | 126 | Base 114; hard gate retained |

The minimum 512-byte-aligned increase covering 585 B is **+1,024 B**:
+512 would give 1,223,168 B and still reject the feature by **73 B**;
+1,024 gives 1,223,680 B and **439 B** of observed headroom. The increase is
about **0.084%** of the old raw ceiling. This explicit least-cover decision
uses the exception in `ci/budgets/README.md`, not its default measured-size
multiplier. Gzip remains advisory and gets no raise; raw and file count remain
hard gates.

The feature lets moderators see global queue positions on paged rosters,
using the exact bounded, audited owner classifier rather than a broader
lookalike match. It includes moderator rendering in both page renderers. This
allocation adds none of that runtime code and changes neither its SQL nor its
security boundary. Server JS is not browser transfer, but more server bytes
can have a non-zero startup or TTFB cost; no zero-cost or measured-startup
improvement is claimed.

## Enforcement, retained gates and undo

Both shipping oracles retain every historical case. The new literal raw
fixtures admit the observed **1223241**, accept exact **1223680**, and reject
**1223681** with other axes in bounds. The fragment oracle also rejects the
unallocated lower step **1223168**, adjacent **1223679**, gzip drift **342273**
and count drift **127**. Fixture byte sizes do not derive from the fragment.
Existing checker coverage keeps gzip advisory and raw/file-count breaches hard.

Worker, client, CSS, startup, UI, accessibility, Lighthouse, security, coverage,
inventory and visual thresholds are unchanged. No migration, dependency,
workflow, source renderer or generated-output change is included. This PR
authorizes no production merge or deployment. Its final reviewer must obtain
this PR's own fresh exact-head Release Manager confirmation and pin the squash
merge to that head; the renderer cannot borrow that confirmation. Automatic
post-merge staging/e2e/soak and production guards, incident/freeze holds and
rollback requirements remain in force; no pre-merge staging is required.

Before the renderer ships, undo this allocation by reverting its fragment and
added oracle controls together with this decision; the measured base fits the
old ceiling. After it ships, first revert its growth or independently prove
sufficient savings before ratcheting back to **1222656**. If later source
sharing or build changes recover the bytes, measure the then-current complete
composition in Actions and propose a separate downward ratchet. Never undo the
cap alone while knowingly leaving an over-budget feature, take automatic extra
headroom, or treat future savings as already established.

REA angle: reuse the shipping fragment loader, canonical checker, independent
literal boundary oracles and activity-log/Ember allocation precedents. No new
tooling or runtime design is needed.
