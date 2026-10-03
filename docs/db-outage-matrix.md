# Database-outage contract

The executable route inventory lives in `test/db-outage-matrix.test.ts`. Every
registered Hono endpoint needs an explicit entry; middleware registrations are
not endpoints. The matrix uses a refused loopback Postgres address, never a
production or staging database. Redirect responses are inspected without
following them, so no Discord/OAuth request is made. Requests use the configured
trusted origin; the inventory still inspects the real router and pins every
middleware registration, including TrustHosts and same-origin guards. The
retired `/health`, `/healthz` and `/db-ping` diagnostics are not registered;
join-attempt detail and both admin/API RSVP pause/reopen routes are covered.
The legacy `/auth/discord/redirect` alias remains database-free; the ordinary login start and callback persist a one-use journey, so they fail closed to `/?n=signin_failed` before any Discord call. Four static admin aliases
redirect only after a valid moderator session; the featured edit alias must
resolve its imported ID and returns a branded 503 when that lookup is down.
All five admin aliases refuse with 503 when the production session store is
down, without issuing a resource redirect or guessing a featured target.

## Legacy comparison

Legacy source baseline: [`TogetherWeOwn/two-web` at
`2eaefb8`](https://github.com/TogetherWeOwn/two-web/tree/2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4).
The frozen app has separate app (`pgsql`) and bot database connections. A bot
outage is **not** equivalent to losing all Postgres-backed state in Next.

- `tests/Feature/DbOutageLeavesTest.php` breaks only the **bot** connection. It
  pins `/about`, `/faq`, `/rules` and `/events` at 200, and `/discord` at 302,
  with database-backed sessions/cache still configured against the healthy app
  database. Its header explicitly says app-database loss historically makes
  `/rules` and `/events` return 500. That 500 is not the Next contract.
- `tests/Feature/LandingPageDegradedTest.php` also breaks only the **bot**
  connection. The home page must keep its pitch/join link and omit unavailable
  counts, timestamps, fake zeroes and infrastructure errors. Next pins the
  degraded home page with its web DB binding unavailable too.
- `tests/Feature/DiscordFunnelTest.php` requires `/discord` to remain a temporary
  302, with `Cache-Control: no-store`, and to touch no database, including when
  sessions use the database. An outage is never a reason to close this door.

Target stronger guarantees in Next: static `/rules` survives app-DB loss;
member-data dependencies must fail closed with sanitized 503 responses rather
than legacy framework 500 pages. These are assertions, not waivers: a current
500 or an unbranded browser error fails the matrix and requires a follow-up.
Admin create forms expose no member subjects and can remain 200 with a local
valid-session fixture; losing the production session store must still refuse
access with 503. `/up` reports readiness (main #111): a failed DB ping answers
503 with `db: "error"`, no migration count and queue depth `unknown`, never
driver details. Session lookup failure is not a
valid authenticated identity; protected routes may therefore redirect to
login (or reject a machine request) before reaching their DB-dependent handler.
The matrix separates that production session-failure path from authorized
handler probes using a local session fixture. The active join OAuth start and
callback may fail closed with branded 503 during app-DB loss: the database-free
`/join` page and `/discord` invite floor remain available. This does not pretend
that losing app persistence is equivalent to a bot-counts outage.

## Runtime response boundaries

`src/db/errors.ts` recognizes structured transport/connection/shutdown codes,
including causes wrapped by Drizzle. It never classifies by message text, and
SQL syntax/constraint failures and ordinary programming errors retain 500.
The shared error boundary and profile-save/ingress catches use this classifier;
existing session and mandatory-audit guards retain their fail-closed policy.
The keyed member-read boundary (admin reads, profiles, event pages) renders the
same envelope when the observed handler fails with a classified outage or the
audit write fails; every other refusal (contract violation, unclassified error)
stays its plain 503. Neither path serves the buffered member contents.
The 503 envelope is branded HTML for browsers and sanitized JSON for JSON
callers, private/no-store and varied on Accept. Negotiated routes compare the
quality of HTML and JSON using the most-specific matching media range; an
explicit `q=0` cannot be overridden by a wildcard. Equal-quality choices use
specificity, then header order, with HTML as the default/fallback. JSON-only
event methods and `/events.json` retain their `{error, message}` JSON envelope
regardless of Accept, including pre-handler session failures. Machine ingress
also remains JSON-only but preserves its separate `{reason, message}` contract:
configured store outages return `reason: ingress_unavailable`, never driver
details or the event API's `error` field.
Post-handler audit failure replaces the finalized response: protected data is
not served if its mandatory record cannot be written.

Home renders as guest when its session dependency is unavailable, keeps a
DB-free `/discord` invite CTA, and omits unavailable counts. It never extracts
identity from a signed bearer cookie. Same-origin logout still attempts row
revocation and clears the browser cookie with a 303 when the DB is down,
including migration failure. **Cookie deletion is not proof of server-side
revocation**: a copied bearer can remain valid until revocation/expiry once the
DB recovers. Cross-origin logout remains forbidden without clearing cookies.

`test/db-outage-responses.test.ts` supplements the real-socket matrix with
classification negative controls, guest-home and logout security regressions,
and failures after successful profile reads (save and mandatory audit).
The JSON event show (`GET /events/:key`, main #109/#98) redirects anonymous
browsers to the join funnel before any DB read and returns the outage envelope
to member sessions, including when the session store itself is down. The RSVP
HTML adapter (`POST /e/:key/rsvp`, main #98) reuses the JSON RSVP paths, so a
member write during an outage renders the branded 503 instead of redirecting.
The alert probe (`POST /__probe/alert`, main #120) refuses with a branded 404
before any queue or DB read while its QA gate is disabled, so it is
outage-independent.

These tests verify in-process HTTP behavior. They do not claim staging,
production, deployed Hyperdrive, real Discord or real OAuth acceptance.
