# Database-outage contract

The executable route inventory lives in `test/db-outage-matrix.test.ts`. Every
registered Hono endpoint needs an explicit entry; middleware registrations are
not endpoints. The matrix uses a refused loopback Postgres address, never a
production or staging database. Redirect responses are inspected without
following them, so no Discord/OAuth request is made.

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
access with 503. `/up` is liveness, not readiness: it stays 200 and
reports unavailable queue depth as `unknown`. Session lookup failure is not a
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
The 503 envelope is branded HTML for browsers and sanitized JSON for JSON
callers (always JSON for ingress), private/no-store and varied on Accept.
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

These tests verify in-process HTTP behavior. They do not claim staging,
production, deployed Hyperdrive, real Discord or real OAuth acceptance.
