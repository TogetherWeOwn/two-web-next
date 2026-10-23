# Join investigation UI evidence

## Design contract

- **Audience and job:** moderators inspecting a retained join attempt, then returning to the same normalized results after refresh or a new tab.
- **Primary action:** native Back to join attempts. Recovery actions are Clear filters and First page; no JavaScript or browser-history dependency.
- **References:** the existing [Hono list/detail](../../../src/admin/pages/join-attempts.tsx), [Kit list](../../../web/src/routes/admin/join-attempts/+page.svelte), and [moderator guide](../../moderator-admin-guide.md#read-only-join-attempts). Preserve the admin shell, typography, tokens, five-column table and definition lists; no new visual direction.
- **Content:** distinguish an empty retention window, active-filter no matches and an empty later page. Explain missing evidence without inferring anonymity, success, no attempted join or ordinary sign-in. Null/blank diagnostics read Not recorded; nonblank values remain exact escaped text.
- **Layout and responsive behavior:** retain the existing keyboard-focusable horizontal table region, native GET filter form and paging navigation. Recovery links sit outside the scroll region. Screenshots use 1280×800 and 390×844. The scoped join-link focus rule uses the link foreground in both themes.
- **Context:** carry only `from_outcome`, `from_q`, `from_page`; reconstruct only `/admin/join-attempts`. Require exactly one of each, valid percent/UTF-8 encoding, canonical safe page arithmetic and normalized values. Navigation-only bounds: outcome 256 UTF-8 bytes, q 128 code units / 512 UTF-8 bytes, encoded search 4096 bytes. Oversized context is omitted, never truncated. List/storage policy and unknown exact outcomes are unchanged.
- **Non-goals:** authentication, retention, query grammar, UTC/rejected-filter changes, retries, route ownership, telemetry, totals, exports, copying or writes.

The design contract was recorded before product edits. The focus-color refinement was made after opening the keyboard screenshots: the inherited dark ink ring was not visible against the Kit dark background.

## Screenshots opened

All 44 PNGs in this directory were captured and opened for visual inspection. They contain synthetic fixtures only, not member data. `manifest.json` records each image's dimensions and SHA-256.

| State | Before | After |
| --- | --- | --- |
| Filtered page 2 | `before-{Hono,Kit}-{1280,390}-list.png` | `after-{Hono,Kit}-{1280,390}-list.png` |
| Empty filtered page 2 | `before-{Hono,Kit}-{1280,390}-empty.png` | `after-{Hono,Kit}-{1280,390}-empty.png` |
| Direct incomplete detail | `before-{Hono,Kit}-{1280,390}-detail.png` | `after-{Hono,Kit}-{1280,390}-detail.png` |
| Retention-window empty | — | `after-{Hono,Kit}-{1280,390}-retention-empty.png` |
| Filtered first-page empty | — | `after-{Hono,Kit}-{1280,390}-filtered-empty.png` |
| Incomplete list | — | `after-{Hono,Kit}-{1280,390}-incomplete-list.png` |
| Keyboard focus | — | `after-{Hono,Kit}-{1280,390}-{filtered-empty,incomplete-list}-focus.png` |

Hono includes its actual author stylesheet; Kit additionally includes compiled `web/src/app.css`, not a substituted light stylesheet. The Kit shell's existing low-contrast brand/hint/footer remains visible in before and after images; these screenshots are not a claim that the entire Kit shell meets accessibility budgets. New join links have a visible 3px current-color focus ring. Long tables remain horizontally scrollable, and long mobile pages scroll vertically.

## Executed checks and limitations

- Independent acceptance commit `fea68d4c7631ebaaa5c13c869ea080b841707e8d` consumed unchanged as `279a471b8`; stable patch identity `cc482035ab990d959797531b80e833a4f208a3d6` and all four immutable file hashes match.
- `env -u DATABASE_URL -u BOT_DATABASE_URL npx vitest run test/join-investigation-acceptance.test.ts`: fresh RED 28 failed / 13 passed; final GREEN **41/41**, zero skips. No author-owned acceptance edits.
- `NODE_OPTIONS=--import=tsx npx playwright test --config=test/helpers/join-investigation.config.ts`: fresh RED 8 failed / 4 passed; final GREEN **12/12**, no retries/skips. Both twins/two widths use native Tab/Enter, refresh/new-tab navigation, First page and Clear filters with JavaScript disabled and external requests blocked.
- Additional real-renderer local-fixture browser captures exercise retention-empty, filtered-empty and incomplete-list states at both widths. All 12 observations have no document-level horizontal overflow. Eight keyboard-focus observations verify a 3px outline matching the link foreground after an observed pre-fix mismatch. This scratch probe is supplementary, not a replacement for an independently maintained test.
- Neighboring eight-file baseline passed **225/225** before implementation. The final nine-file regression run, including the branch-floor suite, executes **311 cases: 294 pass / 17 fail / zero skipped**. Failures pin retired bare detail links, old empty/dash copy, old Svelte source shapes, or incomplete mocked Kit events without `url`. Independent test-author correction is required; no product workaround, test edit, skip or waiver is used.
- `npm run lint`, `npm run typecheck`, `npm run e2e:typecheck`, strict test inventory (**1136/1136**), `npm run floor-guard`, `npm run build:assets:check`, `npm run budget`, and `git diff --check` passed.
- `npm run check --prefix web` initially failed because generated `$app/tsconfig.json` root directories pointed into the external dependency install. Corrected only that run-owned generated file to the actual workspace/types roots; `svelte-check --workspace web --tsconfig <web-tsconfig> --fail-on-warnings` then completed **1218 files, zero errors/warnings**. No tracked config relaxation.
- `npm run build --prefix web` and `node ci/check-kit-perf.mjs` passed after reusing the existing shared table-query module rather than adding a client chunk. Server gzip **329382/329472 B**, client JS **99564/101632 B**, CSS **983/1024 B**, client files **54/54**. No allowance changed.
- `npm run a11y`: **146 Hono fixture scans passed**, zero failures. `npm run lighthouse` and `npm run lighthouse:quality`: **24/24 reports each, assertions passed**. These runs preceded the final join-link-only focus-color rule; they do not establish Kit route coverage. Exact-head CI must re-establish the complete gates.
- `NODE_OPTIONS=--import=tsx npx playwright test --config=playwright.visual.config.ts` refused before execution: the spec requires the Linux GitHub Actions runner. The guard was not bypassed. No baseline was changed; CI visual verification remains required.
- `npm run check` was started against a fresh migrated run-owned disposable database; a green full-suite verdict is not yet available. It exposed the stale branch-floor/table assertions and an inherited-token hermetic-fixture failure. With `CLOUDFLARE_API_TOKEN` unset for `test/jobs-handoff.test.ts`, that suite passed **68/68** without source edits. This does not make the incomplete full check green.

No staging/production tests, probes or migrations were performed. These are local fixture/rendering proofs, not a deployed-route receipt. Exact-head CI, independent security review and independent PR review remain release gates. Revert the single behavior PR for a regression; no data rollback is needed.
