# W16 cutover gate

This ships the checker, **not a DNS flip or permission to perform one**.
Owner slice: [TOG-10841](/TOG/issues/TOG-10841); cutover execution belongs to
[TOG-9698](/TOG/issues/TOG-9698). URL contract: [url-freeze.md](url-freeze.md).

## Manual invocations (never CI)

Node 22+ and curl 7.72+ (`--write-out %{json}`) are required. CI's selftest
also uses openssl to create a disposable local TLS certificate.

```sh
# Before: Next candidate is still separate; apex must still identify as legacy.
node ci/cutover-check.mjs --phase before --target next.togetherweown.com --json

# After: the apex itself must identify as Next and be indexable.
node ci/cutover-check.mjs --phase after --target togetherweown.com --json
```

- `--target` is a DNS host, not a URL/IP/port. In `before` it must differ from
  the apex; in `after` it must equal the apex. `--apex` defaults to
  `togetherweown.com` and is configurable for fixtures/rehearsals.
- The checker requires a published future event: it selects the first `/e/{key}`
  from the target sitemap, or uses `--event-key <published-key>`. Missing data
  is a failure, not a skipped event/ICS check. `--member-id` defaults to `0`;
  this is an anonymous access-gate check, not a member-data read.
- Optional repeated `--expect-ip <ip>` arguments make an allowlist for **every**
  returned target A/AAAA address. Without it, DNS records are reported and
  must be nonempty; routing identity, not CDN IP equality, proves which app
  answered. Cloudflare can share IPs across legacy and Next.
- Exit **0** = every check passed, **1** = one or more findings, **2** = invalid
  invocation/setup. JSON contains the phase, target, overall `ok`, and named
  checks; transport failures never count as success or UNKNOWN. Each HTTP/TLS
  check has an `address` field (null if DNS failed). Every returned address is
  probed separately, and cached only by URL + address; one healthy edge cannot
  mask a legacy, broken-TLS or wrong-status address.

## Phase contract and prerequisites

| Check | Before | After |
|---|---|---|
| Target `/up` | 200, `X-TWO-Origin: two-web-next`, `no-store` | same, on apex |
| Apex `/up` | 200, `X-TWO-Origin: two-web` | 200, `X-TWO-Origin: two-web-next` |
| Target public HTML | unscoped `X-Robots-Tag: noindex` or `none` required | no header/meta indexing prohibition, including scoped search rules |
| Target archive HTML | universal noindex | still universal noindex |
| Robots | 200, sitemap on target origin; crawlable preview can expose noindex | same; all public probes crawlable for generic, Googlebot/Googlebot-News and Bingbot |
| Sitemap/canonical | HTTPS target origin (candidate) | HTTPS target origin (apex) |
| Apex HTTPS | direct 200 | direct 200 |
| HTTP apex, HTTP/www, HTTPS/www | 301/308 directly to HTTPS apex, preserving path/query | same |
| Frozen guest URLs and retired URLs | explicit per-route statuses on Next candidate | same on apex |

The legacy `/up` identity marker is an **execution prerequisite**: the frozen
Laravel app/edge must expose a fixed `X-TWO-Origin: two-web` (or the documented
value passed as `--legacy-identity`). Its absence fails the before gate; absence
of the Next marker alone does not prove Laravel identity. This PR adds only the
Next marker; it does not alter the frozen legacy deployment or edge config.
Likewise, the www/HTTP redirects are edge configuration gates, not new app
middleware. A green local selftest does **not** prove that these are deployed.

Indexing checks parse directive names and crawler scope: `max-image-preview:
none` limits image previews and does **not** prohibit indexing. A crawler-only
`googlebot: noindex` cannot satisfy the universal preview header guard. Repeated
X-Robots-Tag fields retain separate scopes. Robots parsing strips `#` comments,
combines matching groups, falls back to `*`, handles wildcard/end-anchor paths
and percent-encoding, and applies longest-rule/Allow-tie precedence. Thus `/`,
`/*` and slash-with-comment blocks fail; a disallow for an unrelated crawler
alone does not. Canonicals on the four static leaves use configured `APP_URL`,
not the request host or query string.

All HTTPS probes require a trusted certificate and matching hostname. A/AAAA
lookups are bounded (3 seconds, one try), with ENODATA allowed for a missing
family. SERVFAIL, NXDOMAIN, refusal or timeout fail closed. Measured DNS answers
are pinned into curl without changing SNI. Each transfer is bounded to 15
seconds and 2 MiB; redirects are measured without following them, including
Discord. No secrets, OAuth codes or session cookies are supplied or persisted.
No DNS, deploy, config, database client or write HTTP method is invoked by the
checker. **GET is not side-effect-free:** OAuth start/callback routes can record
throttles/failed join attempts. Execute live checks only in the authorized
cutover procedure; no live checks were run as part of this card's tests.

## Frozen coverage and limits

`URL_CASES` in `ci/cutover-check.mjs` explicitly maps every code-formatted
path/pattern in the URL-freeze tables. Adding an unmapped row fails the checker
and selftest. Concrete checks include guest `/events.json` 401, guest
profile/member/admin 302 to `/auth/discord`, `/join/callback` 200 recovery
without a code, login callback 302 to `/?n=signin_failed`, and 404s for retired
WordPress/PHP/Livewire surfaces. `/discord` must be exactly 302, no-store, to a
Discord **invite path**, not another OAuth or error URL. OAuth start Locations
must advertise the target-host callback.

Parameterized event routes use one published event; `/admin/*` uses `/admin`
and `/admin/events`. This is a guest/routing/SEO gate, not an exhaustive admin,
member, OAuth, write-back, event-state, queue-health or data-parity test. `/up`
can report unknown/degraded and still prove origin identity. Sitemap checks
accept the app's nonempty `urlset` (despite the `sitemap_index.xml` name); they
do not fetch child sitemaps or arbitrary URLs supplied by a remote response.
The checker does not certify a resolver's global propagation or prove what
every CDN POP serves; preserve the JSON plus timestamp for each approved
rehearsal/flip invocation.

## Local-only verification

```sh
npm run test:cutover
npm run check
```

`check` runs the selftest in the required CI job. Selftests use only loopback
HTTP/TLS servers, injected DNS stubs, disposable certificates and local files.
They do not query real domains, follow external redirects, use Discord secrets
or connect to any database. Vitest also feeds actual Hono-rendered static-leaf
HTML into the canonical/indexing gates in both phases (`test/cutover-routes.test.mjs`);
these are in-process requests with no database bindings or live sockets. The rest of the suite uses local fixtures when
`DATABASE_URL` is unset, or approved agent-testdb/CI service containers only.

Implementation references:
- [RFC 9309 robots parsing](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2)
- [Robots meta and X-Robots-Tag directive/scope syntax](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Hono local request testing](https://hono.dev/docs/api/hono#request) (environment binding overload verified in installed Hono types)
- [Node DNS Resolver API](https://nodejs.org/docs/latest-v24.x/api/dns.html#class-dnspromisesresolver)
- [curl --resolve](https://curl.se/docs/manpage.html#--resolve),
  [--disable](https://curl.se/docs/manpage.html#--disable) and
  [--write-out](https://curl.se/docs/manpage.html#--write-out) (verified with
  the installed curl 8.14.1 manual)
- Legacy `TogetherWeOwn/two-web/ci/cutover-check.mjs` (curl handshake rationale)
  and `ci/live-seo-probe.mjs` (retired URL set); WordPress account retirement,
  Automattic unbinding and plan/account actions are deliberately not ported.
