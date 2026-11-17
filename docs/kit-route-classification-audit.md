# Kit route classification source audit

Source revision: `b29d5a8dbe6d7be96f3c07a0f143ac22b8eea339`, observed as
`origin/main` on 2026-11-16. This is a planning audit, not a parity or traffic
ownership claim. The post-Ember mounted-map and pure-Hono golden refresh remains
a separate release prerequisite.

The [route map](kit-route-map.md) contains 116 method/path rows. The mounted
app comparison in [`test/route-kit-snapshot.test.ts`](../test/route-kit-snapshot.test.ts)
checks methods, paths and inventory auth labels, not classifications;
[`test/route-inventory.test.ts`](../test/route-inventory.test.ts) checks the separate
inventory. Their exact-revision execution is required; a
static source read is not a mounted-app test or an authorization proof.

## Classification evidence

- The legacy `GET /auth/discord/redirect` forwards to Discord login in
  [`src/auth/routes.ts`](../src/auth/routes.ts). The [retirement register](adr/0001-sveltekit-page-renderer.md#non-page-contracts-hono-through-m0-post-m0-migration-is-direction-only)
  places it in OAuth and session, alongside `/auth/discord`; the map now assigns
  it to API-6 `auth` rather than API-3 `ops`. Its URL, target and auth label do
  not change.
- The six middleware rows and 11 method-fallback rows are distinct from
  endpoints. The fallback registrations are the explicit admin method arrays in
  [`src/admin/routes.tsx`](../src/admin/routes.tsx) and the RSVP `ALL` handler in
  [`src/events/routes-rsvp.tsx`](../src/events/routes-rsvp.tsx); their handlers return 405.
- The 11 `pageAndEndpoint` rows cover four admin page/write pairs and the member
  page with its POST and PATCH writes. A shared method/path alone is not enough:
  `GET /events` and `POST /events` share a proposed endpoint, while
  `GET /events/:key` returns JSON. Neither pair implies a Kit page and endpoint.
  Page-cutover scope identifies responsibility, not a requirement that the target
  be `+page.svelte`.
- The 18 ETag-marked GET rows correspond to the markdown, event JSON/feed,
  public JSON and OpenAPI response helpers in [`src/ai-friendly/routes.ts`](../src/ai-friendly/routes.ts),
  [`src/events/routes-shared.ts`](../src/events/routes-shared.ts),
  [`src/events/routes-feeds.ts`](../src/events/routes-feeds.ts) and
  [`src/public-data/routes.ts`](../src/public-data/routes.ts). ETag marks a contract to review, not a promise
  that every error branch emits one.
- The two multi-segment suffix patterns remain unresolved; matcher precedence
  and single- and multi-segment behavior still need independent proof.

The case-level completion guard remains a separate [in-flight change](https://github.com/TogetherWeOwn/two-web-next/pull/2310).
An inventory match, a target file or a source citation does not establish passing
case evidence. Completion declarations stay empty until that evidence is integrated
and the relevant exact-head checks pass.
