# Repository visibility flip checklist

Run this list before changing this repository's visibility (public to private
or back). Several workflows route jobs between GitHub-hosted runners and the
org's self-hosted fleet based on `github.event.repository.private`, so a flip
changes where jobs run with no code change. Nothing here requires a workflow
edit at flip time; it is a verification pass, done by whoever flips the
setting, before they flip it.

## Runner separation (verify, already in code)

- Pull-request and merge-queue runs always use GitHub-hosted runners, in both
  visibilities. Code that has not landed on `main` never runs on the
  self-hosted fleet, which also serves the deploy, backup and migration
  workflows.
- Only `main` pushes, schedules and manual dispatches may use the self-hosted
  fleet, and only while the repository is private.
- `test/workflow-runners.test.ts` pins both rules for every workflow,
  including reusable workflows (local or org-level) called from a
  pull-request workflow: callers pass an explicit GitHub-hosted runner input
  instead of accepting a visibility-based default. Run
  it and confirm it passes on the current `main` before flipping:
  `npx vitest run test/workflow-runners.test.ts`.
- The `CI_OVERFLOW_*` repo variables cannot reroute pull-request or
  merge-queue runs: the hosted guard for those events is evaluated before the
  overflow switch. No variable change is needed at flip time, but confirm the
  overflow runner value still names an approved runner for the non-PR events
  it may serve.

## Self-hosted fleet (confirm with the runner operator)

- Confirm whether the self-hosted runners are ephemeral (one job per runner
  registration, discarded afterwards) or persistent, and record the answer
  and date in the ops notes. Do not widen the set of events allowed on the
  fleet until this is answered.
- Confirm the runner group's repository access matches the new visibility:
  the group must include this repository once private, and must not serve
  public repositories if the repository is flipped back.

## Actions settings

- Confirm the fork pull-request approval policy for Actions runs (first-time
  and outside contributors) still matches intent for the new visibility.
- Budget for GitHub-hosted minutes: pull-request and merge-queue CI stays on
  GitHub-hosted runners by design, and private repositories draw on the
  included minutes allowance instead of the free public allowance.

## After the flip

- Open or re-run a pull request and confirm its jobs land on GitHub-hosted
  runners; run one manual dispatch of a non-PR workflow and confirm it lands
  where intended for the new visibility.
- Confirm the required checks still report under their existing names before
  merging anything.
