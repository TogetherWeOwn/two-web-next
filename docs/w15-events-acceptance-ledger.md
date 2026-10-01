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

Legacy test counts at the audited snapshot: **203 `*Test.php` files** (141
Feature / 43 Unit / 15 Browser / 4 Integration; 212 PHP files total including
9 support helpers). Paths in the tables are relative to legacy
`tests/`. Destinations are relative to this repository.

- **Ported/adapted:** the behavior is asserted by named Vitest suites.
- **Partial:** only the explicitly named assertions are proved; the remaining
  portable contracts are gaps, not a file-level pass.
- **Dropped:** Laravel/Coolify/infrastructure-only assertions do not apply.
- **Gap/deferred:** absent or owned by another slice — **not a pass, not a
  waiver**. The production parity gate stays NEEDS WORK until these rows have
  executable coverage or an authorized disposition.

## New coverage added by this slice

Only genuine gaps were added; everything already covered cites the existing
suite below.

| Gap | New suite | Tests | Ports |
|---|---|---|---|
| G1 wall-time ⇄ UTC, DST gap/fold, IANA + offset + impossible-date rejection | `test/event-time-validation.test.ts` | 9 | **Partial/adapted:** `Feature/Events/EventTimezoneTest.php`, incl. 2026 gap shoulders. Current Next selects the first, BST fold occurrence after main PR #64; legacy selected the second, GMT occurrence. The fold divergence remains a parity gap, not an authorized waiver. |
| G2 event-form floor + fold carrier | `test/event-time-validation.test.ts` | 7 | `EventCapacityFloorTest.php` **form-floor half**, TOG-6805 carrier both sides, `EventService::transitionTo` guard |
| G3 RSS item-edge bytes (no description, guid stability, DST pubDate, multibyte) | `test/event-feeds.test.ts` | +3 | `Feature/Events/EventRssTest.php` edge rows, `EventIcsTest.php` folding |
| G4 feed expiry rotates validators with no write | `test/event-feeds.test.ts` | +2 | `Feature/Events/FeedExpiryValidatorTest.php` (one case per RSS/ICS: a valid two-hour event is included exactly at `ends_at`, one second later drops out; original ETag → 200 + changed validator, new ETag → empty 304; persisted row unchanged; per-event ICS still serves) |
| G5 hot-path index presence | `test/schema-hot-path.test.ts` | 2 | `Feature/Events/HotPathIndexTest.php` **index-presence half** (`pg_indexes` introspection) |

Reviewed baseline at `a76cdb69`: **50 test files, 757 passed, 10 skipped**
(CI run 36773387443, disposable Postgres service container). The review fix
splits G4 into two independently executed cases (+1 test; feed suite 12 rather
than 11). New-head executed counts belong to its CI evidence on
[TOG-10994](/TOG/issues/TOG-10994); the baseline is not a new-head pass.

## Application gaps found — routed, not fixed here

This PR is test/fixture/docs only by contract; both rows below need
application code and are owned by the follow-up card
`689bf6f8-4bbf-4073-9318-90d2cfb2fa45` ("two-web-next: add ended-draft publish
refusal and occupied-seat capacity floor (legacy events parity)"; events domain
owner, created from this audit with the full evidence):

| Row | Gap | Evidence |
|---|---|---|
| A1 | Publishing an already-ended draft is not refused | Legacy `Feature/Events/EndedDraftPublicationTest.php` refuses with "An event that has already ended cannot be published. Update its dates first." (lines 28, 43), rechecks under the lock (35), allows publish up to the strict boundary (49) and still allows cancellation of an ended draft (61). Next chain `src/events/routes.tsx:354` → `src/admin/store.ts:139` → `src/admin/validation.ts:324`: `nextStatus` never consults `ends_at` vs now. |
| A2 | Edit cannot floor capacity at occupied seats | Legacy `Feature/Events/EventCapacityFloorTest.php` refuses with "Capacity cannot be lower than the number of members already going." (line 45), allows floor/increase/unlimited (59), recounts on a stale form (110). Next `src/admin/store.ts:92` writes any `capacity >= 1`; the seat-blind form floor (`src/admin/validation.ts:201`) is the only guard. |

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
| A7 bounded reads and aggregates | `Feature/Events/EventQueryCountTest.php` | **Deferred, portable acceptance gap; not dropped.** Legacy asserts fewer than five SQL round trips with ten featured rows on home and ten events on the JSON collection, correct `going_count = 3` on every collection row, and a single-event going count excluding maybe. Explicit Drizzle reads do not prove bounded query growth or correct aggregates. QA owns instrumented real-SQL coverage against Next's home, collection and show read paths for the W15/W16 acceptance gate; the existing island count tests are not equivalent proof. |
| A8 deploy drain | `Unit/QueueDrainOnDeployTest.php` | **Dropped.** Legacy pins a Coolify post-deploy `php artisan queue:restart` (TOG-7288). Workers deploys are atomic; the queue lives in the Postgres ledger and `docs/parity.md` §10 records the command as dropped. Health is `GET /up` (`test/up.test.ts`, 9 tests). |
| A9 series/recurrence | `Feature/Events/RecurringEventsTest.php`, `Unit/Events/RecurrenceScheduleTest.php`, `Integration/EndedDraftSeriesPublicationTest.php` | **Deferred to the W13 series card** (`events:reconcile` materialization; existing card in the TWO Web Next project). `events_parent_event_id_idx` presence is pinned by G5. |
| A10 browser RSVP integration | `Browser/EventsRsvpTest.php`, `Feature/Livewire/RsvpButtonTest.php` (browser half) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island-level contract coverage exists (`test/islands-rsvp-button.test.ts`, 29 tests; server halves in `test/rsvp.test.ts`), but the browser-level integration row is the parent card's. |

## Core file mapping (existing proof and remaining contracts)

| Legacy test file | Disposition and Next proof |
|---|---|
| `Feature/Events/EventTimezoneTest.php` | **Partial/adapted (G1):** both DST sides, round-trip, UTC zone, IANA/offset/impossible-date rejection, gap + shoulders, with the unchanged fold-carrier rule of TOG-6805 (G2) in `test/event-time-validation.test.ts`. Current Next's fresh fold parse selects the first occurrence (main PR #64), unlike legacy's second occurrence; an explicit authorized divergence or legacy-equivalent implementation remains required before full parity. Page-render display is the W10 islands drift net (`test/islands-events-calendar.test.ts`). |
| `Feature/Events/EventCapacityFloorTest.php` | **Adapted (G2):** form floor rows in `test/event-time-validation.test.ts` (1+ / large / empty / unlimited accept; zero/negative/non-numeric refuse). **Gap (A2):** occupied-seat floor on edit → follow-up card. |
| `Feature/Events/EndedDraftPublicationTest.php` | **Gap (A1):** routed to the follow-up card (id above); cancelled-terminal and draft-only-publish guards are ported in `test/event-time-validation.test.ts` ("status transition guard"). |
| `Feature/Events/FeedExpiryValidatorTest.php` | **Ported (G4):** `test/event-feeds.test.ts` table-driven "%s drops an expired event… no write after ends_at": RSS and ICS equality inclusion, one-second expiry, original validator miss, new validator hit, persisted full-row equality, per-event ICS still 200. |
| `Feature/Events/HotPathIndexTest.php` | **Adapted (G5):** index presence in `test/schema-hot-path.test.ts`; EXPLAIN half deferred (A6). |
| `Feature/Events/EventsFeedTest.php`, `EventIcsTest.php`, `EventRssTest.php`, `EventGoogleCalendarTest.php`, `EventEtagTest.php` | **Ported:** byte fixtures + route policy in `test/event-feeds.test.ts` (12 cases after the G4 review fix): ICS folding/escaping/CANCELLED, RSS escaping + description omission, guid stability across rename, DST pubDate, multibyte round-trip, webcal swap, sessionless ETag/304, drafts never exposed, cancelled excluded from RSS but in ICS. |
| `Feature/Events/EventJsonAccessTest.php` | **Partial: authenticated JSON collection only.** `test/events.test.ts:151-158` proves `/events.json` guest 401, authenticated member 200 with a published row/zero going count, and authenticated ETag 304. The draft 403 / unknown-malformed 404 assertions in `test/event-feeds.test.ts` target **ICS**, not JSON, and are not JSON access proof. **Gap:** the browser guest redirect, member visibility of published/cancelled/past but not draft, moderator visibility of all statuses, member-forbidden/moderator-readable draft show, and exact field allowlist/no internal-id leakage are not asserted by that JSON round-trip. QA/events owner must add dedicated JSON access/contract coverage (see `EventJsonContractTest.php` below); no full-file authorization or allowlist pass is claimed. |
| `Feature/Events/EventLifecycleTest.php`, `EventPolicyTest.php`, `EventKeyTest.php`, `EventScheduleTest.php` | **Ported:** `test/events.test.ts` (7 tests): CRUD + publish/cancel round-trip with write-back enqueued, ULID route keys, forged-origin 403, wall→UTC PATCH, cancelled republish 422, 410 + `x-robots-tag` noindex (`events.test.ts:167-168`); transition guard G2 above; wall-time scheduling G1/G2. |
| `Feature/Events/EventPaginationTest.php` | **Gap: portable JSON pagination contract.** Legacy `/events.json` asserts default twenty, earliest-first `starts_at` ordering, `per_page` and page traversal without repeats/omissions, `meta.current_page`/`per_page`/`total`, and cap 100. The `/events/past` HTML test is not proof of this JSON surface. Current `src/events/routes.tsx:203-207` instead accepts `limit` and returns `{data,page,limit}`; `src/events/reads.ts:113-120` orders starts descending. These differences are not an authorized parity disposition. QA/events owner must implement and assert the legacy JSON contract or obtain an explicit authorized divergence before the W15/W16 gate; JSON-contract stable tie coverage also remains a gap below. |
| `Feature/Events/PastEventsArchiveTest.php` | **Ported: HTML archive contract.** `test/events.test.ts:182-206` requests `/events/past` and proves twenty newest-first eligible rows, stable tie-break, page count/traversal, excluded statuses, no RSVP controls and an out-of-range state. This does not cover `/events.json` pagination. |
| `Feature/Events/EventSearchTest.php`, `EventSearchLogTest.php` | **Ported:** `test/event-search.test.ts` (22 tests: tokenization, ranking, logging, admin widget). |
| `Feature/Events/RsvpAuthGateTest.php`, `RsvpEndedEventTest.php`, `RsvpPauseTest.php` | **Ported:** `test/rsvp.test.ts` (30 tests): guest 401 / foreign-origin 403 / bad status 422 / other verbs 405 / foreign `user_id` 403; 201/200/204 with mirror-stamp reset; draft/cancelled/ended/paused refuse PUT writing nothing; honeypot rows. Its successful queue recorder is not bot-outage/recovery proof. |
| `Feature/Events/RsvpWriteBackFailureTest.php` | **Partial seams / integration gap.** `test/rsvp.test.ts:55-68` records successful enqueue only; `test/events.test.ts` pins an enqueue failure, `test/jobs.test.ts` pins mocked retries, and `test/islands-rsvp-button.test.ts:126-139` pins pending/synced copy. None joins a failed bot transport to a persisted RSVP and the member view, then retries the same operation/row through real mirror stamps and a synced member view. **Unproved chain:** outage releases rather than fails; RSVP/seat stays saved with null sync stamp and no false event mirror; member sees confirmed/pending rather than save failure while retry is outstanding; recovery stamps event/RSVP and switches that member view to synced. QA/jobs/events owner must add that same-row SQL + job + member-view integration, including the pending-without-retry case, before full parity. The real-mirror and commit-before-dispatch gaps below remain open; separate seam passes are not equivalent. |
| `Feature/Events/RsvpUniqueLockRaceTest.php`, `Integration/RsvpCapacityRaceTest.php` | **Ported:** `test/rsvp.test.ts:343` (40 concurrent writes by one member → exactly 12 budget), `:352` (14 members chase 3 seats → exactly 3 win, 409 `event_at_capacity` shape), `:373` (double-submit → one row). Real Postgres, real SQL locking. |
| `Feature/Events/RsvpThrottleTest.php`, `Feature/Throttling/ThrottleCoverageTest.php`, `ThrottleEnvelopeTest.php` | **Ported:** `test/throttle.test.ts` (7 tests): mutating-route coverage, honest exemption list, budget-then-429 with the one JSON envelope, branded browser page, logout 30/min + QA login 10/min (the dual budgets from PR #49). |
| `Feature/QueueHealthEndpointTest.php`, `Feature/Console/CheckQueueDepthCommandTest.php` | **Ported/dropped:** `GET /up` with the queue ledger depth in `test/up.test.ts` (always 200, degraded at warn, unknown on outage, bounded read); the `queue:check-depth` command itself is dropped (`docs/parity.md` §10, N3). |
| `Feature/Console/ReconcileEventsCommandTest.php` | **Partial: orchestration only.** `test/jobs.test.ts` supplies fake `closeFinished`/`staleEventKeys` results and proves close-before-resync ordering; `test/jobs-ledger.test.ts` and `test/jobs-postgres.test.ts` prove ledger/lock behavior, not event-row selection. **Real-adapter gap:** deployed `src/worker.ts` routes to `src/jobs/worker.ts`, where `closeFinished` and `staleEventKeys` reject as "not wired yet". Closing only finished published rows, preserving running/cancelled rows, selecting stale mirrors, skipping already-mirrored rows and persisted close-before-resync effects are unproved/unwired. Events/jobs domain owner must implement and test those adapters before the W15/W16 gate; no runtime implementation is included in this tests/docs PR. |
| `Feature/Console/QueuePoisonProbeTest.php` | **Dropped:** a legacy staging probe tool, not a product contract; poison rows surface as `/up` `failed` counts (`test/up.test.ts`). |
| `Feature/Events/TerminalSyncRefusalTest.php` | **Ported:** the W15 agent-events slice ([TOG-10121](/TOG/issues/TOG-10121), done): terminal bot refusal fails now and marks the ledger row failed (`test/jobs.test.ts`), shield/contract rows in `test/agent-events.test.ts` / `test/agent-events-shield.test.ts`. |
| `Feature/Admin/EventRsvpRosterTest.php` | **Ported:** roster reads in `test/roster.test.ts` (11) and `test/admin-reads.test.ts`. |
| `Feature/Livewire/EventsCalendarTest.php`, `EventsCalendarTimezoneTest.php`, `Feature/HomeUpcomingEventsTest.php` | **Ported (island contract):** `test/islands-events-calendar.test.ts`, `test/islands-past-events.test.ts`, `test/islands-going-count.test.ts` (W10 slices 3-4). Browser-level rows remain W10 / [TOG-9689](/TOG/issues/TOG-9689). |
| `Feature/Events/EventJsonLdTest.php` | **Out of scope:** SEO slice [TOG-10118](/TOG/issues/TOG-10118) (delivered separately, `test/seo.test.ts`). |

## Previously omitted files and adjacent-slice dispositions

These are explicit **file dispositions**, not a claim that a partial suite ports
all assertions in the source file. Deferred proof remains owned by QA under
[TOG-9697](/TOG/issues/TOG-9697) unless the row names a separate feature owner.
Application gaps require that domain owner's implementation before QA can pass.

| Legacy test file | Disposition and proof or remaining contract |
|---|---|
| `Feature/Events/EventJsonContractTest.php` | **Gap: exact consumer wire contract.** `test/events.test.ts` exercises CRUD, but does not pin the ordered key set/no database id, nullable keys, every field type, going-only/zero aggregates, all status values, moderator-vs-member listings, stable earliest-first ties and `synced_to_discord` derivation. QA must add a dedicated JSON contract suite; a CRUD round-trip is not equivalent. |
| `Feature/Events/DraftIcsConditionalAuthorizationTest.php` | **Partial/gap.** `test/event-feeds.test.ts` pins unconditional draft 403 and published 304. It does not capture a real moderator draft ETag then reuse it as guest/member to prove authorization before conditional success, nor moderator draft empty 304. QA owns those missing conditional-authorization assertions; no inferred security pass. |
| `Feature/Events/EventRssConsumerShapeTest.php` | **Adapted/partial.** `test/event-feeds.test.ts` pins permalink guid stability across rename, UTC summer/winter pubDate bytes, description omission, multibyte titles, draft/cancellation filtering and route cache/ETag behavior. XML parsing and a separately asserted UTC-parsable channel lastBuildDate, plus moderator route parity, remain QA gaps rather than an implied full consumer-shape pass. |
| `Feature/Events/EventTimezoneDisplayTest.php` | **Partial/deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). `test/event-time-validation.test.ts` pins host wall-time conversion; feed fixtures pin UTC exports, and `test/islands-events-calendar.test.ts` covers host-zone month bucketing. The complete DST-paired page/JSON/ICS/Google cross-surface agreement, New York date rollover and Auckland viewer cases are not all ported. |
| `Feature/Events/EventCoverImagesTest.php` | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Reserved layout boxes across index/detail/gone/archive images and the featured admin preview need HTML tripwires. A currently text-only page is not a regression assertion. |
| `Feature/Events/EventGoneTest.php` | **Partial.** `test/events.test.ts` pins cancelled JSON 410 and noindex; SEO coverage is owned by [TOG-10118](/TOG/issues/TOG-10118). Cancelled HTML copy/JSON-LD, unknown-vs-gone distinction, draft noindex on both surfaces and published/past absence of robots signals require dedicated assertions across W10/SEO; not a full file pass. |
| `Feature/Events/EventPageTest.php` | **Deferred page integration to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island RSVP/member-exposure suites cover component/privacy contracts, not every share-page assertion: canonical/title/time/venue/description, guest join pitch vs member RSVP/answer, capacity/over-capacity spots and attendee names hidden from guests. |
| `Feature/Admin/EventEditFoldRoundTripTest.php` | **Partial (G2)/gap.** `test/event-time-validation.test.ts` pins unchanged fold-carrier preservation on both overlap occurrences at the parser boundary. Real edit-route save, deliberate wall-time edits dropping the carrier, and sub-minute precision preservation are unproved; QA/admin owner must add these before full fold-edit parity. |
| `Feature/Admin/EventFillColumnTest.php` | **Deferred admin presentation proof.** Going-only fill counts, uncapped display and full/over-capacity badges need explicit route/render assertions; `test/roster.test.ts` is not proof of this table column. Admin domain owner + QA under [TOG-9697](/TOG/issues/TOG-9697). |
| `Feature/Admin/EventResourceServiceRoutingTest.php` | **Partial.** `test/admin.test.ts` and `test/events.test.ts` exercise CRUD/service effects, but do not collectively assert every host-attribution, UTC conversion and publish/cancel action visibility row. Filament wiring syntax is framework-specific; portable side effects/visibility remain QA/admin gaps. |
| `Feature/Admin/EventTableTimezoneLabelTest.php` | **Deferred admin display proof.** The explicit UTC column label and date rollover across London/New York need rendered-table assertions; form conversion tests do not prove the label. Admin domain owner + QA. |
| `Unit/Events/DiscordEventsReaderTest.php` | **Adapted/partial; reader-owned.** `test/islands-events-calendar.test.ts` exercises the bot read adapter and transient display-only events. The full legacy matrix includes invalid event id/time/name filtering, sanitized outage logging, invalid cache result failure and failure reset after a clean empty read. Any rows not explicitly asserted there remain QA/read-domain gaps; calendar fake-source tests alone are not adapter proof. |
| `Integration/DiscordWriteBackTimingTest.php` | **Gap: commit-before-dispatch.** Queue enqueue mocks in `test/events.test.ts`/`test/rsvp.test.ts` do not prove a real consumer cannot run before commit or for a rolled-back RSVP. QA/jobs owner must observe dispatch/consumption around real SQL commit and rollback; mocked enqueue or correct backoff is not equivalent. |
| `Feature/Jobs/SyncEventToDiscordTest.php` | **Adapted/partial.** `test/events.test.ts` pins message mapping/debounce/backoff and `test/jobs.test.ts` pins retry/terminal behavior. Real event mirror stamp effects and the timing contract above are not implied by orchestration mocks; jobs owner + QA must close those gaps. |
| `Browser/EventClipboardFallbackTest.php`, `Browser/EventLiveSearchBindingTest.php` | **Deferred browser proof to W10** / [TOG-9689](/TOG/issues/TOG-9689): clipboard fallback and real DOM search binding need browser acceptance, not only server/component tests. |
| `Unit/EventCancelModalCopyTest.php` | **Deferred UI contract to W10** / [TOG-9689](/TOG/issues/TOG-9689): cancellation dialog copy/state is not covered by the server transition guard. |
| `Feature/Console/QueueDepthQueryFailureTest.php`, `Feature/Console/QueueDepthUnsupportedDriverTest.php` | **Command dropped; portable failure behavior adapted/partial.** `queue:check-depth` is replaced by `GET /up` (`docs/parity.md` §10); `test/up.test.ts` covers degraded/unknown depth. CLI exit codes and unsupported Laravel driver branches do not apply to the fixed Postgres ledger, but no equivalence to every legacy failure/log assertion is claimed. |
| `Unit/QueuePoisonProbeRoutingTest.php`, `Unit/QueuePoisonProbeRunbookTest.php` | **Dropped legacy tool/runbook implementation**, with `Feature/Console/QueuePoisonProbeTest.php`: Laravel probe routing/runbook text is not shipped by Workers. Queue failure visibility remains the product contract covered by `test/up.test.ts`; this does not waive dead-letter/operator recovery readiness. |
| `Feature/AgentEvents/AgentEventGrantPolicyTest.php`, `Feature/AgentEvents/AgentEventIngressTest.php`, `Feature/AgentEvents/AgentEventReceiptWindowTest.php`, `Feature/AgentEvents/AgentObservationUnavailableTest.php` | **Adjacent slice, not re-ported here.** Agent-events owner [TOG-10121](/TOG/issues/TOG-10121), with `test/agent-events.test.ts` and `test/agent-events-shield.test.ts`. The grant-owned capacity edit noted in A2 remains a gap, not a pass inferred from slice completion. |

## Inventory completeness check

Scope is mechanically selected from the non-truncated Git tree at `2eaefb8d`:
all `Feature/Events/`, `Unit/Events/`, `Feature/AgentEvents/`, `Feature/Admin/Event*`,
event/RSVP Livewire files and `Browser/Event*`, plus the explicitly named home,
waitlist, queue/cron/jobs and integration files in the tables. Unrelated auth,
Discord login/join/funnel and CDN/widget suites belong to their earlier slices.
Every selected path must occur in a **disposition table's identity cell** (the
first cell in core/adjacent mappings, second in A-numbered deferred rows);
abbreviated sibling names resolve only within that row's directory. The audit also verifies
that every table reference exists at the pinned revision. Filename completeness
is not assertion completeness; partial/deferred rows above remain NEEDS WORK.

The machine-readable selected inventory and audit results are attached to
[TOG-10994](/TOG/issues/TOG-10994), alongside the reviewer-response evidence.

## Recorded notes for reviewers

1. **Fold direction changed on main.** Main PR #64 (`4cb024d`) changed
   `wallToUtc` to the **first (BST) occurrence** and independently pins that
   behavior in `test/admin-validation.property.test.ts`. Legacy pinned
   `2026-10-25 01:30` → `01:30:00 UTC` (second/GMT occurrence,
   `EventTimezoneTest.php:295-300`); current Next returns `00:30:00 UTC`.
   This refresh adapts the fresh-parse assertions, preserves exact edit
   carriers on both sides, and removes the now-obsolete comment correction.
   `src/admin/validation.ts` is identical to refreshed main. The legacy fold
   divergence remains NEEDS WORK; no waiver or runtime change is included.
2. **Clock-only fakes.** DB tests that need a moving clock fake only `Date`
   (`vi.useFakeTimers({ toFake: ["Date"] })`); full fake timers hang the
   postgres-js driver's socket timers.
3. **Test database.** The suite runs against the per-card database
   `two_web_next_tog10789` on `agent-testdb` (house convention; migrations
   applied from `drizzle/`). CI uses its own service containers. No staging or
   production database was touched.

## Verification

Historical baseline, verified by the reviewer at `a76cdb69`:

```
npm run check (CI run 36773387443, disposable Postgres) # 50 files, 757 passed, 10 skipped
```

The main-refresh fix is checked locally in a run-owned disposable database on
`agent-testdb` (user `agent_test`, empty password), with migrations from
`drizzle/`, both TypeScript targets, and the feed/time-validation/index suites.
CI retains its own disposable Postgres job for required checks. Executed counts,
full SHA and current check state are recorded on the same review card; historical
green is not approval. No staging or production probes or deployment are included.

Legacy inventory: `gh api repos/TogetherWeOwn/two-web/git/trees/<sha>?recursive=1`
at `2eaefb8d` (203 `*Test.php` files; 141 Feature / 43 Unit / 15 Browser / 4 Integration).
