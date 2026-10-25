<!--
Title: Conventional Commits header, e.g. `fix(auth): refuse expired sudo sessions`.
Types: feat fix perf refactor test docs build ci chore revert style security. Max 100 chars, no trailing period.
This repo is public. Do not put internal ticket ids, instance links, localhost or private-network
addresses in the title, the body, a commit message or the branch name. Name the branch after the change,
for example `fix/sudo-window`. Link only public GitHub issues (`Fixes #123`).
Write short, plain sentences. In the current warn mode `pr-lint` warns (does not fail) on a missing or
thin linked issue (feat/fix/perf/refactor/security) or Verification, and fails once `PR_STANDARDS_MODE`
is `"error"`; the title and an empty body always fail. The other sections are optional context
for the reviewer.
Full rules: CONTRIBUTING.md, "Pull request contract".
-->

## Linked Issues or Issue Description

<!--
  Warn-only for feat, fix, perf, refactor and security (fails once `PR_STANDARDS_MODE` is `"error"`). Pick ONE:
  (A) A public GitHub issue exists: `Fixes #123`, `Closes #123` or `Refs #123`.
  (B) No issue exists: describe the problem here in your own words (what happened, what you expected,
      how to reproduce it, or the motivation and proposed solution for a feature).
-->

-

## What Changed (optional)

<!-- One bullet per logical unit. The reviewer reads the diff; add only what the diff does not show. -->

## Verification

<!-- Commands you ran and their results, so a reviewer can repeat them. -->

-

### Product evidence

<!-- For each prompt: linked evidence, concrete justified N/A, or an explicit unverified gap and follow-up.
These are descriptive prompts, not a new CI gate. An unverified gap is not a pass.
See CONTRIBUTING.md, "Product evidence", for applicability and labelled examples. -->

- **Agent interface:** Consumer, discovery surface, stable identifiers/schema and
  repeatable read-only/fixture check; error remediation and safe retry/idempotency
  where applicable. See [machine interfaces](https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/machine-interface.md) and
  [machine errors](https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/machine-errors.md). Do not invent an agent write surface.
- **Async truth and recovery:** Observable states, uncertainty, stale/partial data,
  recovery, duplicate suppression, bounded retry and keyboard/status behavior where
  applicable. Queued is not complete; read back an unknown write before another
  submission. No invented progress or ETA. See [RSVP recovery](https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/rsvp-recovery.md).
- **Dogfood outcome and feedback:** Task, environment, revision, actor type, expected
  versus observed result, evidence and follow-up or justified no-change decision.
  Distinguish fixture/browser simulation, agent dogfood and actual human feedback;
  say if human feedback was not collected. See [staging exploration](https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/explore-staging.md).
  Keep member data, credentials and raw support transcripts out of public evidence.

## Notes for reviewers (optional)

<!-- Risks, follow-ups, or anything the reviewer should look at first. -->

- `npm run check` result, and confirmation that no secret, `.dev.vars` or `node_modules/` is in the diff.
