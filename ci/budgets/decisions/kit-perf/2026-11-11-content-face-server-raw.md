# Content display face leaf growth: server raw allocation

The content display face change (PR #2120) restores the brand display face
on the content pages (`/about`, `/faq`, `/rules`, `/privacy`) without a
preload and without a late swap. The four Kit content routes inline the
leaf critical CSS (`LEAF_CRITICAL_CSS` from `src/leaf-critical-css.ts`,
which concatenates `public/styles.css`, `public/theme-tokens.css` and
`public/theme.css`) into their server-rendered pages, so the new
`Mona Sans Content` face and the unguarded display rules grow the Kit
server JS by roughly the leaf bytes. Exact-head Actions CI measured the
composed build at 1233453 raw bytes against the 1233408 ceiling and
failed `check` at the Kit performance budget step (run 42985471999).
This file records the least-cover raise to 1233920 so that PR can restack
onto green main. No shipped product code is removed and no other
ceiling or gate changes.

## Why the growth is intentional

The 1233408 ceiling was allocated for the operator-settings warning on
top of the restored-write notice and the stale-save rejection (composed
build 1233211, see
[2026-11-11-restored-write-notice-server-raw.md](2026-11-11-restored-write-notice-server-raw.md)).
The leaf growth is the required cost of the content display face: the
minified `public/theme.css` grows 12256 -> 12496 bytes (+240) with the
new optional face, the content-theme display token and the seven removed
`:not(.content-theme)` guards. Re-measuring the composed build therefore
shows growth from a real, already-reviewed product feature, not drift,
tooling churn or an unbounded relaxation.

## Measurements

- Main tip `c7b6a48c9` (the 1233408 ceiling): `check` green in exact-head
  Actions CI.
- Content display face PR #2120 head `3aacbd963`: 1233453 raw bytes,
  `check` failing only at `server js: raw 1233453B over 1233408B`
  (run 42985471999, job `check` 130405669795).
- Composed growth over main's 1233211 worst is 242 bytes, matching
  the +240 leaf bytes plus the 2-byte round-trip variance documented in
  [2026-11-04-ember-server-allocation.md](2026-11-04-ember-server-allocation.md).

No local build was run to size this allocation.

## Least-cover sizing

- Server raw 1233408 -> 1233920: +512 bytes, one further 512 step. The
  1233408 step rejects the composed worst (1233453) by 45, so 1233920 is
  the smallest 512-aligned ceiling that admits it, leaving 467 bytes of
  margin. The 1233920 floor is the shipped ceiling; 1233408 remains
  pinned as the earlier approved allocation in the oracles so history is
  explicit.
- Server raw's principle is otherwise unchanged: raw stays hard-gated, and
  the 126-file cap is untouched (no file-count breach on this head).
- Server gzip stays at 342272. The same head measures 343669 gzip, the
  same advisory overage as main, which warns and does not gate under
  [2026-11-04-server-gzip-runtime-boundary.md](2026-11-04-server-gzip-runtime-boundary.md).
  This PR does not raise the gzip ceiling.

## Enforcement

The fragment oracle in `ci/budget-fragments.test.mjs` admits server raw
1233920 only from its explicit allocation list and keeps every earlier
allocation. The checker fixtures in `ci/check-kit-perf.test.mjs` pin
the allowed interval (1233453), the exact ceiling (1233920) and the
one-over case (1233921) for the new ceiling.

Undo: revert this PR, including its fragment change and oracle controls.
