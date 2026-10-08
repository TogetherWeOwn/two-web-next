# Same-origin writes

The outer Hono app registers `sameOrigin` immediately after security headers,
before any route, throttle, session lookup/rotation, body parsing or write.
It applies to **POST, PUT, PATCH and DELETE**, including mounted admin/profile
routes, login QA, logout, JSON event writes, RSVP writes and HTML form overrides.
It does not depend on a cookie being present: unauthenticated writes must pass
it too. GET, HEAD and OPTIONS retain their existing behavior.

For guarded requests:

- A supplied `Origin` must equal the serialized HTTP(S) origin of `APP_URL`.
  A configured trailing slash or path is not part of the origin. Scheme and
  port matter; sibling subdomains are not same-origin.
- Only when `Origin` is absent, `Sec-Fetch-Site: same-origin` is accepted, and
  the request URL's origin must itself equal the origin of `APP_URL`.
  `same-site`, `cross-site` and `none` are not substitutes.
- An explicit foreign, empty, malformed or `null` Origin never falls back to
  Fetch Metadata. Missing both headers and invalid `APP_URL` fail closed.
- Refusals always return HTTP 403 with JSON `{"error":"cross_origin"}` and
  `Cache-Control: no-store, private`, regardless of Accept. They do not set a
  session cookie or consume a write throttle. Security headers still apply.

## Exact exemptions

Only these **method + path** pairs bypass this guard:

| Method | Path | Why |
|---|---|---|
| POST | `/api/agent-events` | Machine ingress authenticates with its own bearer grants, budgets and replay protection, not browser cookies. The bot action boundary retains its HMAC signer. |
| POST | `/csp-reports` | Browser violation reports cannot reliably provide Origin; this bounded, sampled, non-persistent sink has no session, cookie or DB dependency and always returns 204. |

Other methods on these paths, trailing-slash variants and child paths are not
exempt. No new exemptions may be added merely to accommodate a browser route
or a test client missing headers. Non-browser callers to a guarded route must
send a matching Origin; neither Origin nor Fetch Metadata is authentication.

## Regression proof

`test/same-origin.test.ts` enumerates `app.routes`, proves a single global guard
precedes every unsafe/ALL route registration, and pins both exemptions to real
routes. A mutation case proves a handler inserted before the guard fails the
audit. It sends a foreign-origin request to every concrete unsafe route/method
(including the ALL RSVP fallback), with a signed moderator cookie and a filled
honeypot; each must return the same 403 without reading or changing sessions.
Unit cases cover all four methods, missing/null/malformed origins, scheme/port
mismatch, same-site Fetch Metadata, alternate request hosts, invalid config,
both admitted header forms, safe methods and exact exemption boundaries.

Existing auth, CRUD, profile, RSVP, throttle and machine-ingress suites continue
to exercise same-origin behavior. Synthetic POST fixtures explicitly provide
Origin; isolated-router origin tests mount the shared outer guard, since the
per-handler checks have been removed. For a full local check, first create and
migrate a fresh run-owned database following the [README database setup](../README.md#database-and-migrations);
never run the full suite against shared `two_web_next`.

```sh
# Replace the numeric suffix with unused digits for each run.
export TEST_DB=two_web_next_tog1234567890123456
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/${TEST_DB}"
export AUDIT_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"
unset LEGACY_DATABASE_URL
export PGPASSWORD=
export W1_AGENT_TESTDB=0
npm run db:migrate
npm run db:check
env -u BOT_DATABASE_URL npm run check
```

Never use a production or staging database for these tests.
