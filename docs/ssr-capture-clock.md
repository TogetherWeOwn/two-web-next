# Local SSR capture clock

This is render-time plumbing, not permission to run a capture or deploy. It does
not change the capture seed, browser spec, route ownership, design, baseline,
known-answer classification or any production guard. Browser `page.clock` alone
is not evidence that a Worker rendered against the same instant.

## Eligibility and evidence

`src/render-clock.ts` returns a fresh display `Date` at exactly
`2098-12-31T20:00:00Z` only when **all** of these hold:

1. The generated local bundle defines `__TWO_LOCAL_CAPTURE__` as boolean `true`.
   The normal Kit SSR build defines it false early and removes capture-only code;
   an explicitly opted-in local build preserves it for the generated Wrangler
   config. No deployed Wrangler config defines it true. A runtime binding cannot
   supply this compile-time name. Normal Hono and Kit bundles use live time even
   if their runtime bindings are misconfigured to look local.
2. The explicit runtime fixture opt-in `SSR_CAPTURE_FIXTURE` is exactly `true`.
3. `APP_URL` is a canonical HTTP origin on `127.0.0.1`, `localhost` or `[::1]`,
   with an optional port/trailing slash. HTTPS, credentials, path, query,
   fragment, malformed URLs and alternative numeric host spellings fail closed.
   This reuses `fixtureManifestFor`'s explicit-opt-in/HTTP-loopback boundary,
   with stricter canonical-origin and actual-request checks for capture only.
   The existing parity-fixture manifest and shipped route ownership are unchanged.
4. The native `Request.url` origin equals that configured origin, including port.
   A present Host must agree too. Forwarded headers, Origin, cookies and query
   parameters are never eligibility inputs. In particular a deployed URL plus a
   forged local Host cannot qualify.
5. The method is GET or HEAD. Unsafe methods never receive this display clock.

The local Kit fixture requires two explicit steps: build with
`SSR_CAPTURE_FIXTURE=true npm run build --prefix web`, then launch
`ci/kit-worker-dev.mjs` with `SSR_CAPTURE_FIXTURE=true` and the existing disposable
fixture database. A normal build cannot be turned into a capture artifact at
startup: the launcher refuses an artifact missing the capture code, before
writing config or starting Wrangler. Rebuild normally after local capture work;
never deploy the opted-in artifact. The generated fixture supplies the late build
gate and runtime opt-in only when its launching process explicitly sets that
flag. It remains a `--local` Worker bound to the IPv4 loopback listener, backed
only by the existing disposable fixture database.
For a Hono-only fixture build, use the same local-only define and runtime flag
with the existing test-only local configuration and an explicitly loopback-bound
Wrangler listener. Never put either setting in a shipped configuration, use a
remote listener/tunnel, or deploy the generated fixture. The deployment build
boundary plus the loopback listener is the transport boundary: URL/header checks
alone are not a claim to authenticate a TCP peer through an arbitrary proxy.

Only covered, successfully rendered HTML responses (200 or the cancelled event
410) carry `x-two-ssr-clock: 2098-12-31T20:00:00Z`. They are private/no-store.
A capture consumer **must require that exact header**, in addition to the frozen
spec's renderer/status/body/browser checks. Missing markers, redirects, JSON,
404s, outages and qualification refusals are not frozen SSR evidence. Unsupported
document paths return 412 in capture mode; ordinary asset requests remain usable
but never qualify. This deliberately leaves the whole matrix unqualified until
every required row is covered. Do not mask time or silently omit failed rows.

## SSR time dependency inventory

Coverage is explicit rather than inferred from a browser screenshot. These are
the frozen matrix's route families on both Hono and Kit. All date-dependent
selection parameters below are read-only display filters, not changes to the
Postgres clock or write decisions.

| Rows / path | Hono SSR dependencies | Kit SSR dependencies | Clock qualification |
| --- | --- | --- | --- |
| 1 `/` guest/member | `src/index.tsx` passes time into `cachedHomeUpcoming`/`cachedFeatured`; `src/screens/home.tsx` calls `groupTeaserEvents`; `src/counts.ts` derives freshness from `Date.now()` | `web/src/routes/+page.server.ts` reads the same caches; `+page.svelte` groups with `new Date()` | **Refused.** Home caches, source freshness and Discord reads have not been separated from display time. |
| 2 `/events` | `src/events/routes-calendar.tsx` samples time for `loadCalendarPageModel`, month selection, today markers, cards and RSVP display | `src/kit-events.ts` samples time for the same model and grid | **Refused.** The model also passes its time to `discord.upcoming`; freezing snapshot refresh/expiry would violate the operational-clock boundary. |
| 3 `/events/past` | `listPast` cutoff in `src/events/routes-calendar.tsx` | `loadPastArchivePage` in `src/kit-past-events.ts`, bound by `web/src/routes/events/past/+page.server.ts` | **Covered.** Searched and ordinary reads receive the request display date. Both anonymous-cache paths bypass cache reads and writes for capture requests; live TTLs and cache entries remain untouched. Archive formatting uses stored event timestamps. |
| 4 `/e/:key` guest/member/paused/cancelled | `src/events/routes-detail.tsx` passes one date to `getEventNeighbors`, `listRelatedEvents` (including cancellation alternatives), and `EventPage`; `src/events/pages-detail.tsx` shares it with `isOngoing`, `RsvpButton`, lineup/link availability | `web/src/routes/e/[key]/+page.server.ts` supplies the date to `resolveKitEventDetail`; its store forwards it to neighbors/related reads, and the model derives ongoing/RSVP/link state once; `EventDetail.svelte` renders the model verbatim | **Covered for 200/410.** Missing-key suggestions remain live and never qualify. `getEventSeriesContext` orders stored dates and has no current-time dependency. |
| 5–8 `/about`, `/faq`, `/rules`, `/privacy` | Content/static leaves and shared shells use versioned/stored dates, not current time | Corresponding Kit leaves use the same content and fixed metadata | **Covered.** No current-time display dependency. Request logging and throttling stay live. |
| 9 `/join` | Widget snapshot/cache and session/flash journey | `src/join/kit-page.ts` and widget snapshot source | **Refused.** Live widget source/TTL is not a deterministic fixture guarantee. |
| 10 `/auth/recover` | Recovery page has no current-time display calculation | Corresponding recovery leaf has no current-time display calculation | **Covered.** Session/auth expiry is not frozen. |
| 11–12 `/profile`, `/members/:user` | Member stats and ranks come from external `web_v1` views; `src/profiles/pages.tsx` samples real `Date.now()` for the form timing trap | Same external stats; `web/src/lib/ProfileView.svelte` samples real form-open time | **Refused.** External view time dependencies are not proven here. The timing trap is a security control, not display state. |
| 13 `/leaderboards/members` | `src/leaderboards/pages.tsx` calls `utcPeriodShortcuts` | `web/src/routes/leaderboards/members/+page.svelte` calls the same helper | **Refused.** Period shortcuts and external ranking views are not covered. |
| 14–17 `/hotzones`, `/hotzones/joins`, `/voice`, `/games` | `src/hotzones/pages.tsx` uses `utcPeriodShortcuts`; routes derive `joinsRetentionNote` | `src/kit-hotzones.ts` derives retention notes; shared view/period controls remain live | **Refused.** No claim of frozen aggregate data, privacy windows or period defaults. |
| 18 `/admin` | Source evidence/ops diagnostics, funnel cache | Shared admin dashboard/evidence services | **Refused.** Operational evidence is intentionally live. |
| 19 `/admin/events` | `src/admin/store-event-reads.ts` uses current time for the past filter; `src/admin/pages/shell.tsx` derives ended state | Same store; `web/src/routes/admin/events/+page.svelte` derives edit state | **Refused.** List display clocks are not plumbed. |
| 20–21 `/admin/events/new`, `/admin/events/:key` | Event form/editor uses current validation/display and departure/expiry state | `src/admin/kit-event-edit.ts` has a clock seam; editor/session lifetime remains operational | **Refused.** Editor validation and security expiry must not receive a display clock. |
| 22–24 `/admin/featured`, `/admin/featured/new`, `/admin/featured/:id` | `src/admin/pages/featured-list.tsx`, `featured-form.tsx` and featured policy/status helpers default to current time | `src/admin/kit-featured.ts`, `kit-featured-edit.ts` have explicit clock seams | **Refused.** These paths have not been qualified; editor/write decisions stay live. |
| 25 `/admin/activity-log` | Stored audit timestamps; security/audit pipeline remains live | Same stored data and audit boundary | **Refused.** No deterministic source/operational-row guarantee. |
| 26–27 `/admin/join-attempts`, `/admin/join-attempts/:id` | `src/admin/reads.ts` derives a 90-day `windowStart` | Both Kit join-attempt loaders use those reads | **Refused.** This is a privacy/retention window; it must not be frozen to make fixture rows visible. |
| 28 unknown path / 404 | `cachedNotFoundSuggestions` has a wall-time cache and upcoming read | Shared suggestion source | **Refused.** No frozen-404 assertion. |

Shared display helpers with current-time defaults are `src/events/reads.ts`
(`listUpcoming`, `rankUpcoming`, `listUpcomingForMonth`, `listHomeUpcoming`,
`listHomePastTimezones`, `loadHomeUpcomingMerged`, `listCalendarPast`, `listPast`,
`getEventNeighbors`, `listRelatedEvents`, `listFeed`), `page-models.server.ts`,
`pages-calendar-card.tsx`, `rsvp-button.tsx`, `ongoing.ts`, `link-availability.ts`,
`teaser-groups.ts`, `date-format.ts` (`currentCalendarMonth`),
`src/hotzones/season.ts`, `src/hotzones/aggregates.ts`, `src/featured.ts`,
`src/featured-status.tsx`, `src/featured-policy.ts` and
`src/featured-eligibility.ts`. An injectable default is not qualification: only
explicitly wired, covered routes may carry the marker. Feeds and machine/data
endpoints are not qualified document rows.

### Clocks deliberately left real

- Authentication, OAuth, cookies, sessions, role rechecks and session rotation:
  `src/auth/`, `src/sessions.ts`, `src/kit-session.ts`, `src/oauth-journeys.ts`,
  `src/qa.ts`, profile/admin gates and the session code in `src/index.tsx`.
- Form-open timing and bot-trap checks: profile pages, `ProfileView.svelte`,
  `src/profiles/routes-writes.tsx`, and the member-profile island contract.
- Throttles, security limits, request/access/alert logs, replay and signed bot
  requests; source evidence/ops overrides; every editor/write/job path.
- Cache lifetime/freshness: `src/events/anon-cache.ts`, `src/home-cache.ts`,
  `src/counts.ts`, `src/not-found-suggestions.ts`, `src/admin/join-funnel.ts`,
  `src/discord-widget.ts`, public-data caches and Discord snapshot refresh/expiry.
- Postgres `now()`/`clock_timestamp()`, schema defaults, RSVP admission and write
  stores, retention jobs and queues. No database clock is changed.

The browser's click-time relative-duration/device-zone/auth-status controllers
still use the browser clock; they require the separately frozen Playwright clock.
There is no global Date replacement, ambient request context, mutable env clock,
or persistent cross-request capture state.

## Verification contract

`test/render-clock.test.ts` proves build/config/request guards, mutable-Date
isolation, concurrent live/default behavior, repeated Hono render and Kit model
state, read-parameter plumbing and closed qualification. The integration suite
exercises actual Hono middleware and cache isolation; the Worker suite exercises
both compiled build variants on a real loopback socket, with outbound network
forbidden. `test/kit-event-detail.test.ts` also repeats real Svelte SSR HTML at
different wall times. Existing fixture/route ownership and auth/session suites
remain required. Independent security review is still required; these tests are
not a self-attestation substituting for it.

REA angle: reuse the guarded fixture manifest and public Playwright clock/context
APIs. No hosted capture service or copied proprietary code is needed.
