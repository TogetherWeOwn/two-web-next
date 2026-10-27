# Kit public payloads: the no-member-data contract

Kit serializes load data into `__data.json` for anonymous clients even with
`csr=false`. So every Kit GET reachable without a member session must serve
load data free of Discord IDs/usernames, snowflakes, emails and session
artifacts. Member- and moderator-gated routes keep their audited reads; this
contract pins the public side only.

## Run it

```sh
npm run check:kit-payloads            # JSON report: static coverage + hostile-fixture suite
npm run check:kit-payloads -- --static-only   # fast half: enumeration coverage only
node ci/check-kit-payloads.mjs | jq .ok       # pipeable form (pure JSON on stdout)
npx vitest run test/kit-no-member-data-contract.test.ts test/kit-public-events-payload.test.ts  # both suites directly
npm run check:kit-payloads:selftest          # checker regression tests, no dependencies
```

Stdout is pure JSON (`check`, `ok`, per-check `id`/`status`); exit 0 only
when every check passes. `dynamic.exitStatus`, `signal` and `spawnError`
record the Vitest process outcome. A nonzero exit, signal, spawn error,
failed suite/hook or unsuccessful report fails even when all assertions
passed. Dynamic failures include a stable `code` (`suite_run_failed`,
`suite_report_missing`, `suite_report_invalid` or `suite_contract_failed`),
`retryable: false` and `next_action`: run the listed Vitest suites directly,
fix the failure, then rerun the checker.

The root `npm run check` runs the full checker plus its selftests. CI's
blocking `check` job runs the dependency-free selftests and static audit
before installing dependencies, then the full JSON checker after the root
and Kit installs. Both suites also run under the coverage gate. Fixtures
only: no network, production flags or database required.

## Source of truth

`ci/kit-public-payloads.json` enumerates every Kit server file: public
checks with stable `kit-payload-*` IDs, session-required routes with their
audited reads, and out-of-scope Hono-owned surfaces with reasons. The check
fails closed on drift in either direction (unlisted file, stale binding,
unmapped test, vacuous check). Enumeration includes both `.ts` and `.js`
page, layout and endpoint server files, and unknown `+*.server.*` or
`+server.*` file shapes rather than silently ignoring them.

The protected acceptance suite pins page loads and model/render behavior.
`test/kit-public-events-payload.test.ts` additionally executes the real
bundled `/events` GET with hostile database rows and checks the final full
page and island response bytes. Its separate `kit-payload-events-binding`
ID makes missing endpoint coverage fail vacuously instead of being masked
by the model-level tests.

## Fixing a leak

Narrow the data at the load, never scrub at render. Precedents:

- `toPublicWidgetSnapshot` (`src/discord-widget.ts`), applied in the
  `/join` binding — aggregates only, no member usernames/statuses.
- `toPublicPastArchiveRow` (`src/kit-past-events.ts`), applied in the
  `/events/past` binding — rendered card fields plus the occupancy
  aggregate and the public-by-design Discord event id; the authorship
  snowflake stays server-side. During a search it also carries the
  pre-segmented title spans and bounded description passage, derived
  from the already-public title and description.
- `HomeEvent` (`src/events/reads.ts`) — the home teaser pick.

Public-by-design ids (`discordEventId`, transient `discordId`, widget guild
id) are not leaks; the suite pins them as non-needles. There is no email
column anywhere by policy, so the email pin rides the username vectors.

## Adding a route

1. Add its server file to `ci/kit-public-payloads.json` (public check,
   session-required, or out-of-scope with a reason) — the static half
   fails until you do.
2. Public route: extend `test/kit-no-member-data-contract.test.ts` with a
   hostile-fixture payload test (Test Author owns that file — coordinate),
   and map its stable ID in `ci/check-kit-payloads.mjs`.
