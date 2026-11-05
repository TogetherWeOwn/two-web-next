# Disposable Ember capture fixture

`ember-capture-v1` is the **data prerequisite**, not a Pilot capture or readiness
claim. It is separate from `e2e/seed.mjs`; neither that entry point's GitHub-runner
guard nor its database allowlist changes. No application, clock, route-ownership,
design token, screenshot threshold or known-answer result changes here.

## Safe invocation

Use the Node version required by the [README](../README.md#develop-and-test-safely)
and the locked development dependencies. The manifest command is offline:

```sh
npm run capture:manifest
npx vitest run test/ember-capture.test.ts
```

For SQL verification, explicitly set `DATABASE_URL` to a disposable test database
allowed by `test/helpers/member-data-db.ts:testDatabaseUrl`. Prefer a fresh
run-owned numeric `two_web_next_tog<digits>` database on the documented test host.
The existing CI service URL is accepted only under its existing `CI` and
`GITHUB_ACTIONS` admission conditions. No production/staging targets or credentials
are permitted. The entry point requires explicit seed opt-in and an HTTP loopback
`APP_URL` (the same hostname/protocol boundary as `fixtureManifestFor`, with no
userinfo, path, query or fragment):

```sh
# DATABASE_URL is already set to the approved disposable target, never a live DB.
export CAPTURE_SEED_ID=ember-capture-v1
export APP_URL=http://127.0.0.1:8787
npm run capture:verify
```

The command validates targets **before connecting**, creates a fresh owned schema,
applies the canonical migrations only there, seeds it, checks exact readback and
real aggregate readers, mints private bounded member/moderator sessions, proves a
missing featured row fails, then resets and seeds again. Both materializations
must have identical hashes and route-state bindings. It drops the owned schema
before emitting a success receipt. CI runs this command against its disposable
Postgres service, separately from the database-free unit suite.

A failure exits nonzero, without a driver message, URL, bearer, signing secret or
row dump. Only a small fixed error-code allowlist is printed. **If a credential
fails, stop. Do not try another credential or database.** There are no retries,
credential discovery, production probes, Discord calls or hosted services.

## Programmatic seed and cleanup

The later declarative adapter can import `createEmberCapture` from
`test/helpers/ember-capture.ts`. Supply `{ seedId, databaseUrl, appUrl }`; the same
guard applies. The returned `db` and `client` are pinned to the owned schema with
no `public` fallback. `schemaName` is an ephemeral integration handle, never a
canonical identity. Reuse the existing fixture-driven worker architecture to
bind those handles to a loopback app; **do not point an ordinary app at the base
database or use a raw URL as a schema-isolation substitute**.

Always put `await fixture.dispose()` in `finally`. `dispose()` closes both pools
and drops only the schema this invocation created. `resetAndSeed()` clears local
sessions/grace rows and all seed-owned rows, restores fixed IDs and serial
positions, and revalidates the complete dataset. Do not reset while rendering or
use one schema for concurrent base/head activity. Recreate or reset between
halves: real routes can append audit/view logs and rotate sessions.

Normal failure during initialization also cleans up. A hard process kill cannot
run `finally`: dispose the run-owned Postgres container/database. If retaining a
test database, identify and drop only that run's recorded `w15_<random>` schema
through the approved test connection; never blanket-drop other fixture schemas.
Do not deploy these helpers or import them from application code.

## Session handling and the two clocks

All displayed names and IDs are invented. IDs are synthetic snowflake-shaped
strings solely to satisfy the existing keyed-member guards; they do not name
Discord accounts. Guest means an empty, isolated context, **not** a guest bearer.
Member and moderator roles are distinct and moderator is also a member.

`fixture.session(persona, sessionSecret)` returns a signed cookie to its caller
in memory. Supply a fresh, strong, local-only signing secret matching the fixture
app; never use a deployment secret. Tokens are newly random each time and only
hashes are stored, using the existing session store and cookie settings. Neither
tokens, hashes, signing secrets nor cookie headers enter the committed manifest,
canonical hashes or CLI receipt. Do not serialize the returned cookie, browser
storage state, request headers or database/session dumps into reports,
screenshots, logs, traces or PR evidence. Close the private browser contexts and
dispose/reset the fixture after use.

The frozen **render** instant is `2098-12-31T20:00:00Z`. It does not authorize
freezing security time or minting a session that lasts until 2098. Real SQL
sessions are issued at the real authentication clock with the existing 120-minute
TTL, five-minute role recheck, and 24-hour absolute lineage cap. The unit suite
runs the same memory-session semantics at the frozen instant, including the exact
expiry and absolute-age boundaries. The SQL verifier proves current real-clock
role bits and bounded expiry. No live guild/bot role configuration is needed;
leave bot credentials and live outbound integrations absent. The independent
server-render-clock prerequisite and adapter must preserve this separation.

## Data, IDs and provenance

The source registry is `test/helpers/ember-capture-data.ts`. The machine-readable
contract is [`test/fixtures/ember-capture-v1.json`](../test/fixtures/ember-capture-v1.json).
It declares **33 unique route-states across 28 route patterns**, including every
concrete member/event/featured/join-detail ID, a paused member state, cancelled
410 and unknown 404. The event pattern uses three different keys across its
states, so there are 30 distinct concrete URL strings, not 28.

- Events use exact keys ending `0001`–`0006`: upcoming, past, May, June, paused and
  cancelled. Four published future rows feed the schedule. The pause flag is
  `rsvp_open=false`; cancelled remains an explicit 410 prerequisite.
- Users/profiles, going RSVPs and a waitlisted reserve, a published featured row,
  successful/failed joins and an activity row use fixed primary keys and UTC
  timestamps. The all-time leaderboard is derived from these real web tables.
- Join heatmap cells use successful joins and scheduled event counts through the
  shipped reader; failed joins do not count. Voice/game cells reuse the shipped
  deterministic `priorGrid` estimates, **not** observed live voice/game activity.
  No bot-owned tables, `web_v1` schemas or external read models are mutated.
- Every route-state declares its persona and data prerequisites. Empty `requires`
  means a static/error/form view with no seeded row dependency, never a missing
  prerequisite. `assertCaptureData` requires exact tables, columns, row order and
  values; removing any row fails instead of shrinking the matrix.

`dataHash` is SHA-256 over canonical UTF-8 JSON of `{ tables, voice, games }`.
Object keys sort by code-unit order; arrays retain declared order; timestamps are
UTC ISO strings with milliseconds. SQL readback normalizes timestamps and numeric
IDs (including Postgres bigint strings) before comparison. `tables` includes
exactly the explicitly seeded columns, not schema defaults, trigger-managed sync
metadata, sequences, runtime audit/view writes or any session material.
`bindingsHash` separately covers the entire ordered `routeStates` array, including
expected statuses, concrete URLs, personas and prerequisites. Voice/game hashes
cover the actual shipped grid outputs. The CLI refuses a committed manifest that
differs from the source-generated contract; update it only with an intentional,
reviewed fixture-contract change, never to hide a failing readback.

The normative input is the frozen reference-capture spec, sections 2/3/5. This
fixture does not change its clock, route-state count, dark/light-emulated axes,
viewports, device scale, locale, timezone, masks or thresholds. Nor does it add a
new capture-spec hash: fixture data/binding hashes are separate provenance.

## Explicit not-ready states

The manifest is a complete target matrix, not proof that each current handler
renders it. In particular, current guest member-page access redirects despite the
frozen matrix's declared 200 guest view. Preserve the row and expected 200; the
adapter must report that mismatch as `capture_invalid`/`not_ready`, not accept a
redirect or omit the row. Shell/fonts/tokens, the fixed server render clock,
renderer ownership and the later declarative adapter are independent gates.

No Pilot A capture, model judge, external reference freeze, app/Kit redesign,
production access, deployment or new spend is authorized by this fixture.

REA angle: this reuses the existing disposable-schema/migration harness, public
session-cookie APIs and shipped deterministic aggregate readers rather than
adding a hosted capture service or copied implementation.
