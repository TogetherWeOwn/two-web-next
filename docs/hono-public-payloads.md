# Hono public payloads: the no-member-data contract

Anonymous content responses must not publish member Discord IDs or usernames,
authorship snowflakes, member emails, or session bearers. This covers HTML,
JSON, Markdown, RSS, ICS and vanity redirects. It does not remove the audited
reads used by member- and moderator-gated routes.

## Run it

```sh
npm run check:hono-payloads -- --format json
node ci/check-hono-payloads.mjs --format json | jq .ok
npx vitest run test/hono-no-member-data-contract.test.ts test/hono-payload-gate.test.mjs
```

The CLI writes pure JSON to stdout, a short verdict to stderr, and exits 0 only
on success. `checks` has stable `hono-payload:*` IDs, route, status and executed
test count. `controls` includes detector sensitivity, preserved member reads,
and mounted-route coverage. Both suites run under the existing `npm test` and
CI coverage commands; no production flags or network fixtures are needed.

## Source of truth and drift

`PUBLIC_HONO_GETS` in [the acceptance suite](../test/hono-no-member-data-contract.test.ts)
is the content-route table. The CLI parses that literal table rather than
copying it. Each row must map to an executed passing payload test. A new,
missing, unmapped, failed or skipped result fails closed.

[The gate](../ci/check-hono-payloads.mjs) also classifies the assembled Hono
GET registrations using the existing route-inventory helper. The two regex
file routes map to the Markdown/ICS rows; the signal registration maps to all
three tested hotzone signals. Unknown public GETs and stale classifications
fail. The small auxiliary set (`/.well-known/security.txt`, `/members`,
`/members/`) has fixed-response checks in the gate's neighboring suite.

Auth and join OAuth/session endpoints deliberately issue state/session
artifacts and retain their existing auth-suite contracts. `/up` retains its
independent readiness contract and tests. These exact exclusions are named
with their owning tests in the gate; they are not a prefix exemption. Gated
routes retain the route inventory's reviewed access labels and existing
access/audit tests. Static files served by the Workers asset binding are not
Hono GET registrations.

The CLI runs the real hostile-fixture suite, excluding only its own calling-gate
assertion to avoid recursion. A normal Vitest run executes that assertion too.
Missing reports, process errors, non-successful suite reports, vacuous checks
and mapping drift all fail the CLI.

## Detector limits and fixes

The detector follows the Kit convention: planted member snowflakes,
bidi/Unicode names, an email-shaped username, bearer shape (`two_` plus 43
base64url characters), and route-specific forbidden keys. Presence assertions
prove that real event rows, counts and feeds rendered. Member-route negative
controls prove the detector fires on member data while those reads still work.

This is a regression contract, not a universal PII classifier. Public event and
guild IDs are permitted where required for public Discord links; the public
JSON DTO excludes the raw Discord event ID. Privacy text legitimately names
cookie names, ICS UIDs use `eventKey@host`, and security.txt intentionally names
the public disclosure mailbox. A blanket snowflake/email/cookie-prefix regex
would reject those non-member values.

If a new payload leaks, narrow the read/load projection, never scrub the
rendered response. For a new anonymous content route, coordinate an independent
hostile-fixture test and stable table row with the acceptance-test maintainer.
Do not silently classify it as gated or extend the exclusions to make CI pass.
