# Featured stale-save conflict-flow evidence

## Design contract

Audience: moderators retaining unsaved featured-slot drafts. Job: refuse stale writes without losing the submitted draft. Primary action: **Review the current version**, then deliberately reapply intended edits; no automatic overwrite or retry.

References are the existing featured conflict notice, admin Shell/form tokens, and editor session-expiry recovery notice. Keep native controls, `.notice`, typography and responsive spacing. No new visual direction, framework, schema, grant, mutation endpoint, force-overwrite control or runtime threshold change.

Required states: fresh form, full-draft 409 with the saved snapshot observed under the committing lock, network-history restoration with the original precondition, and expired-session conflict with draft-preserving recovery. The history controller loads only on featured edits, before the generic editor. Native autocomplete is disabled on both edit renderers.

## Screenshots

Actual Hono routes and shipped scripts, Chromium, synthetic sessions and an isolated disposable PostgreSQL schema. Every image was opened. Desktop viewport 1280×800; mobile 390×844; captures show the complete page. These are state comparisons, not old-head before/after renders. Existing pre-feature evidence remains part of the original feature verification.

| State | Desktop | Mobile |
|---|---|---|
| Fresh/reference form | [fresh](fresh-1280.png) | [fresh](fresh-390.png) |
| Refused draft, saved preview unchanged | [conflict](conflict-1280.png) | [conflict](conflict-390.png) |
| Network Back, original precondition retained | [history](history-1280.png) | [history](history-390.png) |
| Focus discovers expiry without leaving the draft | [expired](expired-1280.png) | [expired](expired-390.png) |

Visual review: notices wrap without horizontal overflow, the saved preview and editable draft remain distinct, all fields/actions stay available, and the recovery link has a visible focus boundary. A focused skip link is visible in some full-page captures; it is existing focus behavior, not an accepted baseline change. No baseline was regenerated or mask expanded.

## Behavioral proof

- Original independent stale-save acceptance: 24/24; unconditional low-level concurrency/audit contract: 10/10, unchanged files.
- Builder regression files cover tuple-incarnation ABA refusal, locked snapshot recovery despite a hypothetical failed reread, exactly one auth-status script on 409, and history-entry baseline pinning including late control restoration and missing history state.
- Actual Hono/Chromium probes: network Back performed a second GET. With scripting, the original baseline survived and a restored/reapplied old title still produced 409 with the saved title unchanged. Without scripting, autocomplete-off prevented old title/body restoration; the controls showed the current saved values. These are targeted Chromium observations, not a guarantee about every browser's history implementation.
- Focus-driven `/auth/status` false on a 409 displayed the existing recovery notice without navigation or draft loss. The status response was a controlled local fixture, not a deployed session test.

## Gates and limits

Affected matrix: 60 files, 1890 passed and 56 pre-existing browser-opt-in skips. Final narrow rerun: 85/85, overlapping the matrix. Shipping budget proofs: 83/83. Smoke: 407/407. Accessibility: 146 fixture/viewport passes. Root/Kit/E2E types, source lint, docs, strict inventory, floor guard, asset drift and budgets pass.

Two final Kit builds: server gzip 337653/337652 versus the unchanged 337664 ceiling; client 257272 raw/103255 gzip versus 258048/103424. No existing ceiling was raised. The new featured-only island measures 989 raw/570 gzip and has its own initial 1536/768 allocation; generic editor bytes are unchanged.

Local Lighthouse performance and quality attempts did **not** complete: the sandbox lacks `ps`; the first failure left its local server alive and the second hit that occupied port. That run's entire orphaned server tree was explicitly stopped. No class-A threshold was changed. Exact-head CI must provide Lighthouse proof. Full root check/coverage, full browser/visual-regression suites, Kit browser screenshots, staging and deployment were not run here. No staging or release PASS is claimed.
