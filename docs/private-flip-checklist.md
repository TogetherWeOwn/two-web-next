# Repository visibility flip checklist

Run this list before changing this repository's visibility (public to private
or back). Verify the runner rules below in either visibility and confirm the
state of any private runner fleet separately.

## Runner separation (verify, already in code)

- Direct jobs use `ubuntu-latest` or a pinned `ubuntu-24.04`, with one exception.
  `ci.yml` can select `boat` for `kit-browser-calendar` when `CI_HEAVY_RUNNER`
  is `boat`, the pull request head belongs to this repository, and both the
  original and triggering actors match the Boat allowlist. Fork pull requests,
  all other events, and missing or disabled capacity use `ubuntu-latest`.
- `test/workflow-runners.test.ts` pins the allowed direct job labels and the
  exact calendar selector. It checks reusable workflow calls at their pinned
  revisions or through their runner inputs. Run
  `npx vitest run test/workflow-runners.test.ts` on current `main` before flipping.
- A manual branch dispatch can load workflow YAML from that branch. Source tests
  on `main` do not enforce historical or modified branch definitions, repository
  settings, or the runtime behavior of external reusable workflows. Review the
  actual ref and its callees before dispatching.

## Self-hosted fleet (confirm with the runner operator)

- Confirm whether the self-hosted runners are ephemeral (one job per runner
  registration, discarded afterwards) or persistent, and record the answer
  and date in the ops notes. Do not widen the set of events allowed on the
  fleet until this is answered.
- Do not grant this repository access to the self-hosted runner group merely
  because it becomes private. Any separate fleet use requires explicit
  authorization; review access again if the repository becomes public.

## Actions settings

- Confirm the fork pull-request approval policy for Actions runs (first-time
  and outside contributors) still matches intent for the new visibility.
- Budget for GitHub-hosted minutes. Merge-queue CI and fork PR CI use GitHub.
  Eligible same-repository PRs can run the calendar job on Boat. Private
  repositories draw on the included GitHub minutes allowance.

## After the flip

- Open or re-run a pull request and confirm its runners match the rules above.
  If a safe non-mutating manual workflow is authorized, dispatch it from a
  reviewed ref and confirm its runner.
- Confirm the required checks still report under their existing names before
  merging anything.
