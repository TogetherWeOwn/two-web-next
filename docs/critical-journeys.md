# Critical browser journeys

The browser smoke suite runs **only in GitHub Actions on `ubuntu-latest`**.
Never install/run Playwright browsers on the controller. `npm run check` only
checks the specs' types, safety guards and existing Vitest tests; it does not
launch a browser. The Playwright config, fixture preparation and seeding refuse
non-GitHub-hosted Linux execution.

| Journey | Spec | Evidence required |
| --- | --- | --- |
| Homepage → join CTA → Discord OAuth → member profile | `e2e/join.spec.ts` | Real CTA navigation; intercepted authorize redirect; Worker token/user/guild-add stubs called; signed-in profile renders |
| QA sign-in → keyboard profile edit | `e2e/profile.spec.ts` | Genuine QA session cookie; tab order and Enter submit; PATCH 200; saved status focused; values survive reload |
| Events list → event page → RSVP going → withdraw | `e2e/events.spec.ts` | Real going/withdraw controls; PUT 201 and DELETE 204; both states persist after reload |
| Moderator → create draft → publish | `e2e/admin.spec.ts` | Real form/redirect; draft hidden from guest (403); publish status; guest view 200 and public calendar navigation |

RSVP selectors are the frozen `rsvp-going`, `rsvp-confirmed`, `rsvp-withdraw`
contracts in `src/islands/contracts.ts`. The suite deliberately does **not**
skip an unimplemented UI or replace button clicks with direct API mutations.
At introduction, the prerequisite is the W10 RSVP binder/SSR mount tracked by
[TOG-9839](/TOG/issues/TOG-9839); a red RSVP spec is NEEDS WORK, not acceptance.

## CI isolation

`.github/workflows/e2e.yml` runs on pull requests, main pushes and manual dispatch.
It has read-only repository permissions, no deployment environment, and no
Cloudflare, Discord, staging or production secrets. A new Postgres 17 service
container is migrated and seeded for each job: `agent_test`, `127.0.0.1:5432`,
database `two_web_next`, no password. `e2e/ci-only.mjs` rejects any other target
before migrations/fixtures. Seeding never truncates/drops a shared database.

`wrangler dev --local` uses **`e2e/wrangler.jsonc`**, not the deployment config.
There are no remote bindings, Hyperdrive IDs, queues, cron triggers or routes.
The test-only Worker entrypoint preserves production routes, DB stores, crypto,
validation and rendering. It translates only the local HTTPS transport and
its same-origin Origin header to the virtual staging APP_URL required by the
existing QA seam. It never sends requests to that host. Foreign Origin headers
are left unchanged. This adapter tests the real application gates; it is not a
staging routing/TLS acceptance test.

QA and session signing material is generated afresh on the runner and placed
in ignored `e2e/.dev.vars`, then removed in the final cleanup step. Browser
contexts use real Secure/HttpOnly `__Host-` cookies over local HTTPS. No session
storage state or production identities are imported. Profiles respect the
real 1000 ms anti-spam floor before submitting.

The Worker substitutes exact Discord API responses and throws on every
unrecognized outbound fetch; it never forwards upstream. Calendar Discord
transients use the existing injectable empty source. Browser routing blocks
all non-local requests (including `discord.com`, CDN/invite and staging hosts).
Because Playwright does not re-intercept server redirect hops, Chromium also
uses a dead loopback proxy with only loopback destinations bypassed. The
`e2e/isolation.spec.ts` redirect canary must fail at that proxy, without a
Discord connection. Only the join spec fetches the **local** OAuth entry with
`maxRedirects: 0`, validates its authorize URL and fulfills a local callback
redirect with the real state cookies. No Discord authorize URL is fetched.
All direct API helpers disable redirects. Teardown asserts no unexpected
browser/Worker outbound attempts. Publishing proves local state, not Discord
synchronization.

## Running and inspecting evidence

- Locally/controller: `env -u DATABASE_URL npm run check` (no live SQL/browser).
- On the GitHub-hosted runner: `npm run e2e` after prepare, migrations, seed and
  `npx playwright install --with-deps chromium`.
- Chromium only, one worker, fresh browser context per spec, zero retries.
- On failure, the job uploads `test-results/` traces/screenshots and the HTML
  `playwright-report/` under `e2e-failure-<run>-<attempt>` for seven days.
  Do not upload `.dev.vars`; traces can contain only disposable CI sessions.
- Require a green `browser-smoke` result on the exact PR head, together with
  `check`, `gitleaks`, `pr-lint`, and independent Code Reviewer approval before
  squash merge. A green static check does not prove the browser journeys.

Scope excludes visual regression, real Discord writes and any tests against
production or staging databases. Source parity context: `docs/parity.md` and
legacy `ci/critical-journeys.json`/`tests/Browser/*` (legacy is frozen).
