# Visual regression

`e2e/visual/public-pages.visual.ts` takes full-page screenshots of the routes and
event states below at desktop (1280×800) and mobile (390×844) widths and compares
them with the committed baselines in `e2e/visual/__screenshots__/`.

| Baseline | Route | Viewer | Status |
| --- | --- | --- | --- |
| `home` | `/` (`/community` redirects here) | guest | 200 |
| `events` | `/events` | guest | 200 |
| `event` | `/e/01J00000000000000000000001` (the seeded event) | guest | 200 |
| `past` | `/events/past` | guest | 200 |
| `about` | `/about` | guest | 200 |
| `rules` | `/rules` | guest | 200 |
| `privacy` | `/privacy` | guest | 200 |
| `event-paused` | `/e/01J00000000000000000000005` (published, RSVPs paused) | signed-in member | 200 |
| `event-cancelled` | `/e/01J00000000000000000000006` (cancelled) | guest | 410 |

Each baseline exists at both widths (`<name>-desktop.png`, `<name>-mobile.png`).

- **Event states:** the paused and cancelled events are not in the seed. A future
  paused or cancelled row would show up in `/events`, in the seeded event's "more
  events" cards and in the journeys' lists, so the spec inserts both rows after the
  public routes have been compared and deletes them when its block ends (the same
  disposable Postgres guard as `e2e/seed.mjs`). Only a signed-in member sees the
  paused notice (a guest gets the sign-in link), so that test signs in once through
  the stubbed Discord OAuth round trip that `e2e/join.spec.ts` uses, for both
  widths. It does not use the QA login: the journeys that run next already spend
  the whole `qa-login` throttle (10 per minute, `e2e/fixtures.ts`), and one more
  login there turns the last journey login into a 429. The cancelled page is the
  same 410 for a guest and a member, so it needs no login.
- **Where it runs:** the `browser-smoke` job in `.github/workflows/e2e.yml`, before
  the critical journeys, on the freshly seeded local stack (no secrets, no
  staging or production). `e2e-ok` is the required check: a visual diff
  fails `browser-smoke`, which fails `e2e-ok` and blocks the merge. Docs-only,
  test-only and draft PRs skip it (the aggregator passes the skip only on the
  scope verdict or a draft).
- **Stability:** `<time>` elements are masked (server-rendered times follow the
  wall clock), animations are disabled, and the caret is hidden. A route must
  return the status in the table above.
- **Threshold:** `maxDiffPixels: 300` per screenshot
  (`playwright.visual.config.ts`). An absolute budget, not a ratio: a ratio
  grows with page height, so a vanished primary button still passes. CI never
  rewrites an existing baseline (`updateSnapshots: "missing"` only creates
  absent ones), and the job fails while any generated baseline is uncommitted.
- **Runner pin:** `browser-smoke` runs on pinned `ubuntu-24.04` (not
  `ubuntu-latest`) because body text uses the runner's system fonts. A runner
  image bump or a Playwright bump (`@playwright/test` in `package.json`) can
  shift text rendering, so either bump is expected to re-baseline through the
  failure artifact in its own PR.

## When a diff is intentional

1. Download the `e2e-failure-<run>` artifact from the failed run. It holds the
   expected, actual and diff images under `test-results-visual/`, the whole
   `e2e/visual/__screenshots__/` directory (committed baselines plus any newly
   generated ones), and an HTML report under `playwright-report-visual/`.
2. Check every diff image. Only accept changes the PR meant to make.
3. Run `node ci/visual-accept.mjs <unzipped-artifact-dir>`, which copies each
   `*-actual.png` over its baseline and each new baseline into place. Only
   actual images under the exact `test-results-visual` directory segment inside
   the extracted artifact have Hono replacement authority. An extraction folder
   named like a suite does not itself confer authority. Unrelated, lookalike
   and Kit suite screenshots are ignored. A reviewed actual supersedes the
   stale committed copy of the same baseline inside the artifact. Copies under
   the existing Hono baseline path can add absent baselines or match identical
   bytes, but cannot replace differing checkout bytes; a reviewed matching
   actual outranks its stale artifact copy. A baseline-directory copy alone can
   add a genuinely absent baseline or match an existing one (a byte-identical
   no-op). A stale-copy conflict names that baseline and refuses the entire
   plan. Use a current artifact or review a matching actual; do not delete the
   newer checkout baseline to force acceptance. Conflicting actuals, differing
   copies without an actual, and unreadable sources or existing targets also
   refuse before any baseline is written.

   Preview with `node ci/visual-accept.mjs --dry-run <artifact-root>`, or add
   `--format json` for the versioned verdict with the dry-run plan and next
   action. Apply uses the same validated plan with `node ci/visual-accept.mjs
   <artifact-root>`. Validate flags and the entire bounded plan before creating
   any directory or writing any destination. Input roots must be real
   directories; reject symlinks at the root, in its ancestry and among
   discovered descendants, including cycles. The walk permits regular files and
   directories only; pipes, sockets and devices refuse with `IO_ERROR` before
   any read. Existing baseline targets must be regular files too. Reject linked
   destination files, the destination root and linked ancestors. The artifact
   budget is 64 directory levels (root is level 1) and 4096 visited entries
   (files and directories, including ignored entries); exceeding either refuses
   with `ARTIFACT_LIMIT`. Keep resolved sources and
   destinations inside their intended roots, and apply the source bytes cached
   during preflight. Any boundary refusal leaves existing destinations and
   outside files unchanged. All source bytes and local targets are preflighted
   first. This assumes no concurrent hostile filesystem writer; apply-time disk
   failures are not rolled back.

   Suite ownership uses exact directory segments relative to the unzipped
   artifact root, not substrings or the extraction folder's name. Kit output
   directories (`test-results-kit-visual/`, `test-results-kit-parity/`, and
   `__screenshots-kit__/`) are excluded; use the
   [Kit acceptance guide](kit-parity-gates.md#visual-gates) for those images.

   Both accept scripts take `[--dry-run] [--format json] <artifact-dir>`.
   `--dry-run` prints a bounded preview of the plan (destinations and sources,
   skipped sources with a reason, the collision verdict), writes nothing, and
   exits as the real run would. Human and JSON reports stay within 16 KiB of
   UTF-8, replace filename controls with `_`, and bound each displayed path to
   256 characters. JSON retains complete items and counts omissions in
   `truncated` (including omissions for the byte budget). Display names are
   diagnostics, not authoritative filesystem paths; output truncation never
   changes the validated plan or its writes. `--format json` prints one versioned verdict
   (`version`, `tool`, `mode`, `ok`, `code`, `next_action`, `destinations`,
   `sources`, plus the dry-run `plan` when previewing). Any other flag, a
   missing or extra positional, or a missing directory exits 2 before the
   artifact is read or a baseline written. Refusals exit 1. Output names files
   by baseline filename or artifact-relative path, never an absolute path or
   file bytes. Stable `code` values: `OK`, `UNKNOWN_FLAG`, `MISSING_ARG`,
   `EXTRA_ARGS`, `ARTIFACT_NOT_FOUND`, `NO_CANDIDATES`, `NO_CHANGES` (Hono
   only), `COLLISION`, `STALE_COPY_CONFLICT`, `IO_ERROR`, `SOURCE_SYMLINK`,
   `DESTINATION_SYMLINK`, `ARTIFACT_LIMIT`; each comes with a `next_action`.
4. Commit the updated baselines in the same PR and say why in the PR body.
   Reviewers treat a baseline change like code: an unexplained one is a finding.

Raising the threshold or masking more of a page needs its own PR with a
justification, never a drive-by edit.
