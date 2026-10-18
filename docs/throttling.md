# Human-route throttle client keys

`src/throttle.ts` builds each human-route throttle bucket from its route name
and a normalized client address. Budgets, the Postgres admission transaction,
the 60-second window, and the shared 429 response do not change.

## Address selection

The address is the trimmed `CF-Connecting-IP` when it is non-empty, otherwise
the first non-empty trimmed `X-Forwarded-For` hop, otherwise `anon`. Empty or
whitespace-only `CF-Connecting-IP` falls through to `X-Forwarded-For`; empty
hops are skipped, so an empty first hop never collapses clients into a shared
empty-suffix bucket. Only a request with no usable identity in either header
lands in the existing documented `anon` fallback bucket, exactly like a
headerless request. Cloudflare supplies `CF-Connecting-IP` on edge requests;
the other cases support off-edge tests and local runs. This change does not
make other forwarded headers trusted or change their precedence.

## Normalization

- Native IPv4 keeps its existing address key, with no subnet aggregation.
- IPv4-mapped IPv6 uses the native IPv4 key: `::ffff:192.0.2.1` and
  `::ffff:c000:201` both share the budget for `192.0.2.1`.
- Other valid IPv6 addresses share the first 64 bits. For example,
  `2001:db8:abcd:1234::1` and `2001:db8:abcd:1234:ffff:eeee:dddd:cccc`
  both use `2001:db8:abcd:1234::/64`, but `2001:db8:abcd:1235::1` does not.
- Uppercase hex, leading zeros, compressed groups and embedded IPv4 spellings
  produce the same key for the same prefix. The runtime's
  [URL IPv6 parser](https://url.spec.whatwg.org/#concept-ipv6-parser)
  validates addresses before the canonical pieces are expanded.
- Missing or wholly empty addresses share the documented `anon` fallback, never
  an empty-suffix bucket. Malformed off-edge values retain their existing key;
  a parse failure never skips the throttle store.
- The normalized client segment is capped at 64 characters
  (`MAX_CLIENT_KEY_SEGMENT` in [`src/throttle.ts`](../src/throttle.ts)),
  applied before any store call. The longest valid IP text form is 45
  characters, so the cap never truncates a valid address; only over-bound
  malformed or hostile values are truncated, deterministically, with values
  differing inside the bound keeping distinct buckets. No header bytes are
  logged.

This limits address rotation within one /64. It does not prevent clients with
multiple /64 allocations from consuming multiple budgets. Devices sharing a
/64 now intentionally share a route budget, just as clients behind one IPv4
NAT already share theirs. IPv4-compatible or translation addresses other than
IPv4-mapped IPv6 remain under the IPv6 /64 policy.

## Admission window and per-route budgets

Every bucket shares one fixed-window admission: count the rows for the exact
bucket stamped in the last 60 seconds; at or over budget refuses with the
shared 429 response and a `Retry-After` of at least 1 second (the ceiling of
oldest-hit-plus-window minus now), otherwise the admission inserts one hit row
and lets the request through. The count-then-insert runs under a per-bucket
Postgres advisory lock so concurrent bursts cannot overshoot; the lock waits
at most `WEB_THROTTLE_LOCK_TIMEOUT_MS` (`SET LOCAL lock_timeout` in
[`checkJoinThrottle`](../src/join/service.ts)). Failure posture
differs by call site:

- Absent store allows: [`checkJoinThrottle`](../src/join/service.ts) returns
  `{ limited: false }` for a null store, so a missing database URL/binding
  with no injected test store lets the request through. This holds for both
  the generic middleware (via [`throttleStore`](../src/throttle.ts)) and the
  direct join helper (via [`joinStore`](../src/join/route-shared.ts)).
- Held-bucket lock contention refuses: a timed-out admission-lock wait (55P03)
  resolves inside [`checkJoinThrottle`](../src/join/service.ts) to
  `{ limited: true, retryAfter: 1 }` with no hit charged — contention on a
  per-client bucket is that same client's burst, so the busy pass answers the
  shared 429 rather than admitting free — and the busy pass still runs the
  best-effort expiry prune below. Any other store error still propagates
  (generic middleware allows, direct join keeps its outage envelope).
- Generic middleware catches count failures:
  [`throttleGuard`](../src/throttle.ts) catches any throw from store
  acquisition or the count/insert and allows — a missed count beats a 500 on
  that path.
- Direct join allows unclassified store failures, propagates outages:
  [`throttled`](../src/join/route-shared.ts) awaits the configured store and
  [`checkJoinThrottle`](../src/join/service.ts) and allows on any throw
  except a classified transport/server outage (see
  [`isDatabaseUnavailable`](../src/db/errors.ts)), which it rethrows so the
  global handler renders the shared 503 envelope (see
  [`internalErrorHandler`](../src/error-responses.tsx)). The outage matrix pins
  the classified case: `GET /join/discord` and `GET /join/callback` answer 503
  on a refused Postgres socket (see
  [`test/db-outage-matrix.test.ts`](../test/db-outage-matrix.test.ts)).
- Prune is best-effort: [`checkJoinThrottle`](../src/join/service.ts) logs a
  one-line warning and swallows a throwing expiry DELETE, then returns the
  decided verdict, so a prune failure never flips a refusal into an admission
  on the generic path or a 500 on the direct join path.
- Allowance is admission only: passing the throttle does not guarantee the
  downstream handler succeeds — the journey store, bot call, or session mint
  can still refuse or fail.

RSVP writes use
[`chargeThrottle`](../src/events/rsvp.ts) with the same shape.

| Budget | Value | Constant | Buckets and routes |
| --- | --- | --- | --- |
| Auth | 10 / 60 s | `AUTH_THROTTLE_PER_MINUTE` in [`src/throttle.ts`](../src/throttle.ts) | `login-redirect` (`GET /auth/discord`), `login-callback` (`GET /auth/discord/callback`), `qa-login` (`POST /auth/qa/:identity`) in [`src/index.tsx`](../src/index.tsx), `alert-probe` in [`src/alert-probe.ts`](../src/alert-probe.ts) |
| Join | 10 / 60 s | `JOIN_THROTTLE_PER_MINUTE` with `JOIN_THROTTLE_BUCKET = "join"` in [`src/join/service.ts`](../src/join/service.ts) | `join:<clientKey>` shared by `GET /join/discord` and `GET /join/callback` in [`src/join/route-shared.ts`](../src/join/route-shared.ts) (`GET /join` lives in [`src/join/route-page.ts`](../src/join/route-page.ts)) |
| Write | 30 / 60 s | `WRITE_THROTTLE_PER_MINUTE` in [`src/throttle.ts`](../src/throttle.ts) | `logout` (`POST /logout`) in [`src/index.tsx`](../src/index.tsx), `event-write` on the moderator event writes in [`src/events/routes.tsx`](../src/events/routes.tsx) |
| Profile write | 30 / 60 s | `PROFILE_WRITE_THROTTLE_PER_MINUTE` in [`src/profiles/routes-admission.ts`](../src/profiles/routes-admission.ts) | `profile-write:<viewerId>` per member on profile writes |
| Public event reads | 60 / 60 s | `PUBLIC_EVENT_READS_PER_MINUTE` in [`src/events/routes-shared.ts`](../src/events/routes-shared.ts) | `events-read:<clientKey>` across public event pages and feeds; see [`event-read-admission.md`](event-read-admission.md) |
| Shared public reads | 60 / 60 s | `PUBLIC_EVENT_READS_PER_MINUTE` via `publicReadGuard` in [`src/events/routes-shared.ts`](../src/events/routes-shared.ts) | `events-read:<clientKey>`, the same bucket as public event reads, shared by `GET /api/public/*` (via `admitted` in [`src/public-data/routes.ts`](../src/public-data/routes.ts)) and `POST /mcp` (via `admitted` in [`src/mcp/routes.ts`](../src/mcp/routes.ts)) |
| RSVP write | 12 / 60 s | `RSVP_RATE_LIMIT` (`maxAttempts: 12`, `decaySeconds: 60`) in [`src/islands/contracts.ts`](../src/islands/contracts.ts) | `rsvp-write:<userId>` per member, shared by RSVP PUT and DELETE across events in [`src/events/rsvp.ts`](../src/events/rsvp.ts) |

The `qa-login` Auth budget is per runner IP and shared across every suite in
a run, including local runs: the whole sequential smoke presents a single
runner IP, and each `qaLogin` in
[`e2e/fixtures.ts`](../e2e/fixtures.ts) spends the same
`qa-login:<clientKey>` bucket, so the 11th login inside one 60-second window
is refused with the shared 429. The count lives in the `e2e/qa-login-budget`
static guard (`e2e/qa-login-budget.test.mjs`, shipped with the local-smoke
budget fix #665): it totals `qaLogin` call sites across the specs and fails when a
run would exceed the budget — merge journeys onto fewer logins instead of
retrying across the window. Bounded retry handling for an
already-throttled staging login lives in
[`e2e/qa-login-retry.mjs`](../e2e/qa-login-retry.mjs); the local `qaLogin`
fails hard on the first 429.

Generic and join buckets key on the client key above (`<name>:<clientKey>`);
RSVP and profile-write buckets key on the member id instead, so switching verb
or path cannot multiply the budget. The join bucket carries no minute segment:
the 60-second row window alone judges admission, so a burst straddling a
wall-clock minute still spends one budget. RSVP PUT
policy refusals (`not_found`, closed events) return before the charge in
[`chargeThrottle`](../src/events/rsvp.ts) and spend nothing; other paths spend
before policy is judged — the generic middleware charges before the handler
runs, profile-write 403s charge before the owner check in
[`admitWrite`](../src/profiles/routes-admission.ts), and RSVP DELETE on a missing event
charges in [`withdrawRsvp`](../src/events/rsvp.ts). The QA seam is the
exception: its identity/token gate runs before `throttle("qa-login", …)` (same
shape as `/__probe/alert` in [`src/alert-probe.ts`](../src/alert-probe.ts)),
so unauthenticated probes 404 without spending the shared `qa-login` bucket and
a probe flood can never lock out legitimate QA logins. Only gated QA logins
charge the bucket.

## Prune and storage bound

There is no background job. Expired rows are deleted piggyback on throttle checks at
two call sites, both with a 5-minute bound:

- [`src/join/service.ts`](../src/join/service.ts) (`checkJoinThrottle`): after
  the admission verdict — admitted or refused — outside the per-bucket
  admission lock transaction, at most one 1,000-row oldest-first batch of
  `where at < now() - interval '5 minutes'` via
  `order by id limit 1000 for update skip locked`, so rows locked by unrelated
  transactions are skipped for a later pass. The cleanup stays outside the lock
  so it never prolongs it; refused requests prune the same age-only rows
  instead of letting expired rows accumulate until some request is admitted.
  Best-effort: a throwing prune keeps the decided verdict.
- [`src/events/rsvp.ts`](../src/events/rsvp.ts) (`pruneThrottle`, called from
  `writeRsvp` and both `withdrawRsvp` paths): inside the same transaction,
  before the budget charge and the write, at most one 1,000-row batch of
  `where at < clock_timestamp() - interval '5 minutes'` via
  `order by id limit 1000 for update skip locked`, so rows locked by unrelated
  transactions are skipped for a later pass and the cleanup never stalls the
  write. It must run before any accept/charge decision, never between the
  debit and the write.

The admission window reads `clock_timestamp()` (the lock wait does not stretch
the window); the join-path prune uses `now()`. The table and its
`(bucket, at)` index are owned by the migrate workflow in
[`drizzle/1000_join-attempts-throttle.sql`](../drizzle/1000_join-attempts-throttle.sql),
with the Drizzle shape in
[`src/db/schema.ts`](../src/db/schema.ts). The request path performs no DDL
and the runtime role stays read/write-only (see
[`throttleStore`](../src/throttle.ts) and [`joinStore`](../src/join/route-shared.ts)).
[`migrateJoin`](../src/join/service.ts) is a fixture helper only: it replays
the same shape so disposable test schemas match migrated databases, and
production must not call it. The 5-minute retention is five times
the 60-second admission window, so live-window rows are never pruned early and
steady-state storage holds roughly five minutes of admitted hits.

## Rollout and verification

Old exact-IPv6 bucket rows are not transferred to the new prefix key; those
clients can receive one fresh budget at deployment. Old rows age out of the
60-second admission window naturally; no migration or data cleanup is required.
IPv4 rows retain their keys.

`test/throttle-client-key.test.ts` proves shared and distinct prefixes, mapped
IPv4 equivalence, unchanged IPv4 keys, fallback precedence and malformed values
through both middleware and in-handler guards, using an in-memory SQL double.
These tests do not claim a live Cloudflare IPv6 source-address probe. That
verification needs an authorized IPv6-capable client and a deployed revision;
client-supplied headers on a live request cannot stand in for distinct source
addresses.
