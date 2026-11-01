# AGENTS.md

Guidance for human and AI contributors.

## What this repo is

`two-web-next` is the Together We Own website: Hono on Cloudflare Workers, TypeScript, Drizzle + Postgres, server-rendered HTML with plain JavaScript islands. It handles Discord sign-in, member profiles, event data, and moderator admin tools. A mistake here can lock members out, leak member data, or break a production deploy.

## Read first

1. [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request contract and the release flow.
2. [README.md](README.md) for the stack, local setup, and the safe-test rules.
3. [.github/pull_request_template.md](.github/pull_request_template.md) for the PR body you must fill in.

## The contract

- Work on a branch and open a PR. Never push to `main`.
- Name branches `type/short-slug`, for example `fix/sudo-window`.
- The workspace may hand you a local branch named after a tracker card; keep committing to it, never publish that name, push `git push origin HEAD:refs/heads/<type>/<short-slug>` and open the PR from that ref.
- Squash-merge only. One PR is one logical change.
- Title the PR with a Conventional Commits header: `type(scope): summary`, at most 100 characters, no trailing period. Release automation reads it.
- Use the PR template, in short, active sentences. Linked Issues and Verification are required; the rest is optional.
- Keep references public-safe. No internal card IDs (`TOG-`, `PAP-`), private URLs, tokens, or secrets in any title, body, commit, comment, or branch name. Link public GitHub issues with `Closes #123`.
- Report the tests you ran. Never claim a green run you did not see.
- Address every review finding, or reply with why it does not apply.
- Credit the contributors whose work you build on.
- Never commit `.dev.vars`, secrets, or `node_modules/`. Use variable names in docs, never values.
- Read [CONSTRAINTS.md](CONSTRAINTS.md) before writing code. Do not weaken it to make a change pass.
- Done means merged. Do not leave an orphan PR open: merge it, or close it with a note naming its replacement.

## Commands

Use Node 22.23.0+ on the 22.x line, or 24+ (CI uses Node 24).

```sh
npm ci --include=dev
cp .dev.vars.example .dev.vars   # local settings only; never commit
npm run dev                      # wrangler dev
npm run format                   # formatting only
npm run lint                     # read-only Biome gate
npm run typecheck                # tsc for src and ci
npm test                         # Vitest
npm run build:assets             # regenerate minified public/ from assets/ after editing a source
npm run check                    # lint + types + config drift + tests + smoke
npx wrangler deploy --dry-run --outdir dist   # bundle check, no deploy
```

Run tests only against the disposable test database or local fixtures described in the README, with `DATABASE_URL` set to that URL. Apply migrations with `npm run db:migrate` and validate history with `npm run db:check`. Never point tests, probes, or migrations at a production or staging database. If a credential fails, stop and report it. Do not try another one.

To reproduce CI's Vitest gates with disposable Postgres 17 containers, run `bin/local-ci.sh -- <test files>` for the affected files, then `bin/local-ci.sh -j 8` for the full gate. See "Verify a change before opening a PR" in [CONTRIBUTING.md](CONTRIBUTING.md).

## UI changes

A user-visible change to a page, component, CSS, typography, navigation, form, or responsive layout follows this loop. AI contributors apply `frontend-ui-engineering`, then `product-ui-design-loop`, and add `frontend-design` for a new visual direction, whenever those skills are available to them.

1. Write a short design contract before substantial work: audience, screen job, primary action, real content, two or three references (or stated assumptions), layout, typography, tokens, responsive behavior, required states, non-goals.
2. Build in the stack the route already uses: server-rendered HTML for the current site, Svelte 5 and SvelteKit under `web/`. Do not add a framework because a generator returned one.
3. Render the real app against local fixtures. Capture desktop (1280×800) and mobile (390×844) screenshots, plus each required state, and open every image. A DOM or accessibility snapshot is not a visual review.
4. Run the existing gates: `npm run a11y`, `npm run lighthouse`, `npm run lighthouse:quality`, and the visual specs in [docs/visual-regression.md](docs/visual-regression.md). These gates cover the Hono site only: for a `web/` change, the screenshots from step 3 are the visual evidence, and the PR body says the Hono gates did not exercise the Kit route. The visual specs compare reliably only in CI (`browser-smoke` on the pinned runner); accept an intentional diff only through the failure artifact and `node ci/visual-accept.mjs`. Meet each threshold by improving the UI. Loosening any threshold (lowering a score floor, raising a time or pixel budget, adding `skipAudits`), masking more of a page, or regenerating baselines wholesale needs its own PR with a justification.
5. Put the evidence in the PR body: the contract, reference links, before/after screenshots at both widths, the commands you ran, and each intentional baseline change. Report only what you opened or ran.

## Definition of done

- Behavior matches the request.
- Tests pass locally, and `npm run check` is green.
- A UI change carries the evidence listed under UI changes.
- Every required check is green on the exact head SHA that merges: `ci-ok`, `gitleaks`, `e2e-ok`, `pr-lint`, `CodeRabbit` and `Devin Review`. No approving review is required.
- Every review finding is fixed, or answered with evidence.
- The agent that did the work merges it. Owner governance (2026-10-31): gate-green PRs merge without owner approval, and only production deploys need the owner, through `request_confirmation` on the card. A merge to `main` here deploys production, so it waits for that approval; so does every other production deploy.
- The PR is squash-merged, and the docs it made stale are updated.
