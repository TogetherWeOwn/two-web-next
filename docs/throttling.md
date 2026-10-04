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
