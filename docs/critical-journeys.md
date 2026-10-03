# Critical browser journeys

The browser smoke suite runs **only in GitHub Actions on Linux** (public
repo: standard GitHub-hosted `ubuntu-latest` runners only — never paid larger
runners or Blacksmith).
Never install/run Playwright browsers on the controller. `npm run check` only
checks the specs' types, safety guards and existing Vitest tests; it does not
launch a browser. The Playwright config, fixture preparation and seeding refuse
non-Actions execution.

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
- On the `ubuntu-latest` runner: `npm run e2e` after prepare, migrations,
  seed and `npx playwright install --with-deps chromium`.
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

## Staging post-deploy journeys

`.github/workflows/e2e-staging.yml` runs the deployed Worker end to end after
every successful staging deploy (and on manual dispatch) with the
`playwright.staging.config.ts` project against the staging origin. The runner
is the same `ubuntu-latest` Chromium setup as CI; the difference is the
target: real Hyperdrive and queues instead of `wrangler dev --local` and the
disposable Postgres service. The token travels as the `staging` Environment
secret `QA_AUTH_TOKEN` (secret name only here — never a value), masked in logs,
sent only as the `X-TWO-QA-Auth` header next to an explicit staging `Origin`,
and never printed or placed in a URL.

Coverage reuses the CI journey logic with staging-safe setup:

| Journey | Spec | Evidence required |
| --- | --- | --- |
| QA sign-in, member and moderator | `e2e/staging/auth.spec.ts` | Saved storage states open `/profile` (`QA Member`) and `/admin/events` (`Events`); bad token and unknown identity answer 404 |
| Events list, search miss, calendar month step | `e2e/staging/events-list.spec.ts` | `events-content` plus list or never-empty; unique miss string shows the miss block and clears; month label steps forward and back |
| Fixture event, RSVP going, withdraw, cancel | `e2e/staging/event-rsvp.spec.ts` | Moderator draft → publish; member PUT 201, `You're in`, reload persists; DELETE 204, going returns; fixture cancelled in `finally` |
| QA member keyboard profile edit | `e2e/staging/profile.spec.ts` | Same 1000 ms floor and Tab flow as CI; PATCH 200; `Profile saved.` focused; unique bio and games survive reload |
| Moderator draft create and cancel | `e2e/staging/admin.spec.ts` | `Create draft` → `Status: draft`; guest draft 403; `Cancel event` → `Status: cancelled`; guest cancelled 410. Never publishes |

The list spec also runs as `mobile-375` (375×812 viewport) and
`reduced-motion` (`reducedMotion: reduce`) projects. Cleanup is structural:
RSVPs are withdrawn in-spec and every fixture the suite creates is cancelled
in a `finally`, so a failed run leaves no draft behind. On failure the job
uploads `test-results/` traces/screenshots and the HTML report for seven days.

Blast-radius note: publishing the RSVP fixture and answering RSVPs enqueue
sync-event carriers (`src/events/sync.ts` enqueues published/cancelled
statuses; RSVP writes enqueue per `src/events/rsvp.ts`), but the staging
Worker has no queue consumer pointed at the live guild — carriers expire or
fail closed without a Discord write. The admin journey never publishes, so it
enqueues nothing at all.
