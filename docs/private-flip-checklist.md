# Repository visibility flip checklist

Run this list before changing this repository's visibility (public to private
or back). Verify runner rules in both visibilities and check the state of any
private runner fleet separately.

## Runner separation (verify, already in code)

- Direct jobs use `ubuntu-latest` or pinned `ubuntu-24.04` unless the runner
  contract explicitly assigns a job to an opt-in. See the
  [browser-smoke routing rules](critical-journeys.md#ci-isolation) before
  changing merge-queue settings. The GitHub fallback covers fork pull requests.
- `ci.yml` can select `boat` for `kit-browser-calendar` when `CI_HEAVY_RUNNER`
  is `boat`, the pull request head belongs to this repository, and both the
  original and triggering actors match the Boat allowlist. Fork pull requests,
  all other events, and missing or disabled capacity use `ubuntu-latest`.
- The platform capacity switch updates `CI_HEAVY_RUNNER` for newly queued
  runs. If Boat pauses a job after GitHub has assigned its label, wait for the
  switch to show `ubuntu-latest` before requeuing CI. Contact the CI platform
  maintainer if the switch stays on `boat` after included capacity runs out.
- `test/workflow-runners.test.ts` checks the current runner contracts and
  checks reusable workflow calls at their pinned revisions or through their
  runner inputs. Run it on current `main` before flipping:
  `npx vitest run test/workflow-runners.test.ts`.
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
- Verify the organization's opt-in variables still apply as intended and
  budget for GitHub-hosted jobs. Private repositories draw on the included
  minutes allowance instead of the free public allowance.

## After the flip

- Confirm runners match the rules above on a pull request. If a safe
  non-mutating manual workflow is authorized, dispatch it from a reviewed ref
  and confirm its runner.
- Confirm the required checks still report under their existing names before
  merging anything.
