# Human-route throttle client keys

`src/throttle.ts` builds each human-route throttle bucket from its route name
and a normalized client address. Budgets, the Postgres admission transaction,
the 60-second window, and the shared 429 response do not change.

## Address selection

The address is `CF-Connecting-IP` when present, otherwise the trimmed first hop
of `X-Forwarded-For`, otherwise `anon`. Cloudflare supplies `CF-Connecting-IP`
on edge requests; the other cases support off-edge tests and local runs. This
change does not make other forwarded headers trusted or change their precedence.

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
- Missing addresses still share `anon`. Malformed off-edge values retain their
  existing key; a parse failure never skips the throttle store.

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
Postgres advisory lock so concurrent bursts cannot overshoot. A missing store
or a store failure degrades to allow: a missed count beats a 500. The generic
path is [`checkJoinThrottle`](../src/join/service.ts); RSVP writes use
[`chargeThrottle`](../src/events/rsvp.ts) with the same shape.

| Budget | Value | Constant | Buckets and routes |
| --- | --- | --- | --- |
| Auth | 10 / 60 s | `AUTH_THROTTLE_PER_MINUTE` in [`src/throttle.ts`](../src/throttle.ts) | `login-redirect` (`GET /auth/discord`), `login-callback` (`GET /auth/discord/callback`), `qa-login` (`POST /auth/qa/:identity`) in [`src/index.tsx`](../src/index.tsx), `alert-probe` in [`src/alert-probe.ts`](../src/alert-probe.ts) |
| Join | 10 / 60 s | `JOIN_THROTTLE_PER_MINUTE` with `JOIN_THROTTLE_BUCKET = "join"` in [`src/join/service.ts`](../src/join/service.ts) | `join:<clientKey>:<minute>` shared by `GET /join/discord` and `GET /join/callback` in [`src/join/route.ts`](../src/join/route.ts) |
| Write | 30 / 60 s | `WRITE_THROTTLE_PER_MINUTE` in [`src/throttle.ts`](../src/throttle.ts) | `logout` (`POST /logout`) in [`src/index.tsx`](../src/index.tsx), `event-write` on the moderator event writes in [`src/events/routes.tsx`](../src/events/routes.tsx) |
| Profile write | 30 / 60 s | `PROFILE_WRITE_THROTTLE_PER_MINUTE` in [`src/profiles/routes.tsx`](../src/profiles/routes.tsx) | `profile-write:<viewerId>` per member on profile writes |
| Public event reads | 60 / 60 s | `PUBLIC_EVENT_READS_PER_MINUTE` in [`src/events/routes.tsx`](../src/events/routes.tsx) | `events-read:<clientKey>` across public event pages and feeds; see [`docs/event-read-admission.md`](event-read-admission.md) |
| RSVP write | 12 / 60 s | `RSVP_RATE_LIMIT` (`maxAttempts: 12`, `decaySeconds: 60`) in [`src/islands/contracts.ts`](../src/islands/contracts.ts) | `rsvp-write:<userId>` per member, shared by RSVP PUT and DELETE across events in [`src/events/rsvp.ts`](../src/events/rsvp.ts) |

Generic and join buckets key on the client key above (`<name>:<clientKey>`);
RSVP and profile-write buckets key on the member id instead, so switching verb
or path cannot multiply the budget. The join bucket additionally carries the
current minute, but the 60-second row window still judges admission. Policy
refusals return before the hit is stamped and spend nothing.

## Prune and storage bound

There is no background job. Expired rows are deleted piggyback on admissions at
two call sites, both with a 5-minute bound:

- [`src/join/service.ts`](../src/join/service.ts) (`checkJoinThrottle`): after a
  successful admission only, outside the per-bucket admission lock transaction,
  `DELETE FROM web_throttle_hits WHERE at < now() - interval '5 minutes'`.
  Denied requests skip this cleanup so it never prolongs the lock.
- [`src/events/rsvp.ts`](../src/events/rsvp.ts) (`pruneThrottle`, called from
  `writeRsvp` and both `withdrawRsvp` paths): inside the same transaction,
  before the budget charge and the write,
  `delete from web_throttle_hits where at < clock_timestamp() - interval '5 minutes'`.
  It must run before any accept/charge decision, never between the debit and
  the write.

The admission window reads `clock_timestamp()` (the lock wait does not stretch
the window); the join-path prune uses `now()`. The table and its
`(bucket, at)` index are created in
[`drizzle/1000_join-attempts-throttle.sql`](../drizzle/1000_join-attempts-throttle.sql),
mirrored by the `web_throttle_hits` runtime DDL in
[`src/join/service.ts`](../src/join/service.ts) and the Drizzle shape in
[`src/db/schema.ts`](../src/db/schema.ts). The 5-minute retention is five times
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
