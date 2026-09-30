# W15: member exposure and access-log assertion map

Legacy behavior source: `TogetherWeOwn/two-web` at
`1b76d9b72adfe408b01c1bb1aee4363ebc516fce` (read-only).
All 37 test clauses in the three source files below are accounted for. **Mapped
is not synonymous with implemented:** architecture differences and remaining
legacy controls are called out rather than hidden behind passing mock tests.

Test aliases:

- **E** — `test/member-exposure.test.ts` (mounted application and route inventory).
- **A** — `test/member-data-access.test.ts` (middleware lifecycle + real recorder).
- **P** — existing `test/profiles.test.ts` (W7).
- **R** — existing `test/admin-reads.test.ts` (W12).
- **J** — existing `test/jobs.test.ts` (cron dispatch).

## Exposure matrix

| Surface | Guest | Signed-in non-member | Member | Moderator |
| --- | --- | --- | --- | --- |
| `/profile`, `/members/:user` | OAuth 302, no contents | 403, no contents | Same profile fields; owner-only form | Identical fields, no added edit privilege |
| Profile PATCH / POST `_method=PATCH` | OAuth 302, no write | 403, no write | Owner only; other member 403 | Owner only; other member 403 |
| Every registered admin GET | OAuth 302 | 403, no login loop | 403, no login loop | 200 (missing resource 404), private/no-store |
| Public pages/event page | Public event/aggregate data only | Same public representation | Same public representation | Same published-event representation |
| `/events.json` | 401 | W8 session gate; no attendee representation | Event data/counts, not attendee names | W8 includes drafts; no attendee representation |

E asserts all private reads on the **mounted application**, all registered admin
GETs across the four roles, direct/form outsider writes, and public HTML/source
absence of unique username, bio, game, avatar and snowflake tokens. P additionally
pins escaping and moderator/member representation equality. The inventory pins
all GET-capable registrations on the actual mounted app, including ALL handlers
and middleware multiplicity (no deduplication or namespace-only filter). Nine
mutation cases prove that direct member/admin GET or ALL exports, renamed
parameters, exports in a new namespace, and duplicate wildcard/own-profile ALL
handlers fail completeness. It is a test-net guard, not an automatic query observer.

## `tests/Feature/Profile/MemberDirectoryExposureTest.php` — 6 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 49: guest profile reads redirect before contents | E: `guest %s: no profile/member data or writes`, HTML and JSON Accept. |
| 56: no logged-out PATCH writer | E same case proves refusal/no write. **W7 difference:** PATCH is deliberately restored as the owner-only island form writer; guest gets 302, not legacy 405. |
| 68: member-adjacent JSON, event detail, RSVP writes behind login | E: `guest member-adjacent JSON is refused without returning attendees`; `/events.json` is 401. **W8 difference:** published `/e/:key` is public with aggregate counts only. RSVP write endpoints are not implemented in this checkout; no claim of a W9 port here. |
| 77: crafted guest Livewire mount denied | E mounted profile denial and P guest route pins. **Architecture:** no Livewire endpoint or server component mount exists; island HTML is served only after the member gate. |
| 90: public pages/source contain no member data | E: `public pages contain no member data in HTML/source; RSVP counts remain public`; `/`, events/past, join, about, FAQ, rules, privacy, sitemap, event detail. **Gap:** legacy RSS/ICS/feed routes are absent from this checkout, not claimed covered. |
| 127: public RSVP count, never attendee name | E same public case pins `1 going` with a real RSVP and absence of all personal tokens. |

## `tests/Feature/MemberDataAccessCompletenessTest.php` — 7 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 40: two logged HTML/JSON-Accept views, with/without profile; self-view exclusion | A: `HTML and JSON Accept views log exactly once with profile row=%s`; checks both real DB shapes, all row fields/time, all own-record paths, and missing target. W7 resource is `profile`, not Laravel `member`. |
| 79: all member-data routes carry recorder | E exact non-vacuous inventory + A real rows on both registered read paths; removing middleware makes A fail. **Difference:** no Laravel gathered-middleware introspection or automatic hydration hook. |
| 83: newly added unlogged route detected despite parameter rename | E: `detects a directly mounted %s %s outside the reviewed exposure inventory`; nine GET/ALL mutation cases against a copy of the actual mounted app. |
| 92: guests/authenticated 404s write nothing; deleted writer cannot mutate | E guest denial + A HTML/JSON missing/self paths. P missing/malformed ids and no rows. W7 writer difference as above. |
| 118: denied edit is not attributed to target | A: `owner save and denied member/moderator edits never become target-attributed read rows`; verifies persisted bio and zero access rows. |
| 138: bound-member JSON does not reread to identify subject | A row attribution + flush lifecycle use the already-declared id. W7 profile GET still returns HTML for JSON Accept. **Difference:** no route-model binding/query-count port; `recordAccess` consumes explicit IDs and never queries profiles/users. |
| 154: real unavailable log refuses HTML/JSON profile reads | A: `profile ... fails closed on a real ... INSERT and sanitizes diagnostics`, missing column and table (transaction-local DDL, rollback). |

## `tests/Feature/MemberDataAccessLogTest.php` — 24 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 30: who/when/which member | A HTML/JSON cases assert viewer snowflake/user ID, subject/count, resource/action/route and `occurredAt`. |
| 48: stable Discord identity after rename/delete | A: `keeps the Discord identity across username changes and deletion of the local viewer`. **Schema difference:** `users.id` itself is the snowflake; there is no viewer FK, so `viewer_user_id` remains rather than becoming null. |
| 66: listing is one row with all members | A: `excludes the viewer, deduplicates/sorts a listing and writes one row, not one per member`; real recorder, mixed self/duplicates and empty cases. |
| 81: profile read attributed to owner, not profile key | A profile cases assert the subject user ID; the W7 profile has its user ID as primary key. |
| 92: undeclared hydrated read captured automatically | **Gap:** Drizzle has no Eloquent observer. W7/W12 declare IDs explicitly. E inventory guards new routes, but an undeclared query inside an existing handler is not automatically captured/refused. |
| 111: moderator own-record read excluded | A real mixed-self recorder case + P own profile + A dashboard/form reads produce no rows. |
| 123: ordinary-site profile reads logged | A real profile rows + E mounted worker reads. |
| 136: real failed INSERT refuses admin contents | A admin missing-column/table cases. **Bug fixed here:** returning a new middleware response after `await next()` was ignored by Hono; assign `c.res` to replace the finalized roster. |
| 158: failure log excludes viewer/bindings/SQL | A real INSERT failure diagnostics scan excludes personal tokens, viewer/subject IDs, query token, statement and missing-column name. **Diagnostic difference:** class-only `DrizzleQueryError`, not Laravel exception class + SQLSTATE. |
| 194: every admin route has recorder, selected set nonempty | E enumerates all 8 registered admin GETs and checks every role; A proves real rows/failures on roster/join routes. **Difference:** no Filament gate aliases; adminGuard is the single wildcard middleware. |
| 242: undeclared lazy streamed response refused | **Gap:** no streamed member route exists; current guard does not implement Laravel's undeclared-stream refusal. A buffered flush timing case does not claim to prove streaming safety. |
| 266: declared stream recorded before release | A `does not release the response until the access-log write completes` proves awaited buffered flush. **Streaming equivalent not implemented/tested.** |
| 291: arm/flush leaves no state for later request | A `arming a later request inherits nothing...`, sequential armed/self/404 requests and simultaneous requests on one app instance. Context-local declarations replace container-global recorder state. |
| 324: partially selected profile resolves owner | A profile lookup with/without profile + declared owner IDs. **Architecture:** store selects user key explicitly; no automatic resolution for arbitrary keyless/partial Drizzle queries. |
| 340: unattributable profile read refused | **Gap:** no runtime generic keyless-query detection; known handlers return keyed projections. Not claimed equivalent to Laravel fail-closed observer. |
| 360: schema only IDs/metadata, no copied contents | A `the access table stores identifiers/metadata only, not another copy of member contents` queries actual `information_schema.columns`; P no-content row scan. |
| 377: route name, never URL/search term | A admin relation/join reads and real failure diagnostics + P `never records a URL, username or bio`. |
| 391: append only | **Gap:** `recordAccess` inserts only, but no model/DB update/delete guard exists; arbitrary Db calls can mutate the table. Do not equate insert-only API with append-only enforcement. |
| 406: retention deletes only expired records | `src/jobs/cron.ts:27` computes 90-day cutoff, but **production gap:** `src/jobs/worker.ts:17` wires `AccessLogStore.pruneOlderThan` to `notWired`, not a real DB adapter. No real-row prune parity claimed. |
| 428: retention scheduled | J `wrangler cron triggers are the pinned expressions`, `routes by cron and rejects unknown expressions` + `src/jobs/worker.ts:43`. Scheduled dispatch exists; executable prune gap above remains. |
| 435: unattributable user read refused | **Gap:** same generic keyless/undeclared-query issue as line 340. |
| 457: keyed user partial select recorded | A declared real profile IDs and explicit recorder listing; not an arbitrary query-observer claim. |
| 471: member reached through RSVP relation logged | A `admin roster/relation and join reads name the actual members, never profile or event ids`; R roster rows/scoping. Drizzle join declaration replaces hydration listener. |
| 490: pluck/raw read declared through note() logged | A join viewer and explicit recorder listing. `c.set('access', {subjects})` replaces `AccessRecorder::note()`. |

## Verification and limits

W15's two live suites validate the URL **before constructing a driver**: only
`agent_test` with an empty password on **agent-testdb:5432**, or the exact
`postgres:ci@localhost:5432/postgres` service URL with both GitHub Actions and CI
flags set. Query/fragment overrides, other principals/passwords/ports, and
production/staging hosts are refused without echoing the URL. A password callback
pins the authorized empty password instead of postgres.js's `PGPASSWORD` fallback.

Each suite owns a random disposable schema, runs the canonical migrations with
FKs retargeted to that schema, and uses a search_path with **no public fallback**.
Reset takes no arbitrary Db argument; cleanup and rollback-only failure DDL stay
on that scoped pool. Finally, the fixture closes its pool and drops only its own
schema. Eighteen DB-free safety cases and a real sibling-schema test prove URL
refusal, option pinning, row/FK isolation, failure-DDL rollback and disposal.

No pre-migrated database is needed for the W15-only run (65 tests):

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres npx vitest run test/member-data-fixture.test.ts test/member-exposure.test.ts test/member-data-access.test.ts
npm run typecheck
```

Other pre-existing suites still delete shared tables; serial files do not
serialize other agents. A full-repo run must use a dedicated migrated test DB:

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/tog_10116_w15_tests npm run db:migrate
DATABASE_URL=postgres://agent_test@agent-testdb:5432/tog_10116_w15_tests npm run check
```

The first genuine failing-INSERT run reproduced admin `200` where the requirement
was `503`; the same tests pass after `adminGuard` replaces `c.res`. Assertions
also verify the denied body omits the seeded roster token and remains no-store.
DDL failure fixtures run inside rollback-only transactions and do not persist
schema damage.

This slice provides an acceptance net and one proven fail-closed fix. It does
**not** certify complete Laravel parity or a production security gate: automatic
query capture/keyless refusal, streamed reads, append-only enforcement and the
executable retention adapter remain unresolved controls; feeds and MemberStats
are outside the currently implemented surface. Those are explicit findings for
the build/security owners, not silent skips or claims of clean production.
