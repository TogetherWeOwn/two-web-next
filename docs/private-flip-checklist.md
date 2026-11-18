# Repository visibility flip checklist

Run this list before changing this repository's visibility (public to private
or back). The checked-in workflow jobs use GitHub-hosted runners in either
visibility. This is a verification pass for whoever changes the setting, not
proof of the state of any private runner fleet.

## Runner separation (verify, already in code)

- Every direct job uses a literal `ubuntu-latest` label, except jobs pinned to
  `ubuntu-24.04` for visual evidence, recovery, or XFS. The contract rejects
  runner groups, self-hosted and larger runners, and selectors that depend on
  visibility, events, or variables.
- Checked-in jobs select GitHub-hosted runners for all events and both
  visibilities; reusable workflow calls are checked separately at their pinned
  revisions or through their runner inputs. `test/workflow-runners.test.ts`
  checks the current source contracts; run it on current `main` before flipping:
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
- Budget for GitHub-hosted minutes: pull-request and merge-queue CI stays on
  GitHub-hosted runners by design, and private repositories draw on the
  included minutes allowance instead of the free public allowance.

## After the flip

- Open or re-run a pull request and confirm its jobs land on GitHub-hosted
  runners; if a safe non-mutating manual workflow is authorized, dispatch it
  from a reviewed ref and confirm its runner.
- Confirm the required checks still report under their existing names before
  merging anything.
