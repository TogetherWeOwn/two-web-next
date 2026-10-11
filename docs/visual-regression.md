# Visual regression

`e2e/visual/public-pages.visual.ts` takes full-page screenshots of the public
routes (home, events, the seeded event, past events, rules, privacy; `/community`
redirects to home) at desktop (1280×800) and mobile (390×844) widths and compares them
with the committed baselines in `e2e/visual/__screenshots__/`.

- **Where it runs:** the `browser-smoke` job in `.github/workflows/e2e.yml`, before
  the critical journeys, on the freshly seeded local stack (no secrets, no
  staging or production). `browser-smoke` is a required check, so a visual diff
  blocks the merge. Docs-only, test-only and draft PRs skip it (the job reports
  skipped, which passes).
- **Stability:** `<time>` elements are masked (server-rendered times follow the
  wall clock), animations are disabled, and the caret is hidden. A route must
  return 200.
- **Threshold:** `maxDiffPixelRatio: 0.01` per screenshot
  (`playwright.visual.config.ts`). CI never rewrites an existing baseline
  (`updateSnapshots: "missing"` only creates absent ones), and the job fails
  while any generated baseline is uncommitted.

## When a diff is intentional

1. Download the `e2e-failure-<run>` artifact from the failed run. It holds the
   expected, actual and diff images under `test-results-visual/`, any newly
   generated baselines under `e2e/visual/__screenshots__/`, and an HTML report
   under `playwright-report-visual/`.
2. Check every diff image. Only accept changes the PR meant to make.
3. Run `node ci/visual-accept.mjs <unzipped-artifact-dir>`, which copies each
   `*-actual.png` over its baseline and each new baseline into place.
4. Commit the updated baselines in the same PR and say why in the PR body.
   Reviewers treat a baseline change like code: an unexplained one is a finding.

Raising the threshold or masking more of a page needs its own PR with a
justification, never a drive-by edit.
