# AGENTS.md

Guidance for human and AI contributors.

## What this repo is

`two-web-next` is the Together We Own website: Hono on Cloudflare Workers, TypeScript, Drizzle + Postgres, server-rendered HTML with plain JavaScript islands. It handles Discord sign-in, member profiles, event data, and moderator admin tools. A mistake here can lock members out, leak member data, or break a production deploy.

## Read first

1. [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request contract and the release flow.
2. [README.md](README.md) for the stack, local setup, and the safe-test rules.
3. [.github/pull_request_template.md](.github/pull_request_template.md) for the PR body you must fill in.

## The contract

- Work on a branch and open a draft PR while work is incomplete. Mark it ready only when complete. Never push to `main`.
- Name branches `type/short-slug`, for example `fix/sudo-window`.
- The workspace may hand you a local branch named after a tracker card; keep committing to it, never publish that name, push `git push origin HEAD:refs/heads/<type>/<short-slug>` and open the PR from that ref.
- Squash-merge only. One PR is one logical change.
- Title the PR with a Conventional Commits header: `type(scope): summary`, at most 100 characters, no trailing period. Release automation reads it.
- Use the PR template, in short, active sentences. Fill in Linked Issues, Verification and Attestation; the rest is optional.
- PRs follow the org contract in `TogetherWeOwn/.github` CONTRIBUTING + this repo's overrides; use this repo's PR template, which replaces the org template; its Attestation section is mandatory.
- Keep references public-safe. No internal card IDs (`TOG-`, `PAP-`), private URLs, tokens, or secrets in any title, body, commit, comment, or branch name. Link public GitHub issues with `Closes #123`.
- Report the tests you ran. Never claim a green run you did not see.
- Address every review finding, or reply with why it does not apply.
- Credit the contributors whose work you build on.
- Never commit `.dev.vars`, secrets, or `node_modules/`. Use variable names in docs, never values.
- Read [CONSTRAINTS.md](CONSTRAINTS.md) before writing code. Do not weaken it to make a change pass.
- Done means merged. Do not leave an orphan PR open: merge it, or close it with a note naming its replacement.

## Commands

Use Node 22.23.0+ on the 22.x line, or 24+ (CI uses Node 24).

The commands below are a tooling reference, not permission for agents to run local CI. For AI contributors, full suites and CI gates run only on GitHub Actions for the exact PR head. Push to the PR branch and keep the PR draft while incomplete. Record exact-head Actions run/job links and conclusions; local output never replaces that evidence. Neither a delegated builder nor its caller may run a local full suite or CI mirror, including in Boat or a fallback.

Agent local test execution is limited to an authorized focused reproduction of one failing test or crate, never a suite split into multiple commands. Any heavy build for that reproduction must use the guarded `boat` PATH wrapper with approved source-only export, sizing/budget controls, `--no-env`, and verified cleanup; never bypass it or fall back to a heavy raw-host run. If that path is unavailable, defer to Actions or route the actual prerequisite. Report any focused reproduction separately as diagnostic evidence.

```sh
npm ci --include=dev
cp .dev.vars.example .dev.vars   # local settings only; never commit
npm run dev                      # wrangler dev
npm run format                   # formatting only
npm run build:assets             # regenerate minified public/ from assets/ after editing a source
```

Full test suites and CI gates run only on **GitHub Actions**. Push the PR branch; use a draft PR while work is incomplete, then mark it ready when complete. The real CI entrypoint is [`.github/workflows/ci.yml`](.github/workflows/ci.yml), with `check` feeding required `ci-ok`. Do not run `npm run check`, unfiltered `npm test`, coverage, `bin/local-ci.sh` or `npm run ci:local` as local full-suite/CI mirrors. Docker, a DB-free lane and Boat are not exceptions. Local execution is limited to focused reproduction of one failing test (for example `npx vitest run test/events.test.ts -t '<exact failing test name>'`), not a directory or all affected files. Docs changes use focused static/diff checks only.

Heavy builds for an allowed focused reproduction must use the guarded `boat` PATH wrapper with its sizing/budget/security controls, `--no-env`, a gitleaks-clean source-only export preserving input identity, and verified cleanup. Never bypass it. Boat fallback does not authorize a forbidden full suite/CI mirror or heavy raw-host run; defer to Actions or route the actual prerequisite when the focused/local limit cannot be met.

Run focused reproductions only against the disposable test database or local fixtures described in the README, with `DATABASE_URL` set to that URL when needed. Apply migrations with `npm run db:migrate` and validate history with `npm run db:check`. Never point tests, probes, or test migrations at a production or staging database. If a credential fails, stop and report it. Do not try another one.

Human contributors can reproduce CI's Vitest gates with disposable Postgres 17 containers using `bin/local-ci.sh`. This local tooling does not authorize agent full-suite or CI-mirror execution. For the agent Actions workflow and the separate human local workflow, see [Verify a change with GitHub Actions](CONTRIBUTING.md#verify-a-change-with-github-actions) in [CONTRIBUTING.md](CONTRIBUTING.md).

See [Verify a change with GitHub Actions](CONTRIBUTING.md#verify-a-change-with-github-actions). Cite Actions run/job URLs for the exact PR head SHA, conclusions and scope skips in Verification; local transcripts are not CI evidence for reviewers or the Release Manager. A green draft or docs-only fast-pass does not mean a skipped suite executed. Keep all required checks, review and exact-head production approval gates.

## UI changes

A user-visible change to a page, component, CSS, typography, navigation, form, or responsive layout follows this loop. AI contributors apply `frontend-ui-engineering`, then `product-ui-design-loop`, and add `frontend-design` for a new visual direction, whenever those skills are available to them.

1. Write a short design contract before substantial work: audience, screen job, primary action, real content, two or three references (or stated assumptions), layout, typography, tokens, responsive behavior, required states, non-goals.
2. Build in the stack the route already uses: server-rendered HTML for the current site, Svelte 5 and SvelteKit under `web/`. Do not add a framework because a generator returned one.
3. Render the real app against local fixtures. Capture desktop (1280×800) and mobile (390×844) screenshots, plus each required state, and open every image. A DOM or accessibility snapshot is not a visual review.
4. Run the existing gates on GitHub Actions by pushing the PR branch, not locally: `npm run a11y`, `npm run lighthouse`, `npm run lighthouse:quality`, and the visual specs in [docs/visual-regression.md](docs/visual-regression.md). `npm run a11y` and the Lighthouse gates cover the Hono site only and do not exercise Kit routes. For a `web/` change, also cite the Kit visual and parity artifacts described in [docs/visual-regression.md](docs/visual-regression.md) (`browser-smoke` Kit visual and Kit parity steps), plus the opened desktop and mobile fixture screenshots from step 3, and state in the PR body which gates exercised Kit and which did not. Fixture screenshots show rendering only. The visual specs compare reliably only in CI (`browser-smoke` on the pinned runner); accept an intentional diff only through the failure artifact and the suite-specific script: `node ci/visual-accept.mjs` for Hono or `node ci/kit-visual-accept.mjs` for Kit. Meet each threshold by improving the UI. Loosening any threshold (lowering a score floor, raising a time or pixel budget, adding `skipAudits`), masking more of a page, or regenerating baselines wholesale needs its own PR with a justification.
5. Put the evidence in the PR body: the contract, reference links, before/after screenshots at both widths, the commands you ran, and each intentional baseline change. Report only what you opened or ran.

## Definition of done

- Behavior matches the request.
- Applicable GitHub Actions gates are green on the exact head SHA, with run/job URLs and honest scope skips recorded. Report any focused local reproduction separately; do not run a local full suite or CI mirror. Human local verification follows [CONTRIBUTING.md](CONTRIBUTING.md).
- A UI change carries the evidence listed under UI changes.
- Every required check is green on the exact head SHA that merges: `ci-ok`, `gitleaks`, `e2e-ok`, `pr-lint`, `CodeRabbit` and `Devin Review`. No approving review is required.
- Every review finding is fixed, or answered with evidence.
- When native review stages apply, the final-stage reviewer squash-merges the exact reviewed head before closing the task; otherwise the author merges. Pin the merge to that SHA. A merge to `main` here deploys production, so it requires a fresh per-PR exact-head Release Manager `request_confirmation` on a child card assigned and addressed to the Release Manager; every other production deploy also needs Release Manager confirmation. Any push requires a new exact-head confirmation. Follow [CONTRIBUTING.md](CONTRIBUTING.md#merge-and-production-staging-evidence) for the automatic post-merge, pre-production staging/e2e/soak gate, retained safeguards and release-log recording; neither pre-merge staging nor artifact equality is a merge prerequisite.
- The PR is squash-merged, and the docs it made stale are updated.
