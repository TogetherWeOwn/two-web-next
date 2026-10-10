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
| G1 wall-time ⇄ UTC, DST gap/fold, IANA + offset + impossible-date rejection | `test/event-time-validation.test.ts` | 9 | **Ported:** `Feature/Events/EventTimezoneTest.php`, incl. 2026 gap shoulders. Fresh fold parses select the second, GMT occurrence, as legacy did (`EventTimezoneTest.php:295-300`; TOG-11669 reverses main PR #64's first-occurrence choice). Gap refusal is parity, not a divergence: legacy refuses true gap walls with a 422 (`EventTimezoneTest.php:169-188` create, `:190-205` end, `:269-286` update, `:288-293` domain edge via `RealWallTime` + `EventInput::instant` backstop) and maps the `2026-03-29 02:30` shoulder to `01:30:00 UTC` (`:247-267`, `:295-300`); Next matches on the single-event path with a 422 naming the gap (`test/event-time-validation.test.ts:59`, `test/gap-time-divergence.test.ts:40-59`) while the series path moves the gap week forward by the gap length (`test/gap-time-divergence.test.ts:81-103`, `src/admin/recurrence.ts:51-62,102-103`, matching legacy Carbon `addWeeks` in `RecurrenceSchedule.php:62-65`). Outside TOG-11669. |
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
| A2 | **Adapted:** occupied-seat edit floor | `updateEvent` in `src/admin/store.ts` reuses main's event-row lock and fresh `goingCount`, adding the occupied-seat count to the capacity error (`src/admin/store.ts:291`). `test/event-mutation-invariants.test.ts` proves JSON/admin refusal below Going from finite and unlimited capacity (`:274-297`) with unchanged event/RSVP/audit rows and no write-back; equality/higher/unlimited acceptance, non-Going answers not raising the floor and the waitlist settling after accepted edits (`:299-330`); a title-only PATCH retaining capacity (`:332-339`); a stale-form recount (`:341-360`); and a concurrently committed seat behind the RSVP lock (`:445-488`). `test/rsvp-waitlist.test.ts:590` also pins the count-bearing JSON/admin errors. The agent-grant-owned shrink path is proved by `test/grant-shrink.test.ts`: a shrink below Going is a 422 `validation_failed` carrying the legacy sentence on a published, RSVP-open event with vacant seats and stamped Going/Maybe/Waitlisted answers. Complete event and RSVP rows, plus every fixture idempotency row (including NULL-event-key records), remain unchanged despite distinguishable edits to the other event fields; one denied audit row is recorded and no refusal write-back is dispatched (`:72-76,96-137`); equality at five occupied seats, higher and unlimited grant edits succeed with persisted capacity/version assertions (`:139-161`); a concurrently committed sixth seat makes a shrink to five fail (`:183-220`, outcome proof, not an observed lock-wait assertion); the mounted `POST /api/agent-events` route refuses end to end with no queue send (`:222-267`). **Difference from legacy:** JSON/admin errors append " Occupied seats: N."; the grant path returns the legacy sentence verbatim (`src/agent-events/service.ts:900-907`). No remaining gap for this row. |

The series-child variant (`Integration/EndedDraftSeriesPublicationTest.php`)
follows the series (W13) — see defers below. The agent-grant shrink row
(`EventCapacityFloorTest` line 82) is proved by `test/grant-shrink.test.ts` (A2).

## Deferred and dropped rows

| Row | Legacy file(s) | Disposition |
|---|---|---|
| A3 waitlist | `Feature/WaitlistTest.php` (515 lines) | **Partial/adapted; the server non-seat preservation gap is closed, the UI full-refusal gap is closed.** Server contract: `test/rsvp-waitlist.test.ts` proves Going on a full event answering 201/200 waitlisted with a position and no seat (`:267`), non-seat answers preserving a stamped waiter beside a vacancy (`:290-331`: nine cases covering the five legacy `WaitlistTest.php:322-351` rows plus complementary Maybe/NotGoing cases, asserting the waiter's full row — id, legacy id, status, FIFO timestamps and mirror stamp — unchanged with position 1 and only the holder Going), new Going and explicit waitlist requests settling an earlier waiter first (`:333-370`), the stale-view explicit waitlist answer taking a vacant seat first (`:372`), a Going newcomer never bypassing an accepted queue beside a vacancy (`:391`), FIFO position keys on the DB clock (`:410`, `:490`, `:506`), withdraw promoting the head in its own commit with the head's mirror stamp cleared (`:428`), leaving the line compacting without promotion (`:449`), seat-releasing re-answers settling the line while preserving the promoted row's identity and the next stamped waiter (`:459-478`), the former holder as the only waiter getting the settled Going answer (`:480`), cap-raise promotion on JSON and admin edits (`:515`), the JSON/admin cap floor refusing below Going (`:578-603`), closed events retaining both waiter identities and complete rows (including FIFO timestamps and mirror stamps) and refusing both Going and explicit waitlisted joins (`:639-662`) and the concurrent withdraw + Going race (`:902-938`). `test/rsvp.test.ts:583-594` pins full-event Going writes as 201 on creation / 200 on repeat, both waitlisted, and `:516-529` proves fourteen concurrent new Going requests all return 201: three Going and eleven Waitlisted for three seats, not capacity 409. **Documented divergence:** legacy refused Going on a full event with 409 `event_at_capacity`; Next answers with a waitlisted row. **Closed server gap (merged PR #507, `de51911c`):** legacy `Feature/WaitlistTest.php:322-351` requires an answer that releases no occupied seat (including Going → Going) not to promote an existing waiter or clear their mirror stamp, even beside a vacancy. `src/events/rsvp.ts:108-111` now calls `promoteWaitlist` only when the write releases a Going seat or its settled status is Waitlisted, so non-seat answers and Going re-answers leave the line untouched while new seat requests still settle FIFO, including explicit stale-view joins. This row is not a parity pass or waiver for the remaining documented 409 adaptation above. UI affordances: `test/islands-rsvp-button.test.ts` pins full copy + join with no Going button (`:414`), fallback position + claim + leave (`:438`), the place in words and digits (`:161`), the broadcast states (`:168`), the focus target (`:234`) and a `role="status" tabindex="-1"` position line that is never an alert (`:469`); `test/islands-rsvp-binder.test.ts` at audited snapshot `bc78e18b` pins the claim without stale controls (`:370`), a lost claim keeping the line (`:382`), joining after a capacity conflict with the position focused, announced as status and broadcast as `waitlisted` (`:400`), a Going request answered waitlisted (`:426`), a join settled to Going confirming and broadcasting `going` (`:436`), the full copy kept after joining (`:701`, superseded by the settled-line proof below) and a paused holder leaving without reopening joins or claims (`:711`). **Subsequent merged note proof:** [PR #493](https://github.com/TogetherWeOwn/two-web-next/pull/493), squash revision `dcd5a205`, restores `Someone just took that seat.`. [`test/islands-rsvp-binder.test.ts:410-475` at that revision](https://github.com/TogetherWeOwn/two-web-next/blob/dcd5a2056af66d56e9a179631738316a96941b22/test/islands-rsvp-binder.test.ts#L410-L475) pins the polite note, retained position and Leave control, no stale claim/false confirmation, and a deferred update of the empty mounted region without moving focus; `:477-489` pins clearing a pending note. **UI settled-line proof:** legacy `Feature/WaitlistTest.php`'s claim-race case at `2eaefb8d` requires no full-refusal copy beside the member's settled waitlist position. `test/islands-rsvp-binder.test.ts:835-870` pins a full-event join replacing the invitation with the focused position and Leave control (no `event-full`, claim, Going confirmation or join action), an accepted capacity refresh keeping that state, and the full invitation returning only after leaving; `:410-462` pins claim loss and claim conflict keeping the position and Leave control with no refusal copy or false Going; `:464-523` retains the deferred polite claim-loss note and stale-note guard from PR #493; `test/islands-rsvp-button.test.ts:442-462` pins full-holder SSR without refusal copy, including paused RSVP. Guest, Going and capacity behavior before joining and after leaving is unchanged. No UI divergence is claimed or approved; this row stays Partial for the documented 409 adaptation and the A10 browser deferral. Browser-level Livewire/Playwright integration stays with A10; historical pending-feature prose in `docs/parity.md` is not current implementation evidence. |
| A4 page composition | `Feature/Events/EventPrevNextTest.php`, `EventRelatedTest.php`, `EventCopyLinkTest.php` | **Deferred to W10** under [TOG-9689](/TOG/issues/TOG-9689): prev/next and related rails and the copy-link affordance are page-composition work, not CRUD/RSVP/feeds acceptance. |
| A5 anonymous card cache | `Feature/Events/AnonymousEventCardCacheTest.php` (TOG-9277) | **Partial/adapted (TOG-18976): home shared cache dropped with measurement; `/events` + `/events/past` use timed expiry with a documented invalidation divergence.** Home (`/`) stays `private, no-store`: staging anonymous `/`, n=20, measured median 175 ms / p95 261 ms TTFB, inside the 600 ms server-response tripwire, so no p95 gain to chase; home is viewer-specific funnel top (guest/member header, hero CTA, one-shot join flash, `?n=` notices, outage fallbacks) where a shared entry risks leaking member state or pinning empty/unavailable states; cost is already bounded (3 capped rows + batched going counts, isolate-local 60 s counts cache, 400 ms statement timeouts + 1000 ms deadline with fallback). Anonymous `/events` cards are `public, max-age=60` with `Vary: Cookie` and proven anonymous with no RSVP write control (`test/guest-calendar-anon.test.ts`); anonymous `/events/past` cards are `public, max-age=300` with no RSVP controls (`test/islands-past-events.test.ts:107-122`). **Documented divergence from legacy:** legacy retired the guest fragment on a model edit and on RSVP land/leave, so going counts never went stale; Next uses timed expiry with no retire on edit or RSVP — guests can read an old title or going count for up to 60 s on `/events` and 300 s on `/events/past`. Pinned by `test/anonymous-event-card-cache-decision.test.ts` (ledger disposition, anonymous private home bodies with no session data, flash/notice variants private, `/events` + `/events/past` timed-expiry headers). |
| A6 EXPLAIN access paths / production planner | `Feature/Events/HotPathIndexTest.php` (61-229) | **Adapted: existing real-SQL access-path proof.** `test/hot-path-indexes.test.ts:12-18,78-90` pins legacy-named event/RSVP definitions (`rsvps_event_id_status_index`, `rsvps_unsynced_event_id_index`, `events_ends_at_index`, `events_starts_at_id_index`); `:135-187` exercises EXPLAIN for Going counts, waitlist, unsynced lookup, upcoming, archive and neighbour query shapes. G5's `test/schema-hot-path.test.ts` adds presence checks, not the only index proof. **Narrow W16 deferral:** these tests force `enable_seqscan = off`, proving usable index access paths rather than production cost superiority. Representative production-planner acceptance remains unproved; the index set and EXPLAIN half are not wholly absent or deliberately incompatible with legacy. |
| A7 bounded reads and aggregates | `Feature/Events/EventQueryCountTest.php` | **Ported.** `test/events-bounded-reads.test.ts` runs the home (`listHomeUpcoming` + `listVisibleFeatured`), JSON collection (`listJson`) and show (`getPublicEvent`) read paths against real Postgres in a disposable fixture schema, counting Drizzle-issued statements through a logger handle (timeout-scoping `set_config` selects included; transaction BEGIN/COMMIT framing uncounted, matching the legacy query-log semantics). With ten featured/collection rows present the counts are teaser 3, featured 2, collection 4 (total + page + one grouped going aggregate + one batched waitlist-position read, mirroring the route's `waitlistPositions` call over the page rows) and show 2 — each under the legacy fewer-than-five bar — and stay identical when the row sets double, so an extra per-row query fails the suite (a planted N+1 going-count mutant and a planted per-event waitlist mutant each fail the bound assertions). Every collection row carries `going_count = 3` with maybe/not-going/waitlisted answers present, and every row carries the viewer's exact waitlist rank, and the single event carries 2 with its maybe excluded (a planted count-all-statuses mutant fails the aggregate assertions). The production-planner cost half stays with A6; the anonymous card cache stays with A5. |
| A8 deploy drain | `Unit/QueueDrainOnDeployTest.php` | **Dropped.** Legacy pins a Coolify post-deploy `php artisan queue:restart` (TOG-7288). Workers deploys are atomic; the queue lives in the Postgres ledger and `docs/parity.md` §10 records the command as dropped. Health is `GET /up` (`test/up.test.ts`, 9 tests). |
| A9 series/recurrence | `Feature/Events/RecurringEventsTest.php`, `Unit/Events/RecurrenceScheduleTest.php`, `Integration/EndedDraftSeriesPublicationTest.php` | **Deferred to the W13 series card** (`events:reconcile` materialization; existing card in the TWO Web Next project). `events_parent_event_id_idx` presence is pinned by G5. |
| A10 browser RSVP integration | `Browser/EventsRsvpTest.php`, `Feature/Livewire/RsvpButtonTest.php` (browser half) | **Deferred to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island-level contract coverage exists (`test/islands-rsvp-button.test.ts`, 29 tests; server halves in `test/rsvp.test.ts`), but the browser-level integration row is the parent card's. |

## Core file mapping (existing proof and remaining contracts)

| Legacy test file | Disposition and Next proof |
|---|---|
| `Feature/Events/EventJsonContractTest.php` | **Ported:** `test/events.test.ts` pins the exact ordered key set and values (`:537-554` ordered keys, `:555-572` values incl. `synced_to_discord: false`, `waitlist_position: 2`), nullables and no `id` (`:583-601`), member-vs-moderator listing and validator variance (`:604-613`, plus `:576-578` moderator `waitlist_position: null` with rotated ETag), and stable earliest-first ties (`:355-373`). |
| `Feature/Events/DraftIcsConditionalAuthorizationTest.php` | **Adapted:** authorization runs before conditional success on both feed surfaces. Per-event: `test/draft-ics-conditional-authz.test.ts:102-121` replays a real moderator draft ETag as guest/member (including `*`) to a 403 with no ETag, no calendar bytes and no draft title/description; `:123-131` proves an unchanged moderator replay is an empty 304; `:133-150` proves a title edit invalidates the validator and the fresh validator settles to 304. Collection (PR #566, `7ed67665`): `test/draft-feed-collection-conditional.test.ts:140-160` answers a replayed moderator draft validator with the public 200 bytes (never 304, draft bytes or 403); `:162-182` settles the collection's own validator to an empty 304 for guest/member; `:184-196` proves draft edits leave the public validator and bytes unchanged. No remaining gap for this row. |
| `Feature/Events/EventRssConsumerShapeTest.php` | **Adapted/partial.** `test/event-feeds.test.ts` pins permalink guid stability across rename, UTC summer/winter pubDate bytes, description omission, multibyte titles, draft/cancellation filtering and route cache/ETag behavior. XML parsing and a separately asserted UTC-parsable channel lastBuildDate, plus moderator route parity, remain QA gaps rather than an implied full consumer-shape pass. |
| `Feature/Events/EventTimezoneDisplayTest.php` | **Ported:** `test/event-time-validation.test.ts` pins host wall-time conversion; feed fixtures pin UTC exports, and `test/islands-events-calendar.test.ts` covers host-zone month bucketing. `test/event-fold-display-agreement.test.ts` proves Europe/London 2026 DST-paired agreement for both spring gap shoulders and both fold occurrences: the show page's `<time datetime>` and wall-clock text, `/events.json`, per-event and collection ICS `DTSTART`/`DTEND` and the Google `dates=` link all carry the stored instant. `test/event-fold-display-matrix.test.ts` (#362) proves the remaining matrix: 20:00 both-sides agreement on all four DST shoulders (`:35-60` matrix, `:160-197` page/JSON/ICS agreement), shared fold wall text with distinct instants (`:199-241` identical `01:30` main text with distinct offset text, JSON and ICS instants), New York next-day rollover (`:243-275` host 15th wall text and bucket with UTC-day machine surfaces), and the Auckland host bucket (`:277-326` host 15th bucket and chip, never `12:00`). |
| `Feature/Events/EventCoverImagesTest.php` | **Adapted:** reserved layout boxes are pinned as HTML tripwires. `test/event-cover-images.test.ts:113-159` proves the calendar list/month grid, event detail, gone (410) and past archive carry no dimensionless images; `:190-203` reserves an explicit-dimension 16:9 box (`width="640"` `height="360"`, lazy/async, non-empty alt) on the featured admin preview; `:235-261` pins the deployed CSP `img-src` (self + Discord CDN + exact allowlist, never broad sources) with validation/render agreement. No remaining gap for this row. |
| `Feature/Events/EventGoneTest.php` | **Partial.** `test/events.test.ts` pins cancelled JSON 410 and noindex; SEO coverage is owned by [TOG-10118](/TOG/issues/TOG-10118). Cancelled HTML copy/JSON-LD, unknown-vs-gone distinction, draft noindex on both surfaces and published/past absence of robots signals require dedicated assertions across W10/SEO; not a full file pass. |
| `Feature/Events/EventPageTest.php` | **Deferred page integration to W10** / [TOG-9689](/TOG/issues/TOG-9689). Island RSVP/member-exposure suites cover component/privacy contracts, not every share-page assertion: canonical/title/time/venue/description, guest join pitch vs member RSVP/answer, capacity/over-capacity spots and attendee names hidden from guests. |
| `Feature/Admin/EventEditFoldRoundTripTest.php` | **Ported (G2).** `test/event-time-validation.test.ts` pins fold-carrier preservation on both occurrences at the parser boundary. `test/event-fold-edit-roundtrip.test.ts` (#249, re-pinned by TOG-11669) proves the real edit route on agent-testdb/CI Postgres: unchanged saves keep either occurrence, sub-minute precision survives on both, and deliberate wall edits drop the carrier to the fresh second-occurrence parse. |
| `Feature/Admin/EventFillColumnTest.php` | **Adapted:** `test/admin-event-fill-labels.test.ts:177-191` proves Going-only counts (`1 of 4 going`, `0 of 3 going`), uncapped display (`3 going`), and full/over-capacity badges (Full badge without the over-capacity marker at capacity; `3 of 2 going` with Full + Over capacity markers above it). No remaining gap for this row. |
| `Feature/Admin/EventResourceServiceRoutingTest.php` | **Partial.** `test/admin.test.ts` and `test/events.test.ts` exercise CRUD/service effects, but do not collectively assert every host-attribution, UTC conversion and publish/cancel action visibility row. Filament wiring syntax is framework-specific; portable side effects/visibility remain QA/admin gaps. |
| `Feature/Admin/EventTableTimezoneLabelTest.php` | **Adapted:** `test/admin-event-fill-labels.test.ts:112-175` proves the explicit UTC column label in the header and sort toggle, UTC instants inside `<time datetime>` bytes, identical UTC bytes for one instant in London/New York (rollover), and a New York evening wall time rendering as the UTC date. No remaining gap for this row. |
| `Unit/Events/DiscordEventsReaderTest.php` | **Adapted/partial; reader-owned.** `test/islands-events-calendar.test.ts` exercises the bot read adapter and transient display-only events. The full legacy matrix includes invalid event id/time/name filtering, sanitized outage logging, invalid cache result failure and failure reset after a clean empty read. Any rows not explicitly asserted there remain QA/read-domain gaps; calendar fake-source tests alone are not adapter proof. |
| `Integration/DiscordWriteBackTimingTest.php` | **Gap: commit-before-dispatch.** Queue enqueue mocks in `test/events.test.ts`/`test/rsvp.test.ts` do not prove a real consumer cannot run before commit or for a rolled-back RSVP. QA/jobs owner must observe dispatch/consumption around real SQL commit and rollback; mocked enqueue or correct backoff is not equivalent. |
| `Feature/Jobs/SyncEventToDiscordTest.php` | **Adapted/partial.** `test/events.test.ts` pins message mapping/debounce/backoff and `test/jobs.test.ts` pins retry/terminal behavior. Real event mirror stamp effects and the timing contract above are not implied by orchestration mocks; jobs owner + QA must close those gaps. |
| `Browser/EventClipboardFallbackTest.php`, `Browser/EventLiveSearchBindingTest.php` | **Deferred browser proof to W10** / [TOG-9689](/TOG/issues/TOG-9689): clipboard fallback and real DOM search binding need browser acceptance, not only server/component tests. |
| `Unit/EventCancelModalCopyTest.php` | **Deferred UI contract to W10** / [TOG-9689](/TOG/issues/TOG-9689): cancellation dialog copy/state is not covered by the server transition guard. |
| `Feature/Console/QueueDepthQueryFailureTest.php`, `Feature/Console/QueueDepthUnsupportedDriverTest.php` | **Command dropped; portable failure behavior adapted/partial.** `queue:check-depth` is replaced by `GET /up` (`docs/parity.md` §10); `test/up.test.ts` covers degraded/unknown depth. CLI exit codes and unsupported Laravel driver branches do not apply to the fixed Postgres ledger, but no equivalence to every legacy failure/log assertion is claimed. |
| `Unit/QueuePoisonProbeRoutingTest.php`, `Unit/QueuePoisonProbeRunbookTest.php` | **Dropped legacy tool/runbook implementation**, with `Feature/Console/QueuePoisonProbeTest.php`: Laravel probe routing/runbook text is not shipped by Workers. Queue failure visibility remains the product contract covered by `test/up.test.ts`; this does not waive dead-letter/operator recovery readiness. |
| `Feature/AgentEvents/AgentEventGrantPolicyTest.php`, `Feature/AgentEvents/AgentEventIngressTest.php`, `Feature/AgentEvents/AgentEventReceiptWindowTest.php`, `Feature/AgentEvents/AgentObservationUnavailableTest.php` | **Adjacent slice, not re-ported here.** Agent-events owner [TOG-10121](/TOG/issues/TOG-10121), with `test/agent-events.test.ts` and `test/agent-events-shield.test.ts`. The grant-owned capacity shrink noted in A2 is proved by `test/grant-shrink.test.ts`, not inferred from slice completion. |

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
4. **Row reconciliation (main `72c4f435`, 2026-10-04).** The A2, A3,
   `EventCapacityFloorTest`, `EventEtagTest`, `EventJsonAccessTest`, `EventKeyTest`
   and `EventScheduleTest` rows were re-checked against `test/`, with legacy read at
   `2eaefb8d`. Their line citations were re-anchored (several had drifted), and the
   `RsvpUniqueLockRaceTest`/`RsvpCapacityRaceTest` anchors in `test/rsvp.test.ts` and the
   agent-events sentence that quoted A2 were updated to match. Five one-assertion
   additions closed unproved legacy assertions: the plain member 403 on a draft JSON
   show (`test/events.test.ts:481`), game persistence through create (`:276`), a
   Going and explicit waitlisted joins refused on a closed event (`test/rsvp-waitlist.test.ts:655-657`), an empty
   RSS/ICS collection settling on its own validator
   (`test/feed-conditional-wildcard.test.ts:190-199`), and the waitlist position's
   status role, focus and broadcast plus a join settled to Going
   (`test/islands-rsvp-binder.test.ts:400,436`, `test/islands-rsvp-button.test.ts:447`).
   Review repairs strengthen the grant refusal's full-row equality and occupied-seat
   boundary, retain both closed-event waiters unchanged, and validate generated ULIDs
   strictly. Portable backfill assertions map to `test/import-backfill-portable.test.ts`
   rather than being dropped. A3 kept the non-seat-releasing-answer server divergence
   separately from the claim-race UI gap; neither was waived. Both gaps are now closed in the A3 row above: the UI gap by the settled-line proof, the server divergence by the merged non-seat preservation proof. The grant concurrency case
   is an outcome check, not an observed lock-wait proof.
   Rows outside this list keep their earlier wording and may still carry drifted
   citations or gaps that main now pins.

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
