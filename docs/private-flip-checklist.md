# Repository visibility flip checklist

Run this list before changing this repository's visibility (public to private
or back). Every workflow job names an explicit standard GitHub-hosted Linux
runner (`ubuntu-latest`; `e2e.yml` `browser-smoke` stays pinned to
`ubuntu-24.04`). No job selects on `github.event.repository.private`, and no
job uses a self-hosted, larger or third-party runner, so a flip changes where
jobs run only through billing. Nothing here requires a workflow edit at flip
time; it is a verification pass, done by whoever flips the setting, before
they flip it.

## Runner policy (verify, already in code)

- Every `runs-on` in `.github/workflows` is `ubuntu-latest`, except the
  `ubuntu-24.04` pin on `browser-smoke`, which keeps visual baselines stable
  (`docs/visual-regression.md`).
- Local reusable workflows name their own explicit hosted runners. Org-level
  reusable calls pass an explicit hosted runner input, or use a pinned ref
  independently verified to select only hosted runners.
- `test/workflow-runners.test.ts` pins these rules for every workflow. Run it
  and confirm it passes on the current `main` before flipping:
  `npx vitest run test/workflow-runners.test.ts`.
- If a self-hosted runner is ever wanted again, that is a policy change that
  needs its own PR, with a design for keeping pull-request code off it.

## Actions settings

- Confirm the fork pull-request approval policy for Actions runs (first-time
  and outside contributors) still matches intent for the new visibility.
- Budget for GitHub-hosted minutes: all CI stays on GitHub-hosted runners by
  design, and private repositories draw on the included minutes allowance
  instead of the free public allowance.

## After the flip

- Open or re-run a pull request and confirm its jobs land on GitHub-hosted
  runners.
- Confirm the required checks still report under their existing names before
  merging anything.
