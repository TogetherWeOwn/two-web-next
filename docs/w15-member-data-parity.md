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
| Other public pages | Public event/aggregate data only | Same public representation | Same public representation | Same published-event representation |
| `/e/:key` attendee list | No names/links/list count | No names/links/list count | Going names + profile links, logged, private/no-store | Same member representation; draft view allowed |
| `/events.json`, `/events/:key` | JSON 401; browser OAuth 302 with guarded `next` | Session gate; no attendee representation | Event data/counts and own waitlist position, not attendee names; draft show 403 | Includes drafts; draft show noindex; no attendee representation |

`test/event-attendees.test.ts` covers the mounted event page's four roles,
original RSVP `created_at ASC` ordering (ID tie-break), status/event filtering,
escaping, missing users, empty names, self-exclusion and real failed access-log
INSERTs (503 even when the legacy enforcement flag is disabled). One access-log row
names all rendered subjects except the viewer; guests never query the identity
projection. All normal event HTML is `private, no-store` because the guest join
pitch also depends on the session; `Vary: Cookie` preserves explicit viewer
separation. State banners and canonical sharing coexist with the logged list.
The next roster has `username`, not a separate `display_name`; the list uses that
same visible name as profiles. Profile links are an explicit addition in this
slice; the legacy markup displayed names only.

E asserts all private reads on the **mounted application**, all registered admin
GETs across the four roles, direct/form outsider writes, and public HTML/source
absence of unique username, bio, game, avatar and snowflake tokens. P additionally
pins escaping and moderator/member representation equality. The inventory pins
all GET-capable registrations on the actual mounted app, including ALL handlers
and middleware multiplicity (no deduplication or namespace-only filter). Nine
mutation cases prove that direct member/admin GET or ALL exports, renamed
parameters, exports in a new namespace, and duplicate wildcard/own-profile ALL
handlers fail completeness. It remains an inventory guard. Runtime query observation is separately proved below.

## `tests/Feature/Profile/MemberDirectoryExposureTest.php` — 6 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 49: guest profile reads redirect before contents | E: `guest %s: no profile/member data or writes`, HTML and JSON Accept. |
| 56: no logged-out PATCH writer | E same case proves refusal/no write. **W7 difference:** PATCH is deliberately restored as the owner-only island form writer; guest gets 302, not legacy 405. |
| 68: member-adjacent JSON, event detail, RSVP writes behind login | E: `guest %s member-adjacent JSON is refused without returning attendees`; collection and JSON show are 401 for JSON guests and guarded OAuth 302 for browser guests. **W8 difference:** published `/e/:key` is public with aggregate counts only. W9 RSVP writes exist; this read-control slice does not change their role/ownership policy. |
| 77: crafted guest Livewire mount denied | E mounted profile denial and P guest route pins. **Architecture:** no Livewire endpoint or server component mount exists; island HTML is served only after the member gate. |
| 90: public pages/source contain no member data | E: `public pages contain no member data in HTML/source; RSVP counts remain public`; `/`, events/past, join, about, FAQ, rules, privacy, sitemap, event detail. E: `%s: public calendar feeds never expose member data` covers collection ICS, RSS and per-event ICS across all four roles (W9 merged during this revision). |
| 127: public RSVP count, never attendee name | E same public case pins `1 going` with a real RSVP and absence of all personal tokens. |

## `tests/Feature/MemberDataAccessCompletenessTest.php` — 7 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 40: two logged HTML/JSON-Accept views, with/without profile; self-view exclusion | A: `HTML and JSON Accept views log exactly once with profile row=%s`; checks both real DB shapes, all row fields/time, all own-record paths, and missing target. W7 resource is `profile`, not Laravel `member`. |
| 79: all member-data routes carry recorder | E exact non-vacuous inventory + A real rows on both registered read paths; removing middleware makes A fail. **Difference:** no Laravel gathered-middleware introspection or automatic hydration hook. |
| 83: newly added unlogged route detected despite parameter rename | E: `detects a directly mounted %s %s outside the reviewed exposure inventory`; nine GET/ALL mutation cases against a copy of the actual mounted app. |
| 92: guests/authenticated 404s write nothing; deleted writer cannot mutate | E guest denial + A HTML/JSON missing/self paths. P missing/malformed ids and no rows. W7 writer difference as above. |
| 118: denied edit is not attributed to target | A: `owner save and denied member/moderator edits never become target-attributed read rows`; verifies persisted bio and zero access rows. |
| 138: bound-member JSON does not reread to identify subject | A and `test/keyed-profile-routes.test.ts` attribute the retrieved users/profile owner columns without another identity lookup. W7 profile GET still returns HTML for JSON Accept. `recordAccess` never queries profiles/users. |
| 154: real unavailable log refuses HTML/JSON profile reads | A: `profile ... fails closed on a real ... INSERT and sanitizes diagnostics`, missing column and table (transaction-local DDL, rollback). |

## `tests/Feature/MemberDataAccessLogTest.php` — 24 clauses

| Legacy line / assertion | Vitest mapping / disposition |
| --- | --- |
| 30: who/when/which member | A HTML/JSON cases assert viewer snowflake/user ID, subject/count, resource/action/route and `occurredAt`. |
| 48: stable Discord identity after rename/delete | A: `keeps the Discord identity across username changes and deletion of the local viewer`. **Schema difference:** `users.id` itself is the snowflake; there is no viewer FK, so `viewer_user_id` remains rather than becoming null. |
| 66: listing is one row with all members | A: `excludes the viewer, deduplicates/sorts a listing and writes one row, not one per member`; real recorder, mixed self/duplicates and empty cases. |
| 81: profile read attributed to owner, not profile key | A profile cases assert the subject user ID; the W7 profile has its user ID as primary key. |
| 92: undeclared hydrated read captured automatically | `test/keyed-profile-routes.test.ts`, `test/admin-keyed-mounted.test.ts` and `test/event-attendees.test.ts` inject sensitive queries into EXISTING mounted handlers. Unwrapped queries, caught refusals and additional queries inside helpers refuse the entire buffered response. This is scoped Drizzle observation, not an Eloquent/global DB observer. |
| 111: moderator own-record read excluded | A real mixed-self recorder case + P own profile + A dashboard/form reads produce no rows. |
| 123: ordinary-site profile reads logged | A real profile rows + E mounted worker reads. |
| 136: real failed INSERT refuses admin contents | A admin missing-column/table cases. **Bug fixed here:** returning a new middleware response after `await next()` was ignored by Hono; assign `c.res` to replace the finalized roster. |
| 158: failure log excludes viewer/bindings/SQL | A real INSERT failure diagnostics scan excludes personal tokens, viewer/subject IDs, query token, statement and missing-column name. **Diagnostic difference:** class-only `DrizzleQueryError`, not Laravel exception class + SQLSTATE. |
| 194: every admin route has recorder, selected set nonempty | E enumerates all 14 registered admin GETs (including the five legacy aliases) and checks every role; A proves real rows/failures on roster/join routes. **Difference:** no Filament gate aliases; adminGuard is the single wildcard middleware. |
| 242: undeclared lazy streamed response refused | `test/keyed-member-reads.test.ts`, mounted admin/event tests and `test/keyed-member-worker.test.ts` refuse undeclared stream replacements without producer pulls or sensitive bytes. Ordinary Response bodies are not tested with `instanceof ReadableStream`. |
| 266: declared stream recorded before release | **Intentional stricter difference:** declared member streams are also refused. Only the controlled buffered HTML/text APIs classify a response; replacing that exact response invalidates classification. No supported member streaming is added. |
| 291: arm/flush leaves no state for later request | A `arming a later request inherits nothing...`, sequential armed/self/404 requests and simultaneous requests on one app instance. AsyncLocalStorage capture/one-query permits and exact-response classification replace container-global recorder state; real-row and workerd suites separately exercise isolation. |
| 324: partially selected profile resolves owner | Keyed suites validate actual selected Column provenance (users.id, profiles.user_id, rsvps.user_id, join_attempts.discord_id). Partial projections must include their owner; there is no fallback identity lookup. |
| 340: unattributable profile read refused | Keyed real-row suites refuse absent, malformed, partial and wrong-table owner keys. All-null LEFT JOINs contribute no contents/subject. Explicit self-only and empty result sets remain valid. |
| 360: schema only IDs/metadata, no copied contents | A `the access table stores identifiers/metadata only, not another copy of member contents` queries actual `information_schema.columns`; P no-content row scan. |
| 377: route name, never URL/search term | A admin relation/join reads and real failure diagnostics + P `never records a URL, username or bio`. |
| 391: append only | **Gap:** `recordAccess` inserts only, but no model/DB update/delete guard exists; arbitrary Db calls can mutate the table. Do not equate insert-only API with append-only enforcement. |
| 406: retention deletes only expired records | `src/jobs/cron.ts:27` computes 90-day cutoff, but **production gap:** `src/jobs/worker.ts:17` wires `AccessLogStore.pruneOlderThan` to `notWired`, not a real DB adapter. No real-row prune parity claimed. |
| 428: retention scheduled | J `wrangler cron triggers are the pinned expressions`, `routes by cron and rejects unknown expressions` + `src/jobs/worker.ts:43`. Scheduled dispatch exists; executable prune gap above remains. |
| 435: unattributable user read refused | Same scoped keyed-user/undeclared-query denial proofs as lines 92/340; no arbitrary driver or future table coverage is claimed. |
| 457: keyed user partial select recorded | `test/keyed-member-reads.test.ts` proves keyed partial users selections and owner-column validation with real PostgreSQL rows. |
| 471: member reached through RSVP relation logged | A `admin roster/relation and join reads name the actual members, never profile or event ids`; R roster rows/scoping. Observed returned owner columns replace a hydration listener; current users rows are not required to attribute departed join-attempt members. |
| 490: pluck/raw read declared through note() logged | Keyed retrieval owns subjects; route declarations contain only resource/action/route. Fixed raw member-stat and self-waitlist projections include actual returned owner keys. Arbitrary raw SQL is refused. |

## Verification and limits

W15's isolated live suites validate the URL **before constructing a driver**: only
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

No pre-migrated database is needed for the focused W15 run:

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres npx vitest run test/member-data-fixture.test.ts test/member-exposure.test.ts test/member-data-access.test.ts test/keyed-member-reads.test.ts test/keyed-profile-routes.test.ts test/admin-keyed-mounted.test.ts test/event-attendees.test.ts test/keyed-member-worker.test.ts test/keyed-profile-worker.test.ts test/keyed-admin-event-worker.test.ts
npm run typecheck
```

Other pre-existing suites still delete shared tables; serial files do not
serialize other agents. Broad local tests must use a run-owned migrated test DB.
Seven importer suites additionally pin the local database name to `two_web_next`,
but create and drop only their own disposable schemas; run those separately
rather than weakening their guards or pointing destructive suites at that DB.
The audit suites require their own explicit URL opt-in. Exclude the fixed-name
agent-testdb staging control too: it uses a different database and is not part of
this run-owned lane. Staging-named mocked/loopback unit tests are not authorization
to execute a staging probe.

```sh
# Create this run-owned DB on agent-testdb first; validate the run UUID/name.
TEST_DB="w15_${PAPERCLIP_RUN_ID//-/}"
DATABASE_URL="postgres://agent_test@agent-testdb:5432/$TEST_DB" npm run db:migrate
DATABASE_URL="postgres://agent_test@agent-testdb:5432/$TEST_DB" \
  AUDIT_IMPORT_TEST_DATABASE_URL= W1_AGENT_TESTDB=0 npm run test:coverage -- \
  --exclude test/import-content-funnel.test.ts \
  --exclude test/import-events-rsvps-db.test.ts \
  --exclude test/import-users-profiles.test.ts \
  --exclude test/import-users-profiles-encoding.test.ts \
  --exclude test/import-audit-db.test.ts \
  --exclude test/import-audit-datestyle-db.test.ts \
  --exclude test/import-verify.test.ts \
  --exclude test/staging-fixed-agent-testdb.test.ts
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  AUDIT_IMPORT_TEST_DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  npx vitest run test/import-content-funnel.test.ts test/import-events-rsvps-db.test.ts \
  test/import-users-profiles.test.ts test/import-users-profiles-encoding.test.ts \
  test/import-audit-db.test.ts test/import-audit-datestyle-db.test.ts test/import-verify.test.ts
npm run typecheck
npm run config:check
node --test ci/a11y-*.test.mjs
npm run test:cutover
```

CI's job-private Postgres service allows all suites in one run. Local accessibility
bot-view fixtures intercept `session.prepareQuery`, retain returned `member_id`
on both stats projections, and refuse unknown `web_v1` queries before borrowing
the driver. Boundary-level tests prove that observation cannot discard this
isolation layer; this is synthetic fixture evidence, not a bot-database test.

The first genuine failing-INSERT run reproduced admin `200` where the requirement
was `503`; the same tests pass after `adminGuard` replaces `c.res`. Assertions
also verify the denied body omits the seeded roster token and remains no-store.
DDL failure fixtures run inside rollback-only transactions and do not persist
schema damage.

This slice does **not** certify complete Laravel parity or production acceptance.
Append-only enforcement and the executable retention adapter remain separate
unresolved controls. Optional MemberStats reads now return keyed owner columns;
unavailable bot-owned views still hide the stats block within the existing budget.

## Scoped runtime control and evidence split

Existing profile/member handlers, every authorized admin GET/HEAD, and the entire
`/e/:key` handler execute inside a sensitive-read boundary. HEAD still retrieves
rows through the GET handler: its empty final body does not waive attribution or
the audit INSERT. The borrowed postgres-js adapter retains observing sessions on
lazy/prepared builders constructed before capture and observes execution and
transaction descendants. One permit allows one statement; keyed results must
provide each selected sensitive relation's actual owner Column. Drizzle aliases
resolve physical table ownership through OriginalName and are grouped separately:
an unaliased/self key cannot satisfy another alias's contents. Contract refusals
poison the request even if caught.

Only supported SELECT shapes are reads. A WITH prefix can conceal modifying CTEs,
even when the final SELECT never references them; all unsupported CTE shapes are
refused before execution. Comment-prefixed statements and RETURNING mutations
also cannot evade inspection. Real-row regressions verify stored values remain
unchanged after both fluent UPDATE and modifying-CTE denial. Native `$count`
execution retains the proxy session receiver; an unattributable member count is
not automatically classified or authorized by a keyed permit. Only the final
audit sink exits capture, and its failed INSERT still refuses contents.

Explicit non-sensitive classifications permit mapped event/featured records and
fixed funnel, going-count, search-widget and timeout SQL shapes. The dashboard's
connection-scoped 60-second funnel cache and parallel bounded analytics reads
remain intact; a cold funnel fill classifies both transaction-local timeout setup
and the aggregate. Its route fixtures use real Drizzle builders/session observation
with synthetic execution rows, alongside the mounted real-Postgres checks.
Classifications are not blanket SQL exemptions. Anonymous event reads permit only subject-free public
results; invalid/missing viewer keys cannot release member contents. Captured
subjects are deduplicated, sorted, self-excluded and written once, before releasing
the exact classified buffer, using stable route names and private/no-store.

Roster search/sort retains both RSVP and joined-user owner projections. Featured
filter/sort and legacy-ID resolution remain classified non-sensitive reads;
featured/event resource IDs never become member subjects. The featured edit form's
PostgreSQL microsecond/era/nonfinite timestamp text uses one exact bound-ID query
classification, not a general computed-SQL exemption. Mounted tests refuse added
literal and member SQL projections in that existing handler; the real PostgreSQL
precision suite retains its full timestamp and audit-diff assertions with a valid
moderator snowflake fixture.

Write-route request-body limits are independent of member **response** streaming.
The mounted limiter inventory follows Hono's composed-handler link when a local
error handler wraps middleware; nested mounts are tested with actual cap+1 refusal.
Neither those upload streams nor the 413 renderer add supported member streaming.
Authorized legacy admin redirects use empty classified text buffers and fixed metadata, not a response
classification bypass. Join pagination renders 100 rows but retrieves a 101st
sensitive lookahead: its actual owner is also audited. Unlike main's former
route-declared subjects, slicing the HTML rows cannot erase a retrieved owner.
`test/admin-table-list.test.ts` proves actual one-row PostgreSQL attribution across
both pages and refuses the whole response for missing, malformed or short
lookahead keys. Workerd's existing single-row fixture does not prove pagination.

The shared error renderer recognizes an active sensitive-read boundary before
ordinary logging/alerts: a failed SELECT emits only the exception class, never SQL,
bindings, messages or causes. The known branded not-found shell is explicitly
buffered inside protected boundaries. If only the admin guard matches, it renders
that shell directly rather than letting Hono's single-handler next callback clone
the classified response. This is not a status-based exemption: prior unwrapped
queries and arbitrary 404 replacements still refuse the whole response.

- **Real PostgreSQL:** keyed/mounted suites execute actual SELECTs and INSERTs,
  prove real audit failures with isolated rollback-only DDL/check constraints,
  partial/invalid keys, IDs-only rows, departed subjects, role gates, additional
  sensitive queries in existing handlers, stream refusal, and request isolation.
  `test/keyed-member-reads.test.ts` also proves public prebuilt lazy/prepared
  execution, per-alias owners, modifying-CTE mutation refusal and native count
  refusal. `test/admin-keyed-mounted.test.ts` proves HEAD's actual subject row,
  HEAD denial on a real failed INSERT, real failed-SELECT diagnostic sanitization,
  protected branded 404s and refusal despite a known-shell/arbitrary-404 replacement.
- **workerd/Miniflare:** keyed member/profile/admin-event and DB-execution suites
  run actual boundary/rendering/session code (admin/event/execution also use real
  Drizzle builders, provenance metadata and observation). Row execution and audit
  storage are deterministic memory. They prove runtime roles, buffers, refusal,
  one-entry attribution, isolation, HEAD and minimal unmatched-admin handling,
  **not PostgreSQL persistence or a real failed INSERT**.
  `test/keyed-db-execution-worker.test.ts` verifies prebuilt/alias/CTE/count denials
  before the memory execution adapter is called. All external network access is
  forbidden by these fixtures. Public non-postgres-js test adapters remain unchanged
  outside capture; there is no generic-driver/prebuilt-builder protection claim.

No protection is claimed for arbitrary unwrapped drivers, new data stores/tables,
production scheduler health, production deployment, or supported member streams.
Future sensitive surfaces must adopt this boundary and keyed/classified retrieval;
the inventory remains an independent guard against newly mounted endpoints.
