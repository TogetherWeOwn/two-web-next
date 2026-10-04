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
- Squash-merge only. One PR is one logical change.
- Title the PR with a Conventional Commits header: `type(scope): summary`, at most 100 characters, no trailing period. Release automation reads it.
- Fill in every section of the PR template, in short, active sentences.
- Keep references public-safe. No internal card IDs (`TOG-`, `PAP-`), private URLs, tokens, or secrets in any title, body, commit, comment, or branch name. Link public GitHub issues with `Closes #123`.
- Disclose the model you used and the tests you ran. Never claim a green run you did not see.
- Address every review finding, or reply with why it does not apply.
- Credit the contributors whose work you build on.
- Never commit `.dev.vars`, secrets, or `node_modules/`. Use variable names in docs, never values.
- Done means merged. Do not leave an orphan PR open: merge it, or close it with a note naming its replacement.

## Commands

Use Node 22.18.0+ on the 22.x line, or 24+ (CI uses Node 24).

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

## Definition of done

- Behavior matches the request.
- Tests pass locally, and `npm run check` is green.
- CI is green on the exact head SHA that merges: `check`, `gitleaks`, and `pr-lint` are required.
- A reviewer who did not write the code approved that head SHA.
- The PR is squash-merged, and the docs it made stale are updated.
