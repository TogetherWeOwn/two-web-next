# TOG-9689 — W10: Livewire → islands re-spec + drift tests

**Status:** slice 1 merged; slices 2–5 as gated child cards.
**Source of truth for behavior:** two-web (maintenance-only) `app/Livewire/*.php`,
`resources/views/livewire/*.blade.php`, `tests/Feature/Livewire/*`, `tests/Feature/Events/*`,
`tests/Feature/Profile/*`. This doc re-expresses them; nothing is ported verbatim
because there is no Livewire protocol on Workers.
**Executable contract:** `src/islands/contracts.ts` + `test/islands-*.test.ts` +
`test/islands-no-livewire.test.ts`. If this doc and the contract disagree, the
contract wins and this doc gets fixed.

## 0. Architecture (all five islands)

- Every island is **SSR HTML first** (SEO, guests, no-JS), with a progressive-enhancement
  binder in `public/islands/<name>.js` (plain script, no framework, no build step).
- SSR marks regions with `data-island="<name>"`; binders patch nodes in place, never
  full re-render. Mount binding keys ride on `data-*` attributes (event key, capacity),
  never on model payloads — a crafted attribute cannot repoint a write at another row
  because writes re-resolve identity server-side from the session + route key.
- Every island has an explicit polling contract in `POLLING` — `pollMs: null` with a
  reason where polling was deliberately not built. Adding a poll later means editing
  the contract + its drift test, not just shipping a `setInterval`.
- Testids are frozen (`data-testid="…"`) — the drift tests pin them, and W8/W15 port
  the legacy selector coverage against them.
- URL freeze (TOG-9671): `/events`, `/events/past`, `/e/{key}`, `/events.json`,
  `.ics`/`.rss` stay byte-identical. Query-surface additions (`?q=`, month, page)
  are finalized in W8 against this spec.

## 1. GoingCount ✅ SHIPPED (slice 1)

Legacy: `GoingCount.php` + `going-count.blade.php` + `GoingCountTest.php` (TOG-7966, TOG-6924).

- Badge: "N of M going" with a cap, "N going" without — never invents a number.
  Shareable page adds "N of M spots left" / "Full" from the same numbers (`showSpotsLeft`).
- `role="status"` polite announcements naming the write ("You're going." /
  "You're on the waitlist." / "RSVP removed."); silent on first render so page load
  stays quiet; never `role="alert"`.
- Refresh: `going-count-updated` DOM CustomEvent `{eventKey, viewerState}` → exactly
  one `GET /events.json?event_key=…` per answered event (key filtered before
  pagination); non-matching island keys fire nothing; missing row keeps last known-good. A newer write owns its refresh even when an
  older fetch/body finishes later. The accepted aggregate emits
  `going-count-refreshed {eventKey, goingCount, capacity}` for capacity reconciliation,
  without another request. Executable: `test/islands-going-count*.test.ts`.

## 2. RsvpButton (slice 2, on the frozen W8/W9 routes)

Legacy: `RsvpButton.php` + `rsvp-button.blade.php` + `RsvpButtonTest.php`
(TOG-8135 session-expiry, TOG-7976 throttle copy CM-frozen, TOG-6956 focus moves,
TOG-6990 syncing-vs-failed, TOG-8715 honeypot swallow).

- Writes: `PUT /events/{key}/rsvp {status}` (201 first write / 200 re-answer),
  `DELETE /events/{key}/rsvp` → 204. PUT accepts `going` / `maybe` / `not_going` /
  `waitlisted`; the island exposes going, waitlist and withdrawal controls.
  Request budget: one request per accepted activation. All controls are disabled
  until the write and response body settle; repeated activations fire nothing.
  Writes are never aborted/replaced: aborting a fetch cannot cancel a transaction.
  This supersedes the unsafe abort-then-resend wording after the slice-2 review.
  A readable, valid stored answer is required to confirm going/waitlisted. An
  unreadable/missing/unexpected successful answer or response-less transport rejection
  announces an unknown outcome and offers an event refresh; mutations stay disabled
  until SSR recovers the answer, rather than asserting a failed write or blindly
  replaying it. Losing transport does not prove a delivered transaction was refused.
- States rendered: guest login link (never a dead button); closed (Cancelled /
  Not published yet / been-and-gone, `role="status"`); full + waitlist join; in-line
  position + claim-seat (locked path); You're-in + withdraw; optimistic saving in
  flight (`aria-busy`); throttle wait (CM copy verbatim, `role="status"`, button stays
  enabled); failure alert beside an enabled control; session-expired → login link with
  `?next=` return path captured at SSR (never the update endpoint), through the
  existing `/join/discord` signed-return flow, not the home-only auth alias.
- Member controls are POST form submits to `/e/{key}/rsvp` without JavaScript;
  the adapter reuses the JSON handlers' auth, caller identity, traps and shared
  budget, then returns 303 to the event. The binder prevents native submission
  and enhances the same controls to PUT/DELETE. No inert member buttons.
- EventPage mounts the GoingCount listener and stable count/announcement targets.
  Its member-only attendee list is explicitly a page-load snapshot with a refresh
  link; RSVP enhancement does not pretend to keep identities live.
- Broadcasts `going-count-updated {eventKey, viewerState}` on every successful write
  (going / waitlisted / none) and re-reads nothing itself — the badge owns its aggregate.
  Withdrawal does not imply a vacancy: FIFO promotion may keep the event full.
  Keep last-known capacity until the badge's latest valid aggregate reconciles the
  join/waitlist/claim controls; a failed refresh cannot invent an open seat.
  A validated allocation received during a write is retained without changing busy
  controls. A known-refused write (including 429) reconciles the latest retained
  allocation at settlement. Successful writes supersede it with their own refresh;
  unknown, closed or authoritative full outcomes never replay an older allocation.
- Honeypot `website` field: a filled decoy answers the byte-identical success shape
  without touching limiter/auth/DB; nothing attacker-shaped logged. Per the executable
  contract (`rsvpTrapTripped`), a bare RSVP click has no form-open timestamp or
  minimum-fill gate; absent/empty inputs never trip. There is no RSVP timing
  floor — the 1000 ms floor belongs to the profile form only
  (`PROFILE_MIN_FILL_MS`). Non-string and filled duplicate decoys fail closed.
- Drift tests pin: requests fired per click (method/URL/body), all states rendered,
  broadcast payload, CM throttle copy verbatim, honeypot success-shape equality.
- Needs from W9: frozen `PUT/DELETE` status codes, throttle agreement (12/min shared
  bucket both verbs), syncing-vs-failed row shape (`synced_to_discord_at`).

## 3. EventsCalendar (slice 3, after W8)

Legacy: `EventsCalendar.php` + `events-calendar.blade.php` + `EventsCalendarTest.php`,
`EventsCalendarTimezoneTest.php`, `EventSearchTest.php`, `EventSearchLogTest.php`,
`HomeUpcomingEventsTest.php` (TOG-5416 skeletons, TOG-5168 Discord rows, TOG-5318 retry,
TOG-5624 share tags, TOG-8400 search logging, TOG-7332 announcements, TOG-6958 toggle group).

- SSR one pass, one query rendered twice (list + month grid) — no second round trip
  for LCP. Member-driven fetches only: view toggle, month step, settled search
  (debounced, `?q=` URL-bound + shareable), past drawer, retry. At most one request
  in flight, abort the previous; skeleton while in flight.
- Search: server-side LIKE with bound + escaped term; blank = no search; forces list
  view; matching past rows show without opening the drawer. Empty states: never /
  gap (with past list) / error (`role="alert"` + Retry re-firing the read) / search-miss.
  Logging: normalized query + visible count only, no identity, fail-open.
- Month grid: whole weeks Monday-first, host-zone "today" (modal event zone), bad `month`
  input falls back to this month (never 500), unknown view name keeps current view.
  Supported month carriers are `0001-01` through `9999-12` (year zero falls back);
  years 1–99 are literal, not 1901–1999. Previous/next steps stay on the boundary
  month when they would leave that range. Full-week trailing neighbours after
  `9999-12` retain valid expanded ISO dates (`+010000-01-01`), not month URLs.
  Host-zone event/today buckets use the same canonical ISO years, interpreting
  Gregorian eras (1 BC = year zero); unsupported implicit host months fall back.
- Drafts invisible to non-moderators including inside search; withCount aggregate (no N+1);
  Discord display-only transients merged in start order. [Expiring shared snapshots](discord-snapshots.md)
  are not canonical events and never enter feeds, RSVP or write-back.
- Drift tests pin: requests per action (single in flight, abort), all empty states,
  URL-bound search, grid math (weeks/today/fallbacks), draft invisibility, log shape.

## 4. PastEvents (slice 4, after W8)

Legacy: `PastEvents.php` + `past-events.blade.php` + `PastEventsArchiveTest.php`
(TOG-8706 canonicals, TOG-7989 out-of-range).

- Archive: `GET /events/past?page=N`, 20 per page (same twenty as the JSON default),
  most-recent-first, no RSVP controls, no viewer join (no per-card query).
- States: empty archive (join pitch + back link); out-of-range page naming the page
  count (`role="status"`); canonical bare on page 1, `?page=N` otherwise.
- Progressive enhancement fetches the archive's SSR HTML, never `/events.json`
  (that collection is authenticated and has different membership). Real paging anchors
  still work without JavaScript; modified clicks keep normal browser navigation.
- The binder patches the stable state/list/pager nodes, updates the canonical and
  `og:url` with history, and aborts superseded reads. Failures keep current cards and
  allow retry; back/forward re-reads without adding a history entry.
- Count and page reads share the same archived-row predicate and captured clock.
  One grouped going-count aggregate serves the page; no viewer-answer lookup or N+1.
- Drift tests execute the shipped binder and real Hono/Drizzle reads hermetically:
  page-turn requests, both empty states, canonicals, per-page count, no RSVP control,
  no viewer-answer query, stale-response rejection, retry and back/forward. The W8
  agent-testdb/CI-service test also pins row eligibility and stable newest-first paging.

## 5. MemberProfile (slice 5, after W7)

Legacy: `MemberProfile.php` + `member-profile.blade.php` + `MemberProfileTest.php`
(TOG-8137 session-first ordering, TOG-6957 focus moves, TOG-8715/TOG-9361 oracle-free
trap, TOG-6924-adjacent new-member state).

- View: avatar (eager, Discord CDN srcset, initial fallback), display name, rank,
  joined month; guests see the view but never the edit control.
- Edit flow: one `PATCH` on save (validation: bio ≤1000, games ≤20×80 chars one per
  line de-duped, IANA timezone, no control chars); cancel discards; save-failed keeps
  input + announces; session-expired (checked before the gate) keeps input + points at
  login; focus moves to form heading / alert / saved confirmation.
- Save deadline (TOG-11625): one owned 10 s client deadline
  (`PROFILE_SAVE_DEADLINE_MS`) covering fetch plus response-body completion;
  on expiry the binder aborts the owned fetch where possible, shows the
  `profile-uncertain` status notice with the draft intact, and releases the
  controls — never a rollback, no resend, no second PATCH while unsettled.
- Spam trap: unlocked `website` honeypot + server `formOpenedAt` floor (1000 ms);
  either signal on a valid save ends in the exact success state ("Profile saved.",
  form closed) — no oracle, no log. Validation errors always surface first.
- Drift tests pin: requests per action (single PATCH), all states, focus targets,
  trap success-shape equality, exposure rule (guests see nothing editable).
- Needs from W7: profile route shape, gate semantics, stats source.

## Slice order (all gated on W8/W9/W7 server routes)

1. ✅ Slice 1 (this run): contracts module + GoingCount island + binders + CI gates.
2. Slice 2: RsvpButton — needs W9 routes frozen.
3. Slice 3: EventsCalendar — needs W8 collection + pages.
4. Slice 4: PastEvents — needs W8 archive.
5. Slice 5: MemberProfile — needs W7 profile routes.

Each slice: island binder + SSR wiring against the real routes + contract tests green
in CI; one Code Reviewer pass (docs/spec/test-only per review economy); no
Security/CISO/QA cards (no auth/secrets/permissions/public-exposure diff).
