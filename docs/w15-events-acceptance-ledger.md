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
| G1 wall-time ⇄ UTC, DST gap/fold, IANA + offset + impossible-date rejection | `test/event-time-validation.test.ts` | 9 | **Partial/adapted:** `Feature/Events/EventTimezoneTest.php`, incl. 2026 gap shoulders. Fresh fold parses select the second, GMT occurrence, as legacy did (`EventTimezoneTest.php:295-300`; TOG-11669 reverses main PR #64's first-occurrence choice). Legacy's moved-forward gap time (`2026-03-29 02:30` → `01:30:00 UTC`) is still refused in Next; that gap-time divergence stays open, outside TOG-11669. |
| G2 event-form floor + fold carrier | `test/event-time-validation.test.ts` | 7 | `EventCapacityFloorTest.php` **form-floor half**, TOG-6805 carrier both sides, `EventService::transitionTo` guard |
| G3 RSS item-edge bytes (no description, guid stability, DST pubDate, multibyte) | `test/event-feeds.test.ts` | +3 | `Feature/Events/EventRssTest.php` edge rows, `EventIcsTest.php` folding |
| G4 feed expiry rotates validators with no write | `test/event-feeds.test.ts` | +2 | `Feature/Events/FeedExpiryValidatorTest.php` (one case per RSS/ICS: a valid two-hour event is included exactly at `ends_at`, one second later drops out; original ETag → 200 + changed validator, new ETag → empty 304; persisted row unchanged; per-event ICS still serves) |
| G5 hot-path index presence | `test/schema-hot-path.test.ts` | 2 | `Feature/Events/HotPathIndexTest.php` **index-presence half** (`pg_indexes` introspection) |

Reviewed baseline at `a76cdb69`: **50 test files, 757 passed, 10 skipped**
(CI run 36773387443, disposable Postgres service container). The review fix
splits G4 into two independently executed cases (+1 test; feed suite 12 rather
than 11). New-head executed counts belong to its CI evidence on
[TOG-10994](/TOG/issues/TOG-10994); the baseline is not a new-head pass.

## Application-gap dispositions — A1/A2 follow-up

The original W15 audit slice was test/fixture/docs only. Its application follow-up,
[TOG-10813](/TOG/issues/TOG-10813) (PR #72), adds the ended-draft refusal and
count-bearing occupied-seat errors with `test/event-mutation-invariants.test.ts`.
It reuses main's locked Going count and preserves waitlist promotion, recurrence,
and RSVP pause/reopen behavior. Reviewed QA coverage and the G1 fold divergence
above are unchanged; this application proof is not a full W15/W16 parity pass.

Author-repair verification (2026-10-01, merged main `2618adce`): **11 targeted
files, 217 passed, zero skipped**, using `agent-testdb` disposable fixture schemas.
The first run covered mutation invariants, event-time validation, RSVP, waitlist,
RSVP toggles and admin validation properties (146); the second covered admin
form errors, recurrence, sub-minute recurrence, gap duration and ICS revisions
(71). `npm run typecheck` and the application diff check against that main
baseline passed. Exact-head CI and independent merge approval remain on
[TOG-10929](/TOG/issues/TOG-10929), not inferred from local tests.

| Row | Gap | Evidence |
|---|---|---|
| A1 | **Ported:** ended-draft publish refusal | `transitionEvent` in `src/admin/store.ts` checks persisted `endsAt < Date.now()` after acquiring the event-row lock, with the exact legacy "An event that has already ended cannot be published. Update its dates first." error. `test/event-mutation-invariants.test.ts` proves JSON/admin 422, unchanged event/RSVP/audit rows and no announcement, equality/future publication, legal ended-draft cancellation, a clock advancing during a real lock wait, and a concurrently committed end-time edit. |
| A2 | **Adapted/partial:** occupied-seat edit floor | `updateEvent` in `src/admin/store.ts` reuses main's event-row lock and fresh `goingCount`, adding the occupied-seat count to the capacity error. `test/event-mutation-invariants.test.ts` proves JSON/admin refusal below Going from finite/unlimited capacity, unchanged event/RSVP/audit rows and no write-back, equality/higher/unlimited acceptance, non-Going controls, a title-only PATCH retaining capacity, stale-form recount and a concurrently committed seat behind the RSVP lock. Accepted edits preserve main's waitlist promotions. `test/rsvp-waitlist.test.ts` also pins the count-bearing JSON/admin errors. G2 remains parser-only proof. **Remaining gap:** agent-grant-owned shrink path; no pass inferred from moderator/admin tests. |

The series-child variant (`Integration/EndedDraftSeriesPublicationTest.php`)
and the agent-grant shrink row (`EventCapacityFloorTest` line 82) follow the
series (W13) and agent-events grants respectively — see defers below.

## Deferred and dropped rows

| Row | Legacy file(s) | Disposition |
|---|---|---|
| A3 waitlist | `Feature/WaitlistTest.php` (515 lines) | **Implemented/partial legacy mapping.** `test/rsvp-waitlist.test.ts` proves waitlist joins, no Going seat consumed, FIFO positions/promotion and position-validator changes; `test/rsvp.test.ts:406-414` pins full-event 201 on creation / 200 on repeat. `test/rsvp.test.ts:355-362` proves fourteen concurrent new Going requests all return 201: three Going and eleven Waitlisted for three seats, not capacity 409. **Narrow UI port:** legacy `records a waitlisted answer when the member joins the line` and `keeps the place in line when the freed seat goes to somebody else first` at `2eaefb8d` require no full-refusal copy beside the settled position. `test/islands-rsvp-binder.test.ts:410-462,812-848,1039-1053` pins position/Leave with no false Going or `event-full` after join, claim loss/conflict and accepted capacity refresh, while preserving the full-event join invitation after leaving. `test/islands-rsvp-button.test.ts:442-463` pins full-holder SSR, including paused RSVP; `test/islands-rsvp-binder.test.ts:464-523` retains the mounted/deferred polite claim-loss note and stale-note guard from PR #493. **Server gap retained:** full-event Going 201/200 auto-waitlisting versus legacy 409 remains a requested, not approved, divergence (`docs/parity.md`, Waitlist service contract); the withdrawal/newcomer SQL race does not establish the legacy waitlisted-claimant race. No server semantics change or waiver is inferred. **Remaining gap/deferred to W10:** other dedicated browser/Livewire affordance, broadcast and accessibility assertions; no full-file UI pass. Historical pending-feature prose in `docs/parity.md` is not current implementation evidence. |
| A4 page composition | `Feature/Events/EventPrevNextTest.php`, `EventRelatedTest.php`, `EventCopyLinkTest.php` | **Deferred to W10** under [TOG-9689](/TOG/issues/TOG-9689): prev/next and related rails and the copy-link affordance are page-composition work, not CRUD/RSVP/feeds acceptance. |
| A5 anonymous card cache | `Feature/Events/AnonymousEventCardCacheTest.php` (TOG-9277) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689): depends on the anonymous card-cache design, not yet implemented in Next. |
| A6 EXPLAIN access paths / production planner | `Feature/Events/HotPathIndexTest.php` (61-229) | **Adapted: existing real-SQL access-path proof.** `test/hot-path-indexes.test.ts:12-18,78-90` pins legacy-named event/RSVP definitions (`rsvps_event_id_status_index`, `rsvps_unsynced_event_id_index`, `events_ends_at_index`, `events_starts_at_id_index`); `:135-187` exercises EXPLAIN for Going counts, waitlist, unsynced lookup, upcoming, archive and neighbour query shapes. G5's `test/schema-hot-path.test.ts` adds presence checks, not the only index proof. **Narrow W16 deferral:** these tests force `enable_seqscan = off`, proving usable index access paths rather than production cost superiority. Representative production-planner acceptance remains unproved; the index set and EXPLAIN half are not wholly absent or deliberately incompatible with legacy. |
| A7 bounded reads and aggregates | `Feature/Events/EventQueryCountTest.php` | **Deferred, portable acceptance gap; not dropped.** Legacy asserts fewer than five SQL round trips with ten featured rows on home and ten events on the JSON collection, correct `going_count = 3` on every collection row, and a single-event going count excluding maybe. Explicit Drizzle reads do not prove bounded query growth or correct aggregates. QA owns instrumented real-SQL coverage against Next's home, collection and show read paths for the W15/W16 acceptance gate; the existing island count tests are not equivalent proof. |
| A8 deploy drain | `Unit/QueueDrainOnDeployTest.php` | **Dropped.** Legacy pins a Coolify post-deploy `php artisan queue:restart` (TOG-7288). Workers deploys are atomic; the queue lives in the Postgres ledger and `docs/parity.md` §10 records the command as dropped. Health is `GET /up` (`test/up.test.ts`, 9 tests). |
| A9 series/recurrence | `Feature/Events/RecurringEventsTest.php`, `Unit/Events/RecurrenceScheduleTest.php`, `Integration/EndedDraftSeriesPublicationTest.php` | **Deferred to the W13 series card** (`events:reconcile` materialization; existing card in the TWO Web Next project). `events_parent_event_id_idx` presence is pinned by G5. |
| A10 browser RSVP integration | `Browser/EventsRsvpTest.php`, `Feature/Livewire/RsvpButtonTest.php` (browser half) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island-level contract coverage exists (`test/islands-rsvp-button.test.ts`, 29 tests; server halves in `test/rsvp.test.ts`), but the browser-level integration row is the parent card's. |

## Core file mapping (existing proof and remaining contracts)

| Legacy test file | Disposition and Next proof |
|---|---|
| `Feature/Events/EventTimezoneTest.php` | **Partial/adapted (G1):** both DST sides, round-trip, UTC zone, IANA/offset/impossible-date rejection, gap + shoulders, with the unchanged fold-carrier rule of TOG-6805 (G2) in `test/event-time-validation.test.ts`. Current Next's fresh fold parse selects the second (GMT) occurrence like legacy (`2026-10-25 01:30` → `01:30:00 UTC`, TOG-11669, pinned in `test/event-time-validation.test.ts`, `test/admin-validation.property.test.ts` and through `POST /events` in `test/event-fold-display-agreement.test.ts`). Page-render display is the W10 islands drift net (`test/islands-events-calendar.test.ts`). |
| `Feature/Events/EventCapacityFloorTest.php` | **Adapted/partial (G2, A2):** parser form-floor rows remain in `test/event-time-validation.test.ts`. `test/event-mutation-invariants.test.ts` and `test/rsvp-waitlist.test.ts` prove the locked Going-only floor on JSON/admin edits, count-bearing errors, no mutation/write-back on refusal, equality/higher/unlimited acceptance and stale-form/concurrent recount. **Remaining gap:** grant-owned shrink assertions; no full-file pass is inferred. |
| `Feature/Events/EndedDraftPublicationTest.php` | **Ported (A1):** `test/event-mutation-invariants.test.ts` proves expired-draft refusal with the exact legacy reason, lock-before-clock/persisted-date races, strict boundary and ended-draft cancellation. Cancelled-terminal and draft-only-publish guards remain in `test/event-time-validation.test.ts` ("status transition guard"). |
| `Feature/Events/FeedExpiryValidatorTest.php` | **Ported (G4):** `test/event-feeds.test.ts` table-driven "%s drops an expired event… no write after ends_at": RSS and ICS equality inclusion, one-second expiry, original validator miss, new validator hit, persisted full-row equality, per-event ICS still 200. |
| `Feature/Events/HotPathIndexTest.php` | **Adapted (G5, A6):** `test/schema-hot-path.test.ts` presence checks plus `test/hot-path-indexes.test.ts:78-90,135-187` legacy-named definitions and real-SQL EXPLAIN access-path assertions. Forced `enable_seqscan = off` is a usability proof, not a production cost/planner pass; only that representative production-planner acceptance remains deferred. |
| `Feature/Events/EventsFeedTest.php`, `EventIcsTest.php`, `EventRssTest.php`, `EventGoogleCalendarTest.php` | **Ported feed surfaces:** byte fixtures + route policy in `test/event-feeds.test.ts` (12 cases after the G4 review fix): ICS folding/escaping/CANCELLED, RSS escaping + description omission, guid stability across rename, DST pubDate, multibyte round-trip, webcal swap, sessionless ETag/304, drafts never exposed, cancelled excluded from RSS but in ICS. |
| `Feature/Events/EventEtagTest.php` | **Partial: feed and unchanged JSON validators only.** `test/event-feeds.test.ts` pins sessionless feed 304; `test/events.test.ts:159-166` proves unchanged authenticated JSON 304, and `test/rsvp-waitlist.test.ts` proves waitlist-position invalidation. **JSON gaps:** the pinned legacy title-edit invalidation (`EventEtagTest.php:32-46`) and member-versus-moderator validator separation when drafts are visible (`:48-64`) are not proved by those cases. QA/events owner must add dedicated JSON assertions; feed ETags and waitlist invalidation do not port these contracts. |
| `Feature/Events/EventJsonAccessTest.php` | **Partial: authenticated JSON collection only.** `test/events.test.ts:151-158` proves `/events.json` guest 401, authenticated member 200 with a published row/zero going count, and authenticated ETag 304. The draft 403 / unknown-malformed 404 assertions in `test/event-feeds.test.ts` target **ICS**, not JSON, and are not JSON access proof. **Gap:** the browser guest redirect, member visibility of published/cancelled/past but not draft, moderator visibility of all statuses, member-forbidden/moderator-readable draft show, and exact field allowlist/no internal-id leakage are not asserted by that JSON round-trip. QA/events owner must add dedicated JSON access/contract coverage (see `EventJsonContractTest.php` below); no full-file authorization or allowlist pass is claimed. |
| `Feature/Events/EventLifecycleTest.php`, `EventPolicyTest.php` | **Ported mapped lifecycle/policy contracts:** `test/events.test.ts` (7 tests): CRUD + publish/cancel round-trip with write-back enqueued, forged-origin 403, wall→UTC PATCH, cancelled republish 422, 410 + `x-robots-tag` noindex (`events.test.ts:167-168`); transition guard G2 above. |
| `Feature/Events/EventKeyTest.php` | **Partial: ULID shape and ordinary-update round-trip.** `test/events.test.ts` asserts a generated ULID route key and continues using that key after edits. **Gaps:** dedicated deliberate key-write refusal with persisted-key immutability, and SQL-enforced uniqueness (`EventKeyTest.php:31-47`). A generated shape/ordinary update is not proof of either invariant; QA/events owner must assert both portable contracts. |
| `Feature/Events/EventScheduleTest.php` | **Partial: valid schedule, form conversion and admin validation.** `test/events.test.ts` proves a valid CRUD schedule; G1/G2 pin wall⇄UTC, DST and parsing. `test/admin-event-form-errors.test.ts:103-131` proves create/edit missing-end and end-before-start field errors, HTTP 422 and no writes; `test/admin-validation.property.test.ts:167-179` pins strict resolved-UTC ordering, including equality rejection. **Gaps:** dedicated real-SQL rejection of null `ends_at` (`EventScheduleTest.php:16-26`) and JSON-route missing/end-not-after-start field validation (`:29-55`). NOT NULL schema declarations or a generic bad-create 422 for empty title do not exercise these assertions. **Migration disposition:** Laravel Artisan path-specific rollback/reapply and old-schema column assertions (`:58-90`) are framework-specific/dropped, not executed here. Portable legacy-row backfill (ULID/default UTC/end time/start preservation) and game persistence (`:92-96`) are not proved by this mapped schedule coverage; no pass is inferred from migration execution or valid form conversion. |
| `Feature/Events/EventPaginationTest.php` | **Gap: portable JSON pagination contract.** Legacy `/events.json` asserts default twenty, earliest-first `starts_at` ordering, `per_page` and page traversal without repeats/omissions, `meta.current_page`/`per_page`/`total`, and cap 100. The `/events/past` HTML test is not proof of this JSON surface. Current `src/events/routes.tsx:203-207` instead accepts `limit` and returns `{data,page,limit}`; `src/events/reads.ts:113-120` orders starts descending. These differences are not an authorized parity disposition. QA/events owner must implement and assert the legacy JSON contract or obtain an explicit authorized divergence before the W15/W16 gate; JSON-contract stable tie coverage also remains a gap below. |
| `Feature/Events/PastEventsArchiveTest.php` | **Ported: HTML archive contract.** `test/events.test.ts:182-206` requests `/events/past` and proves twenty newest-first eligible rows, stable tie-break, page count/traversal, excluded statuses, no RSVP controls and an out-of-range state. This does not cover `/events.json` pagination. |
| `Feature/Events/EventSearchTest.php`, `EventSearchLogTest.php` | **Ported:** `test/event-search.test.ts` (22 tests: tokenization, ranking, logging, admin widget). |
| `Feature/Events/RsvpAuthGateTest.php`, `RsvpEndedEventTest.php`, `RsvpPauseTest.php` | **Ported:** `test/rsvp.test.ts` (30 tests): guest 401 / foreign-origin 403 / bad status 422 / other verbs 405 / foreign `user_id` 403; 201/200/204 with mirror-stamp reset; draft/cancelled/ended/paused refuse PUT writing nothing; honeypot rows. Its successful queue recorder is not bot-outage/recovery proof. |
| `Feature/Events/RsvpWriteBackFailureTest.php` | **Partial seams / integration gap.** `test/rsvp.test.ts:55-68` records successful enqueue only; `test/events.test.ts` pins an enqueue failure, `test/jobs.test.ts` pins mocked retries, and `test/islands-rsvp-button.test.ts:126-139` pins pending/synced copy. None joins a failed bot transport to a persisted RSVP and the member view, then retries the same operation/row through real mirror stamps and a synced member view. **Unproved chain:** outage releases rather than fails; RSVP/seat stays saved with null sync stamp and no false event mirror; member sees confirmed/pending rather than save failure while retry is outstanding; recovery stamps event/RSVP and switches that member view to synced. QA/jobs/events owner must add that same-row SQL + job + member-view integration, including the pending-without-retry case, before full parity. The real-mirror and commit-before-dispatch gaps below remain open; separate seam passes are not equivalent. **Update (TOG-11705):** `test/real-mirror-timing.test.ts` now proves outage → saved RSVP with null stamp and pending PUT answer → same-key retry → real `pgEventStore` event/RSVP stamps on the same rows, plus re-answer returning to pending. The member "synced" view has no read endpoint (only the PUT answer, which resets the stamp), so synced is asserted at the stamp the answer would serialize; the producer `SyncMessage` → consumer `QueueMessage` wiring is still unproved. **Update (TOG-11984):** `src/jobs/envelope.ts` `toQueueMessage` maps the W8 `event.upsert` carrier onto the sync-event job with the producer's idempotency key unchanged (`event.cancel` stays unrecognized), and `test/rsvp-writeback-recovery.test.ts` delivers the exact `SyncMessage` the RSVP PUT enqueued through the real `consume()` onto `pgEventStore`/`pgUniqueLock`/`pgQueueLedger` rows: a bot outage releases with the first backoff (no ack, no failure), the RSVP stays on the same row with a null stamp, no Discord id and the syncing copy; the same carrier's redelivery stamps event and RSVP and the answer flips to synced. Pending without retry: a last-try outage acks, the seat stays saved and pending (never the save-failure copy), and `staleEventKeys` still selects the event for reconcile. **Update (TOG-10815):** producers now enqueue the tracked W13 carrier directly on the provisioned `SYNC_EVENT_QUEUE` (unique lock, 10 s debounce, build-time idempotency key); the `EVENT_SYNC_QUEUE` stub is removed. The W8 `toQueueMessage` mapping stays for in-flight pre-integration carriers. The recovery proof above runs against the same carrier the RSVP PUT enqueued. |
| `Feature/Events/RsvpUniqueLockRaceTest.php`, `Integration/RsvpCapacityRaceTest.php` | **Ported/adapted:** `test/rsvp.test.ts:343` (40 concurrent writes by one member → exactly 12 budget), `:355-362` (14 new member writes chase 3 seats → all 14 return 201, exactly 3 Going / 11 Waitlisted), `:373` (double-submit → one row). Real Postgres, real SQL locking; over-capacity writes join the waitlist rather than returning the historical 409 `event_at_capacity`. FIFO/promotion/position proof is in `test/rsvp-waitlist.test.ts` (A3). |
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
| `Feature/Events/EventTimezoneDisplayTest.php` | **Partial/deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). `test/event-time-validation.test.ts` pins host wall-time conversion; feed fixtures pin UTC exports, and `test/islands-events-calendar.test.ts` covers host-zone month bucketing. `test/event-fold-display-agreement.test.ts` (TOG-11669) proves Europe/London 2026 DST-paired agreement for both spring gap shoulders and both fold occurrences: the show page's `<time datetime>` and wall-clock text, `/events.json`, per-event and collection ICS `DTSTART`/`DTEND` and the Google `dates=` link all carry the stored instant. **Remaining:** the show page's visible text has no zone abbreviation, so the two fold occurrences read identically (`01:30`); the 20:00 both-sides matrix, New York date rollover and Auckland viewer cases are not ported. |
| `Feature/Events/EventCoverImagesTest.php` | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Reserved layout boxes across index/detail/gone/archive images and the featured admin preview need HTML tripwires. A currently text-only page is not a regression assertion. |
| `Feature/Events/EventGoneTest.php` | **Partial.** `test/events.test.ts` pins cancelled JSON 410 and noindex; SEO coverage is owned by [TOG-10118](/TOG/issues/TOG-10118). Cancelled HTML copy/JSON-LD, unknown-vs-gone distinction, draft noindex on both surfaces and published/past absence of robots signals require dedicated assertions across W10/SEO; not a full file pass. |
| `Feature/Events/EventPageTest.php` | **Deferred page integration to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island RSVP/member-exposure suites cover component/privacy contracts, not every share-page assertion: canonical/title/time/venue/description, guest join pitch vs member RSVP/answer, capacity/over-capacity spots and attendee names hidden from guests. |
| `Feature/Admin/EventEditFoldRoundTripTest.php` | **Ported (G2).** `test/event-time-validation.test.ts` pins fold-carrier preservation on both occurrences at the parser boundary. `test/event-fold-edit-roundtrip.test.ts` (#249, re-pinned by TOG-11669) proves the real edit route on agent-testdb/CI Postgres: unchanged saves keep either occurrence, sub-minute precision survives on both, and deliberate wall edits drop the carrier to the fresh second-occurrence parse. |
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

1. **Fold direction restored to legacy for single events (TOG-11669).** Main PR #64
   (`4cb024d`) had changed `wallToUtc` to the **first (BST) occurrence**.
   Legacy pinned `2026-10-25 01:30` → `01:30:00 UTC` (second/GMT occurrence,
   `EventTimezoneTest.php:295-300`). TOG-11669 makes `wallToUtc` default to the
   latest round-tripping candidate, so fresh single-event parses again return
   `01:30:00 UTC`. Unchanged edits still keep the exact stored instant on either
   side through the TOG-6805 carriers. Series are unaffected: `preciseWallToUtc`
   (`src/admin/recurrence-wall.ts`) asks for the earlier occurrence, keeping the
   seed's offset the way legacy `addWeeks` does (`test/recurrence-subminute.test.ts`
   pins restored); the `src/admin/recurrence.ts:43-44` "first occurrence" comment
   still describes series. **Remaining:** GMT-seeded series (a seed stored on the
   GMT side whose slot lands in the fold) is unproved.
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
