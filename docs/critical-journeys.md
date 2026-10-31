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
| Events list → event page → RSVP going → withdraw | `e2e/events.spec.ts` | Real controls; fresh PUT 201 with `status: going` and `synced_to_discord_at: null`; before reload, exact `Saved. Syncing to Discord.` note visible and no synced note; DELETE 204 removes both sync notes; confirmation and withdrawal persist after reload. This proves immediate pending sync, not successful Discord delivery |
| Capacity-1 waitlist join → leave, and promotion on seat-holder withdraw | `e2e/event-waitlist.spec.ts` | Capacity-1 fixtures: moderator fills the seat, member waitlist-joins at `#1 in line`, leaves and the join control returns; second fixture: seat-holder withdraw promotes automatically (`You're in`, `1 of 1 going`, no claim click), persisting across reload; fixtures cancelled in `finally` through the request API |
| Moderator → create draft → publish → filter admin list → cancel | `e2e/admin-filters.spec.ts` | Real form/redirect; draft hidden from guest (403); publish status; guest view 200 and public calendar navigation; Status draft/published and RSVPs Open/Paused filters each show only matching rows; JSON cancel renders the guest 410 notice, refused RSVP write and STATUS:CANCELLED feed |
| Pause → refused RSVP with the paused reason → reopen → RSVP restored | `e2e/event-pause.spec.ts` | Moderator pauses through the admin form; member sees the paused notice with no going control; a request-API PUT is refused 403 `event_not_open` with `why: paused` and the seat count is unchanged; both transitions persist across reload; reopen restores the going control and a browser-click PUT answers 201 (`You're in`, `1 of 10 going`), persisting across reload; the fixture is cancelled in `finally` through the request API |
| Blocked join → recovery copy + fallback invite | `e2e/join-blocked.spec.ts` | Bot-refused guild add renders the blocked copy with retry and invite CTA, 200, no session; distinct from denied/outage/expired copy |
| Calendar month view shows the chosen month, hides the other | `e2e/calendar-month.spec.ts` | Zero QA logins by design; seeded `E2E Calendar May` / `E2E Calendar June` rows in the disposable CI database; guest drives `/events?view=calendar&month=2099-05` then `2099-06`, asserting the month label, `data-month` and grid contents each way; no fixtures, nothing to cancel |
| Past archive renders the seeded row; out-of-range pages refuse | `e2e/past.spec.ts` | Seeded `E2E Past Night` row (page size 20, exactly one page); guest navigations only: page 1 renders the list with that row, pages 2 and 9999 render the out-of-range refusal; no fixtures, writes or session |
| Sign out answers 303 to `/` as guest; the old session cannot replay | `e2e/logout.spec.ts` | Stubbed OAuth join (no QA login); header Sign out form POSTs `/logout`, landing on guest `/` with the `__Host-` session cookie cleared; the captured pre-logout cookie replays to guest home and `/profile` bounces 302 to OAuth; no fixtures |
| Public feeds and SEO answer unauthenticated GETs | `e2e/feeds.spec.ts` | GET-only, no session or fixtures; sitemap/robots/RSS/ICS answer 200 with contract content-types (`max-age=300, public`, no `set-cookie` on feeds); pins the seeded `01J00000000000000000000001` event GUID and ICS UID envelopes so an empty collection cannot pass silently |
| Live search filters the rendered list; a miss swaps the empty block; clearing restores | `e2e/events-live-search.spec.ts` | Seeded `E2E Community Night` on local `/events`, no QA token; typing debounces into a settled `?q=` read that filters the DOM list, the `zzz-no-such-event` miss swaps in `events-empty-search`, clearing restores the list and the empty URL; asserts no console errors/warnings or page errors; no fixtures |
| Clipboard-denied copy falls back to the selectable canonical URL | `e2e/event-copy-link.spec.ts` | Seeded `01J00000000000000000000001` event page, no QA token; Clipboard API denied, the binder attempts one `writeText` with the page canonical then falls back through `execCommand("copy")` carrying the same canonical `/e/:key` URL with the `Event link copied.` toast; asserts no console noise or page errors; no fixtures |

RSVP selectors are the frozen `rsvp-going`, `rsvp-confirmed`, `rsvp-withdraw`
contracts in `src/islands/contracts.ts`. The suite deliberately does **not**
skip an unimplemented UI or replace button clicks with direct API mutations.
At introduction, the prerequisite is the W10 RSVP binder/SSR mount tracked by
[TOG-9839](/TOG/issues/TOG-9839); a red RSVP spec is NEEDS WORK, not acceptance.

Visual regression of the public pages runs in the same job, before these
journeys: see [visual-regression.md](visual-regression.md).

## Kit parity

After these journeys, the same job runs the Kit parity project
(`playwright.kit-parity.config.ts`, `e2e/kit-parity/parity.spec.ts`): the
no-login journeys above plus the authenticated member-board journey (guest
bounce, member views, grammar refusals; one shared QA login replayed to both
targets), parameterized to run against both the Hono worker
and the adapter-built Kit Worker on the same seeded database, with
origin-normalized body comparison, manifest-derived renderer expectations,
mobile/desktop viewports and a startup probe. The JSON report feeds
`ci/check-kit-parity.mjs`, which fails loud on all-skipped/empty like the
staging ledger. Status/header, semantic DOM, no-JS and preview-URL gates live
in `ci/kit-parity-gates.mjs`; worker and generated-asset budgets in
`ci/check-kit-perf.mjs`. Full policy: [kit-parity-gates.md](kit-parity-gates.md).

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

- Locally/controller: `env -u DATABASE_URL npm run check` runs fixture-only
  checks, not live SQL or browser journeys. Featured-unpublish SQL cases use
  the existing integration gate in `test/admin.test.ts`; six registration and
  rendering cases remain ungated in the two featured-unpublish suites. No new
  conditional skip is added. Full SQL verification still needs the disposable
  test database described in the README.
- On the `ubuntu-latest` runner: `npm run e2e` after prepare, migrations,
  seed and `npx playwright install --with-deps chromium`.
- Chromium only, one worker, fresh browser context per spec, zero retries.
- On failure, the job uploads `test-results/` traces/screenshots and the HTML
  `playwright-report/` under `e2e-failure-<run>-<attempt>` for seven days,
  except manual dispatches on `test/rsvp-pending-control-*` refs: intentional
  controls upload no raw failure directories. Browser checks and cleanup still
  run. Do not upload `.dev.vars` or publish control captures manually; even
  disposable CI sessions can appear in traces. This exception does not change
  staging's derived-ledger-only artifact policy.
- Require a green `e2e-ok` result on the exact PR head, together with
  `ci-ok`, `gitleaks`, `pr-lint`, and independent Code Reviewer approval before
  squash merge. A green static check does not prove the browser journeys.

Scope excludes visual regression, real Discord writes and any tests against
production or staging databases. Source parity context: `docs/parity.md` and
legacy `ci/critical-journeys.json`/`tests/Browser/*` (legacy is frozen).

## Staging post-deploy journeys

`.github/workflows/e2e-staging.yml` runs the deployed Worker end to end after
every successful staging deploy (and on manual dispatch) with the
`playwright.staging.config.ts` project against the staging origin. A
change-scope gate (mirrored from `e2e.yml`, diffing the deployed head commit
against its parent) skips the journeys when the deploy only touches prose
that no gate, test or build reads, or only the `test/` unit tree the journeys
never execute; manual dispatches always run. The same verdict also skips the
two post-deploy smoke steps inside `deploy.yml` itself (the full suite,
including those tests, already ran in that job). The runner
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
| Fixture event, RSVP going, withdraw, waitlist join + leave, waitlist promotion, cancel | `e2e/staging/event-rsvp.spec.ts` (local pre-merge pin: `e2e/event-waitlist.spec.ts`) | Moderator draft → publish; member PUT 201 with `status: going` and `synced_to_discord_at: null`, exact pending-sync note visible and synced note absent before reload; `You're in` persists after reload (a consumer may have synced by then); DELETE 204 removes both sync notes and going returns. Pending is not successful Discord delivery; capacity-1 fixture: moderator fills the seat, member waitlist-join asserts `#1 in line`, leave returns the join control; second capacity-1 fixture: moderator withdraws (204) and the member's reload shows `You're in` and `1 of 1 going` with `waitlist-position`, `waitlist-claim`, `waitlist-join` and `event-full` gone (promotion is automatic, no claim click), persisting across another reload; every fixture cancelled in `finally` through the request API (no cleanup page), with the global teardown sweep as backstop |
| QA member keyboard profile edit | `e2e/staging/profile.spec.ts` | Same 1000 ms floor and Tab flow as CI; PATCH 200; `Profile saved.` focused; unique bio and games survive reload |
| Moderator draft create and cancel | `e2e/staging/admin.spec.ts` | `Create draft` → `Status: draft`; guest draft 403; `Cancel event` → `Status: cancelled`; guest cancelled 410. Never publishes |
| Moderator featured slot create, homepage render, edit, delete | `e2e/featured.spec.ts` (local CI proves the same journey before merge against wrangler dev) + `e2e/staging/featured.spec.ts` (post-deploy proves it on staging with a bounded homepage poll) | `/admin/featured/new` form (published, UTC window, last position, no image) → `/admin/featured/<id>`; guest `/` shows a `featured-item` under `featured-content` ("From the community team") with the headline and body (bounded poll); edited headline replaces the old one; `delete-featured` → guest `/` drops it and `/admin/featured/<id>` answers 404; the fixture is deleted by id in `finally` through the request API, so a red run leaves no live card on the homepage |
| Join funnel CTA, entries, QA profile | `e2e/staging/join.spec.ts` | Guest: homepage `join` CTA href `/auth/discord`, `/join` one-click href `/join/discord`, both entries 302 to Discord authorize with no follow; QA member session opens `/profile` (`QA Member`) with the tested staging revision recorded as a report annotation |
| QA member sign-out, revoked replay | `e2e/staging/logout.spec.ts` | Sign out returns to guest `/`; session cookie cleared; old cookie replays to guest home and `/profile` bounces to OAuth |
| Public collection feeds and SEO | `e2e/staging/feeds.spec.ts` | Guest GETs only, no QA token, no fixtures: sitemap/robots/RSS/ICS collections 200 with contract content-types and exact cache headers, no `set-cookie`; empty feeds are valid |
| Published owned-event RSS and calendar download | `e2e/staging/event-rsvp.spec.ts` | During the existing RSVP fixture's published window, an isolated empty-storage request context finds that exact key's RSS GUID and downloads its ICS: 200, calendar content-type, private cache, attachment filename, no cookies, VCALENDAR envelope, matching UID and CONFIRMED status; logs record the staging revision, owned key, RSS item count and cancel response; the existing `finally` cancels the fixture even if a feed assertion fails |

The list spec also runs as `mobile-375` (375×812 viewport) and
`reduced-motion` (`reducedMotion: reduce`) projects. Cleanup is structural:
RSVPs are withdrawn in-spec and every fixture the suite creates is cancelled
(events) or deleted (featured slots) in a `finally`. A test timeout closes the
browser contexts before that `finally` runs. Staging event journeys therefore
have a staging-only backstop: `e2e/staging/global-teardown.ts` signs the QA
moderator in fresh and cancels every `Staging E2E` event still published or draft
(`e2e/fixture-sweep.mjs`), and fails the run if one stays live. The local
pins (`e2e/event-waitlist.spec.ts`, `e2e/event-pause.spec.ts`, `e2e/admin-filters.spec.ts`) have their own backstop,
`e2e/local-global-teardown.ts`, which only uses the disposable CI Postgres,
only matches their `E2E Waitlist `, `E2E Promotion `, `E2E Pause `, `E2E Moderator ` and `E2E Filter ` fixture titles, and is guarded
to run in GitHub Actions on Linux. It cancels orphaned fixtures with one SQL
UPDATE instead of signing in, so it spends none of the shared qa-login
throttle on any run. Neither sweep crosses into the other's
origin. Each list and final verification traverse matching pages even when a
page contains substring lookalikes. Pagination keeps the fixed origin and
filters, advances one page at a time, and fails closed past 20 pages per status.
The local sweep is one SQL UPDATE with no login, no passes, and no waits; a
database error fails the teardown loudly instead of claiming cleanup
succeeded. The staging sweep allows four passes and
at most four cancellation throttle waits within its five-minute sweep bound. An exhausted bound fails the run rather than claiming cleanup
succeeded.
On failure the job sweeps `test-results/` and `playwright-report/`, but uploads
only the derived journey ledger after the sweep completes; that artifact is
retained for seven days. The repo is public, so uploaded artifacts are
world-readable and log masking does not cover them. Playwright puts request headers (including `X-TWO-QA-Auth`) into a
transport-level request error, so token-bearing requests go through
`e2e/qa-request.mjs`, which rethrows a reason-only message, and the one browser
test that sends the real token records no trace. A failure-only step
(`ci/scrub-qa-token.py`) is the backstop: it deletes any artifact file that
still contains the token, looking inside every `*.zip` (traces hold request
headers in `trace.trace` and `trace.network`) and inside the zip that
`playwright-report/index.html` embeds as base64 (the report's copy of the error
text; a plain search of the HTML finds nothing). It then fails the job, and the
artifact upload runs only after a sweep that finished the whole tree. A token
found in an artifact is exposed: report it to the COO the same hour. Files the
sweep could not fully inspect are withheld from the upload too (removed, job
fails). A withheld-only run means the token was not seen in what could be
read, not that it is proven absent; only a real token hit prints the exposure
alarm and needs a COO report.

Blast-radius note: publishing the RSVP fixture and answering RSVPs enqueue
sync-event carriers (`src/events/sync.ts` enqueues published/cancelled
statuses; RSVP writes enqueue per `src/events/rsvp.ts`), but the staging
Worker has no queue consumer pointed at the live guild — carriers expire or
fail closed without a Discord write. The admin journey never publishes, so it
enqueues nothing at all, and the featured journey is a plain Postgres write
with no queue or Discord path.

Journey accounting: Playwright exits 0 when every journey skips, so an
all-skipped run looks green unless something counts outcomes. The staging
config also writes a JSON report (`test-results/staging-journeys.json`), and a
follow-up step (`node ci/check-staging-journeys.mjs`, logic in
`e2e/staging/journey-ledger.mjs`) ledgers every journey as passed, failed or
skipped with its reason, appends that table to the step summary, and uploads
the ledger as an artifact (on a green run, or after the token scrub finished
the whole tree; never the raw report). When nothing passed — all skipped, or no journeys
recorded at all — the gate fails loud (exit 2) with every skipped journey and
its reason named. Never add a quiet `test.skip` precondition for an empty
staging fixture without a reason string: the ledger surfaces that reason as
the failure evidence.

Ledger statuses map Playwright report statuses one to one. `expected`
becomes `passed` with no reason. A flaky row preserves the
first-attempt failure's bounded first-line reason, remains `flaky`, and does
not count toward `passed`; it counts as a failure in the headline, CLI line
and verdict. `counts.flaky` also records
the number of flaky rows. The Markdown summary calls out that retries and
report-config provenance must be checked. `unexpected` becomes `failed` with
the first-line failure message. Failure and skip diagnostics are bounded and
scrubbed for known credential forms, email/member identifiers, long numeric
IDs, URLs and the configured QA token before they enter the ledger. Redaction finds complete HTTP(S) URL and configured-token spans in the original
text and merges overlaps before inserting any redaction marker. A token, email or
numeric ID inside a URL cannot leave its path/query tail visible, and a configured
token crossing a URL boundary cannot retain a partial value. It covers the entire `__Host-` cookie family, including
signed OAuth/join/return-state cookies, not only session cookies. Redaction
handles quoted keys, including backslash-escaped keys from nested or stringified
JSON, and compound credential names (for example `client_secret`,
`db_password`, `secret_key`, `token_value`, private keys and session IDs), including
underscore, hyphen and camelCase affixes and common spaced labels (`API Key`,
`secret key`, `session id`). Member fields accept those spellings and spaces
(`display_name`, `userId`, `member id`, `discord-id`). Standalone Bearer, Basic
and Digest values are scrubbed too, with whitespace or a colon/equal delimiter
(including quoted keys). A matched credential/member
field or auth scheme withholds the remainder of the line, including any quoted
commas/semicolons or additional Digest parameters. This is known-pattern
redaction, not a general-purpose sanitizer for arbitrary unlabelled data. The
configured token is removed before first-line normalization, and all redaction
runs before the 200-character cap so truncation
cannot retain a token prefix. `skipped`
becomes `skipped` with the skip annotation or result error, or `no reason
recorded` when neither names one.
Any other status — missing, non-string, or an unrecognized string — becomes
`failed` with a bounded single-line `unknown test status: ...` reason, so an
unknown report can never pass silently. Exit codes are `0` for a clean pass,
`1` for failed/flaky journeys or runner errors, and `2` for an all-skipped,
empty, invalid/unreadable/bounded-out report or output failure. Input faults take
precedence over journey/runner failures. Neither the Playwright job's exit nor
any deploy gate is relaxed by this diagnostic accounting.

The staging config sets `retries: 0` (`playwright.staging.config.ts`), so a
report from this config cannot legitimately contain `flaky`. A flaky row fails
closed. Check for a `--retries` override or a report produced by another config;
verify that provenance rather than trusting the row as a pass. Its first-attempt reason is a bounded, single-line
summary in the derived ledger; it is not the raw Playwright report. The
failure-only upload is gated on the existing QA-token scrub completing across
`test-results/` and `playwright-report/`; a failed or incomplete scrub uploads
nothing. The separate ledger artifact contains only the derived JSON and
Markdown ledger, never the raw report. The `e2e-staging-failure-*` artifact, retained for seven days, contains only
the derived ledger; the raw report, HTML report and traces are not published
as artifacts. For a failed run on `main`, follow the [documented host-flake loop](rum-web-vitals.md):
it reruns once, then opens a private main-red card for the Web Engineer if it
fails again. Never rerun-until-green to clear a failure.

### Diagnostic receipt contract

`node ci/check-staging-journeys.mjs --help` discovers this single contract.
Regenerate receipts from local fixtures/reports only; the CLI never starts a
browser, socket, subprocess, retry or deploy. One hermetic check exercises the
library and CLI, including a child-process external-effect tripwire:

```sh
node --test e2e/staging/journey-ledger.test.mjs e2e/staging/journey-receipt.test.mjs
```

The CLI accepts `--report FILE`, `--out-json FILE` and `--out-md FILE` (defaults
above), creates both output parent directories independently, and appends the
same Markdown to `GITHUB_STEP_SUMMARY` when set. Valid arguments with distinct,
writable regular output paths receive both receipts **even when input cannot
be read or parsed**. Help is effect-free and needs no report or configuration.
Invalid arguments and colliding input/output/summary paths are refused (exit 2)
without writing. The pre-write check compares resolved paths, canonicalized
targets (nearest existing ancestors plus dangling final symlinks, so symlinked
parents and not-yet-existing symlink aliases are caught) and existing-file
device/inode identities, including symbolic and hard links. Keep local paths
stable during execution; this is not protection against concurrent path replacement.
A filesystem output failure, including an existing non-regular receipt or
summary destination, also exits 2, emits only a fixed
`output_unwritable` diagnostic, and marks any writable companion non-pass; no
promise is made that an unwritable destination receives a file.

The JSON schema is version 2 (`version` and `schemaVersion` both `2`):

- `counts` retains `total/passed/failed/skipped/flaky` and counts only collected
  journey outcomes, never runner errors or invented completed measurements.
- `journeys` retains bounded/redacted `name/file/project/status/reason` and adds
  `id`: `journey:` plus SHA-256 of the original file, suite-title ancestry, spec
  title and project tuple. It is independent of ordering, status, output path
  and run provenance. Identical tuples share an ID; it is an identity, not a
  completed-execution count or an anonymization guarantee.
- `provenance` contains `sha/runId/runAttempt` from `GITHUB_SHA/GITHUB_RUN_ID/`
  `GITHUB_RUN_ATTEMPT` only. SHA must be 40 or 64 hex characters; run ID and
  attempt are positive decimal strings of at most 20 and 10 digits. Absent or
  invalid values are the literal `unknown`, never inferred from report metadata
  or the checkout. Direct library callers may supply that same validated tuple.
- `diagnostics` is a sorted, aggregated list of fixed `code/count/retryable/`
  `next_action` objects only. No report error message, stack, snippet, location,
  config, input/output path or arbitrary report field is copied into them.
  Counts saturate at 10,000; at most the seven codes below can appear. A count
  at the cap is a lower bound, not a claim that the input had exactly that many.
- `verdict` retains `pass/fail/all-skipped/empty`. Runner errors always force
  `fail`, even with no journeys. Shape faults plus retained rows force `fail`;
  rejected or invalid inputs without collected rows remain non-pass `empty`.
  Shape faults never turn a valid sibling into a fictional failed test.

| Diagnostic code | Meaning | Retryable |
| --- | --- | --- |
| `runner_error` | One or more top-level Playwright runner/teardown error objects, irrespective of passing rows | false |
| `report_unreadable` | Missing/unreadable input or a non-regular file | true |
| `report_invalid_json` | Input is not complete JSON | false |
| `report_invalid_shape` | Invalid root, nested collection or collection item | false |
| `report_too_large` | Input bytes, nodes, string volume or collected-row cap exceeded | false |
| `report_too_deep` | Any input nesting, including ignored metadata, exceeds the depth cap | false |
| `output_unwritable` | A receipt or configured step summary could not be written | true |

`retryable` describes regenerating a local receipt after fixing the named fault;
**it never authorizes rerunning staging, a deployment or a failed journey**.
`next_action` is a fixed bounded recovery instruction, not text from the report.

Bounds (defined once in `REPORT_LIMITS` in `e2e/staging/journey-ledger.mjs`):
8 MiB input, 64 value-depth levels from root depth 0, 100,000 visited values,
100 collected journeys. The CLI checks regular-file size before reading and
reads at most the byte cap plus one sentinel byte, including a file that grows.
The library preflights the entire parsed value iteratively, including ignored
metadata; cycles, excessive depth/node count or aggregate string/key bytes
reject the input before collection. Missing optional collections (suites,
errors, results, annotations) are empty; a missing specs or tests collection,
an explicitly null/non-array collection and non-object items are shape faults.
Valid siblings are still retained on shape faults. On row-cap overflow, retained rows are
partial and the gate fails. Each display/reason field is at most 200 characters;
source diagnostic strings over 2,048 characters are withheld whole (not
truncated before redaction). No raw metadata or runner diagnostics expand output volume. Existing known-pattern
redaction applies to display fields too; it is still not a general sanitizer for
arbitrary unlabelled member content, so test labels must remain synthetic.

Receipts contain no timestamps, random IDs, file locations supplied to the CLI,
report timings or guessed success. Identical input and provenance produce
byte-identical JSON/Markdown regardless of output directory. A diagnostic
receipt is evidence of accounting only: it is not a Playwright-job, staging or
deployment PASS. Existing raw-report upload exclusions and failure-scrub gates
remain unchanged.
