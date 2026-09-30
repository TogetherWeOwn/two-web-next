# W15: remaining events-domain acceptance ledger (CRUD/publish, RSVP, feeds, jobs, hot path)

This is the test-port slice for [TOG-10789](/TOG/issues/TOG-10789), under the
acceptance-net parent [TOG-9697](/TOG/issues/TOG-9697). Earlier W15 slices
already ported auth/sessions ([TOG-10114](/TOG/issues/TOG-10114),
`docs/w15-auth-tests.md`) and exposure/member-data ([TOG-10116](/TOG/issues/TOG-10116),
`docs/w15-member-data-parity.md`); the agent-events ingress/HMAC/admin port is
[TOG-10121](/TOG/issues/TOG-10121). This slice covers the **remaining events
domain**: CRUD/publish/cancel, server RSVP writes and their dual throttle
budgets, calendar-feed bytes and sessionless view policy, and the
queue/cron/single-flight/real-SQL-race behavior already merged. A green suite
proves the **mapped Next contracts**, not full legacy feature parity, and not
permission to flip production. This card does not claim final W15/W16 readiness.

## Source and disposition rules

The inventory was read from legacy `TogetherWeOwn/two-web` at `2eaefb8d`
(2026-09-30). That is a newer local snapshot than `e1e939a`, the source pinned
by `docs/parity.md`; the four 2026-era regression suites it adds
(`EndedDraftPublicationTest`, `EventCapacityFloorTest`, `FeedExpiryValidatorTest`,
`HotPathIndexTest`) are the reason this slice reads HEAD instead. Legacy is
read-only: no PHP tests, no live deployment or database probes, no legacy
mutations.

Legacy test counts at the audited snapshot: **214 files** (141 Feature / 42
Unit / 18 Browser / 4 Integration). Paths in the tables are relative to legacy
`tests/`. Destinations are relative to this repository.

- **Ported/adapted:** the behavior is asserted by named Vitest suites.
- **Dropped:** Laravel/Coolify/infrastructure-only assertions do not apply.
- **Gap/deferred:** absent or owned by another slice — **not a pass, not a
  waiver**. The production parity gate stays NEEDS WORK until these rows have
  executable coverage or an authorized disposition.

## New coverage added by this slice

Only genuine gaps were added; everything already covered cites the existing
suite below.

| Gap | New suite | Tests | Ports |
|---|---|---|---|
| G1 wall-time ⇄ UTC, DST gap/fold, IANA + offset + impossible-date rejection | `test/event-time-validation.test.ts` | 9 | `Feature/Events/EventTimezoneTest.php` (incl. the 2026 gap shoulders and the autumn fold pinned to the second, GMT occurrence — the same instant legacy `EventInput::instant` produced) |
| G2 event-form floor + fold carrier | `test/event-time-validation.test.ts` | 7 | `EventCapacityFloorTest.php` **form-floor half**, TOG-6805 carrier both sides, `EventService::transitionTo` guard |
| G3 RSS item-edge bytes (no description, guid stability, DST pubDate, multibyte) | `test/event-feeds.test.ts` | +3 | `Feature/Events/EventRssTest.php` edge rows, `EventIcsTest.php` folding |
| G4 feed expiry rotates validators with no write | `test/event-feeds.test.ts` | +1 | `Feature/Events/FeedExpiryValidatorTest.php` (clock crosses `ends_at`; RSS+ICS drop the row, stale ETag → 200, new ETag → 304; per-event ICS still serves) |
| G5 hot-path index presence | `test/schema-hot-path.test.ts` | 2 | `Feature/Events/HotPathIndexTest.php` **index-presence half** (`pg_indexes` introspection) |

Totals after this slice: **48 test files, 745 passed, 10 skipped**.

## Application gaps found — separate application fix

The original acceptance-port PR (#52) remains test/fixture/docs only by
contract. [TOG-10813](/TOG/issues/TOG-10813) supplies the application guards and
`test/event-mutation-invariants.test.ts` in a separate PR. These are single-event
contracts; the series and grant variants below remain deferred, not implied passes.

| Row | Disposition | Evidence |
|---|---|---|
| A1 | Ported: ended-draft publish refusal | Legacy `Feature/Events/EndedDraftPublicationTest.php` at `2eaefb8d` (28, 35, 43, 49, 61). `transitionEvent` locks the persisted event before checking the clock, refuses only `ends_at < now` with the exact legacy message in `fields.ends_at`, and leaves ended-draft cancellation legal. `test/event-mutation-invariants.test.ts`: JSON/admin POST refusal, no row/audit/announcement mutation, ongoing/equality controls, clock-after-lock and concurrent persisted-date edit regressions. |
| A2 | Adapted: occupied-seat floor | Legacy `Feature/Events/EventCapacityFloorTest.php` at `2eaefb8d` (45, 59, 110). `updateEvent` shares RSVP's event `FOR UPDATE` lock, counts only `going`, and rejects a finite capacity below that count before any field/audit write. The message includes the occupied seat count. `test/event-mutation-invariants.test.ts`: JSON/admin refusal from finite/unlimited, equal/increase/unlimited controls, maybe/not-going/waitlisted excluded, stale-form recount and concurrent-seat commit regression. Numeric JSON capacity is parsed as finite; title-only PATCH preserves it. Waitlist promotion is still A3, not this fix. |

The series-child variant (`Integration/EndedDraftSeriesPublicationTest.php`)
and the agent-grant shrink row (`EventCapacityFloorTest` line 82) follow the
series (W13) and agent-events grants respectively — see defers below.

## Deferred and dropped rows

| Row | Legacy file(s) | Disposition |
|---|---|---|
| A3 waitlist | `Feature/WaitlistTest.php` (515 lines) | **Deferred.** `docs/parity.md` §11 records waitlist/capacity-under-lock as pending W8, and the member-facing button as W10 slice 2. `test/rsvp.test.ts` covers the full-vs-open boundary (409 `event_at_capacity`); queueing beyond it is the deferred feature. |
| A4 page composition | `Feature/Events/EventPrevNextTest.php`, `EventRelatedTest.php`, `EventCopyLinkTest.php` | **Deferred to W10** under [TOG-9689](/TOG/issues/TOG-9689): prev/next and related rails and the copy-link affordance are page-composition work, not CRUD/RSVP/feeds acceptance. |
| A5 anonymous card cache | `Feature/Events/AnonymousEventCardCacheTest.php` (TOG-9277) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689): depends on the anonymous card-cache design, not yet implemented in Next. |
| A6 EXPLAIN planner half | `Feature/Events/HotPathIndexTest.php` (61-229) | **Deferred to the W16 pre-flip review.** The presence half is G5 here. The planner half asserts `EXPLAIN` reaches the index for exact query shapes; Next's index **set is deliberately different** from legacy's (`events_status_starts_at_idx`, `events_parent_event_id_idx`, `rsvps_user_id_idx`, `rsvps_event_user_unique` vs legacy `rsvps_event_id_status_index`, `rsvps_unsynced_event_id_index`, `events_ends_at_index`, `events_starts_at_id_index`), so the planner audit must run against Next's own read paths (`src/events/reads.ts`), not the legacy shapes. |
| A7 query counting | `Feature/Events/EventQueryCountTest.php` | **Dropped.** Legacy counts queries through Laravel's lazy-loading ORM (N+1 audit). Next renders events pages in single-pass SSR with explicit Drizzle reads (`src/events/reads.ts`); there is no lazy-relation surface to audit. |
| A8 deploy drain | `Unit/QueueDrainOnDeployTest.php` | **Dropped.** Legacy pins a Coolify post-deploy `php artisan queue:restart` (TOG-7288). Workers deploys are atomic; the queue lives in the Postgres ledger and `docs/parity.md` §10 records the command as dropped. Health is `GET /up` (`test/up.test.ts`, 9 tests). |
| A9 series/recurrence | `Feature/Events/RecurringEventsTest.php`, `Unit/Events/RecurrenceScheduleTest.php`, `Integration/EndedDraftSeriesPublicationTest.php` | **Deferred to the W13 series card** (`events:reconcile` materialization; existing card in the TWO Web Next project). `events_parent_event_id_idx` presence is pinned by G5. |
| A10 browser RSVP integration | `Browser/EventsRsvpTest.php`, `Feature/Livewire/RsvpButtonTest.php` (browser half) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island-level contract coverage exists (`test/islands-rsvp-button.test.ts`, 29 tests; server halves in `test/rsvp.test.ts`), but the browser-level integration row is the parent card's. |

## Core file mapping (already covered — existing suites)

| Legacy test file | Disposition and Next proof |
|---|---|
| `Feature/Events/EventTimezoneTest.php` | **Ported (G1):** both DST sides, round-trip, UTC zone, IANA/offset/impossible-date rejection, gap + shoulders, autumn fold → second occurrence, with the fold-carrier rule of TOG-6805 (G2) in `test/event-time-validation.test.ts`. Page-render display is the W10 islands drift net (`test/islands-events-calendar.test.ts`). |
| `Feature/Events/EventCapacityFloorTest.php` | **Adapted (G2/A2):** form floor in `test/event-time-validation.test.ts`; occupied-seat floor, stale/concurrent recount and JSON numeric capacity in `test/event-mutation-invariants.test.ts` ([TOG-10813](/TOG/issues/TOG-10813)). Agent-grant shrink and waitlist promotion remain deferred. |
| `Feature/Events/EndedDraftPublicationTest.php` | **Ported (A1, single-event):** refusal, strict end boundary, ended-draft cancel, persisted-date and post-lock clock tests in `test/event-mutation-invariants.test.ts`; status-only guards in `test/event-time-validation.test.ts`. Series-child publish remains deferred. |
| `Feature/Events/FeedExpiryValidatorTest.php` | **Ported (G4):** `test/event-feeds.test.ts` "drops an expired event… no write" (clock-only fake `Date`, both feeds, ETag rotation, per-event ICS still 200). |
| `Feature/Events/HotPathIndexTest.php` | **Adapted (G5):** index presence in `test/schema-hot-path.test.ts`; EXPLAIN half deferred (A6). |
| `Feature/Events/EventsFeedTest.php`, `EventIcsTest.php`, `EventRssTest.php`, `EventGoogleCalendarTest.php`, `EventEtagTest.php` | **Ported:** byte fixtures + route policy in `test/event-feeds.test.ts` (11 tests): ICS folding/escaping/CANCELLED, RSS escaping + description omission, guid stability across rename, DST pubDate, multibyte round-trip, webcal swap, sessionless ETag/304, drafts never exposed, cancelled excluded from RSS but in ICS. |
| `Feature/Events/EventJsonAccessTest.php` | **Ported:** sessionless view policy in `test/event-feeds.test.ts` (draft 403 / unknown-malformed 404 / ETag 304) and `test/events.test.ts` (`/events.json` 401 with a session → 200 sessionless with ETag/304). |
| `Feature/Events/EventLifecycleTest.php`, `EventPolicyTest.php`, `EventKeyTest.php`, `EventScheduleTest.php` | **Ported:** `test/events.test.ts` (8 tests): CRUD + publish/cancel round-trip with write-back enqueued, ULID route keys, forged-origin 403, wall→UTC PATCH, cancelled republish 422, 410 + `x-robots-tag` noindex (`events.test.ts:167-168`); transition guard G2 above; wall-time scheduling G1/G2. |
| `Feature/Events/EventPaginationTest.php`, `PastEventsArchiveTest.php` | **Ported:** `test/events.test.ts` "past archive pages twenty newest-first eligible rows with a stable tie-break". |
| `Feature/Events/EventSearchTest.php`, `EventSearchLogTest.php` | **Ported:** `test/event-search.test.ts` (18 tests: tokenization, ranking, logging, admin widget). |
| `Feature/Events/RsvpAuthGateTest.php`, `RsvpEndedEventTest.php`, `RsvpPauseTest.php`, `RsvpWriteBackFailureTest.php` | **Ported:** `test/rsvp.test.ts` (31 tests): guest 401 / foreign-origin 403 / bad status 422 / other verbs 405 / foreign `user_id` 403; 201/200/204 with mirror-stamp reset; draft/cancelled/ended/paused refuse PUT writing nothing; write-back failure paths; honeypot rows. |
| `Feature/Events/RsvpUniqueLockRaceTest.php`, `Integration/RsvpCapacityRaceTest.php` | **Ported:** `test/rsvp.test.ts:343` (40 concurrent writes by one member → exactly 12 budget), `:352` (14 members chase 3 seats → exactly 3 win, 409 `event_at_capacity` shape), `:373` (double-submit → one row). Real Postgres, real SQL locking. |
| `Feature/Events/RsvpThrottleTest.php`, `Feature/Throttling/ThrottleCoverageTest.php`, `ThrottleEnvelopeTest.php` | **Ported:** `test/throttle.test.ts` (7 tests): mutating-route coverage, honest exemption list, budget-then-429 with the one JSON envelope, branded browser page, logout 30/min + QA login 10/min (the dual budgets from PR #49). |
| `Feature/QueueHealthEndpointTest.php`, `Feature/Console/CheckQueueDepthCommandTest.php` | **Ported/dropped:** `GET /up` with the queue ledger depth in `test/up.test.ts` (always 200, degraded at warn, unknown on outage, bounded read); the `queue:check-depth` command itself is dropped (`docs/parity.md` §10, N3). |
| `Feature/Console/ReconcileEventsCommandTest.php` | **Ported:** cron/queue behavior in `test/jobs.test.ts` (24 tests: pinned cron expressions, dispatch debounce + idempotency key, backoff walk, bot Retry-After, duplicate replay, ledger transitions), `test/jobs-ledger.test.ts` (6), `test/jobs-postgres.test.ts` (3: overlapping cron single-fights and frees the lock), `test/worker-runner.test.ts` (9). |
| `Feature/Console/QueuePoisonProbeTest.php` | **Dropped:** a legacy staging probe tool, not a product contract; poison rows surface as `/up` `failed` counts (`test/up.test.ts`). |
| `Feature/Events/TerminalSyncRefusalTest.php` | **Ported:** the W15 agent-events slice ([TOG-10121](/TOG/issues/TOG-10121), done): terminal bot refusal fails now and marks the ledger row failed (`test/jobs.test.ts`), shield/contract rows in `test/agent-events.test.ts` / `test/agent-events-shield.test.ts`. |
| `Feature/Admin/EventRsvpRosterTest.php` | **Ported:** roster reads in `test/roster.test.ts` (15) and `test/admin-reads.test.ts`. |
| `Feature/Livewire/EventsCalendarTest.php`, `EventsCalendarTimezoneTest.php`, `HomeUpcomingEventsTest.php` | **Ported (island contract):** `test/islands-events-calendar.test.ts`, `test/islands-past-events.test.ts`, `test/islands-going-count.test.ts` (W10 slices 3-4). Browser-level rows remain W10 / [TOG-9689](/TOG/issues/TOG-9689). |
| `Feature/Events/EventJsonLdTest.php` | **Out of scope:** SEO slice [TOG-10118](/TOG/issues/TOG-10118) (delivered separately, `test/seo.test.ts`). |

## Recorded notes for reviewers

1. **Fold direction.** `wallToUtc` resolves an autumn-overlap wall time to the
   **second (GMT) occurrence** — the same instant legacy `EventInput::instant`
   produced (legacy pinned `2026-10-25 01:30` → `01:30:00 UTC`,
   `EventTimezoneTest.php:295-300`). The Next docstring previously said "first
   occurrence"; this slice fixes that comment only (no behavior change in
   `src/admin/validation.ts` — disclosed in the PR body).
2. **Clock-only fakes.** DB tests that need a moving clock fake only `Date`
   (`vi.useFakeTimers({ toFake: ["Date"] })`); full fake timers hang the
   postgres-js driver's socket timers.
3. **Test database.** The suite runs against the per-card database
   `two_web_next_tog10789` on `agent-testdb` (house convention; migrations
   applied from `drizzle/`). CI uses its own service containers. No staging or
   production database was touched.

## Verification

```
npm run typecheck                                    # clean
DATABASE_URL=...two_web_next_tog10789 npm test       # 48 files, 745 passed, 10 skipped
```

Legacy inventory: `gh api repos/TogetherWeOwn/two-web/git/trees/<sha>?recursive=1`
at `2eaefb8d` (214 test files; 141 Feature / 42 Unit / 18 Browser / 4 Integration).

### A1/A2 application verification ([TOG-10813](/TOG/issues/TOG-10813))

- `test/event-mutation-invariants.test.ts`: **23 tests** (8 credential-free
  containment/parser rows, 15 live mutation/lock rows).
- `DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next_tog10813 npx vitest run test/event-mutation-invariants.test.ts test/event-time-validation.test.ts test/rsvp.test.ts`:
  **3 files, 69 passed, zero skipped**; `npm run typecheck` and `git diff --check` clean.
- The fixture validates the test URL before creating a driver, migrates only its
  UUID-owned schema, and disposes that schema. No production/staging probes.
- Lock behavior follows the existing RSVP implementation and installed
  Drizzle 0.45.3 `PgSelect.for` API. Sources:
  [Postgres row locking](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
  [Drizzle count/filter queries](https://orm.drizzle.team/docs/select#aggregations).
- These checks prove only A1/A2's mapped single-event behavior; they do not
  prove series cascade, grant-owned edits, waitlist promotion, or production readiness.
