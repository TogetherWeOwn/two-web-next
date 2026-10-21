# Request body budgets

Every registered POST, PUT, PATCH and DELETE has a transport byte limit before
body parsing. The shared middleware uses Hono `bodyLimit`, counts actual stream
bytes even with an understated or invalid `Content-Length`, and cancels the
source upload on overflow. An advertised over-budget length is rejected without
reading the body. Existing authentication, field validation and throttles remain
in place; authenticated-only route groups may reject a guest before the limiter.
The global trusted-host and same-origin gates run before route admission or
buffering; the same-origin ingress/CSP exemptions retain bounded body handling.
Except for the event-write, admin event form, admin action, featured
write, staging alert probe, profile write, logout and QA-login routes
below, shared throttles run before buffering: oversized attempts consume
admission budget and
an exhausted bucket returns 429 without pulling the upload. The profile write
routes enforce the form cap before throttle and session work, so an oversized
body returns 413 with zero throttle spend and no session or store read, and an
exhausted bucket returns 429 only for bodies at or under the cap. Profile owner
policy runs after the cap; other moderator write authentication runs before
buffering, read once, without rotation.

`POST /events`, `PATCH /events/:key` and the four `POST /events/:key/` actions
(`publish`, `cancel`, `rsvp-pause`, `rsvp-reopen`) likewise apply the existing body
cap before the shared throttle and moderator authentication. Oversized advertised
or streamed bodies return 413 without throttle rows or session reads, even when
the throttle budget is exhausted. At or under the cap, requests still run the
throttle then moderator authentication, retaining the existing 429, 401 and 403
refusals.

`POST /admin/events` and `POST /admin/events/:key` apply the `form` cap before
the `admin-write` throttle, after the admin guard. An oversized body from a
signed-in moderator returns 413 with zero throttle spend and no store read, even
when the budget is exhausted. Guest 401 and non-moderator 403 refusals still run
first, oversized or not; at or under the cap, moderator posts still spend one
throttle hit before validation and the store.

Admin lifecycle actions (`POST /admin/events/:key/publish`, `/cancel`,
`/rsvp-pause`, `/rsvp-reopen`) and queue redispatch
(`POST /admin/queue/failed/:id/redispatch`) run the wire cap first instead: an
oversized moderator body returns 413 with zero admin-write throttle spend and no
store work, and stays 413 when the budget is already spent.

`POST /admin/featured` (featured cap), `POST /admin/featured/:id`
(featured cap) and `POST /admin/featured/:id/delete` (action cap) likewise
decide the cap before the admin-write throttle: an oversized body is 413
with zero throttle spend even when the budget is already spent. The
moderator guard still runs first on those routes.

The staging alert probe is likewise cap-first: its body cap runs before its
throttle (after the QA gate), so an over-cap probe returns 413 with no throttle
spend.
Agent ingress runs its byte cap first: an over-cap body returns 413 with no
SQL, shield charge or client. Under-cap bodies are buffered, then the
enabled/store configuration gate runs (404/503 without SQL), then the
credential/IP shield admits once, and the SQL client opens only after the
buffered body reaches EOF. Its bound service handler does not charge a second
shield hit; the SQL client is closed on shield refusals and normal replies
(413 and source-read failures never reach admission, so no client opens for
them).
The QA environment gate runs first, so a disabled seam always returns 404 without
reads or throttle queries. `POST /logout` and `POST /auth/qa/:identity` (after
its QA identity/token gate) apply the `action` cap before the throttle: an
oversized body returns 413 with zero throttle-budget spend even when the bucket
is exhausted, while bodies at or under the cap keep the existing
throttle-then-work order. Unauthenticated QA probes still 404 at the gate
before either. Source-read failures return a static 400; downstream
route and store exceptions still reach their existing handlers.

## Classes and derivation

The legacy revision behind the parity port is `e1e939a` (`docs/parity.md`). These
budgets derive from its field rules as ported into the current validators, not
from a newly verified nginx/PHP configuration. They are **wire-byte budgets**,
including field names, escaping, multipart boundaries and metadata:

| Class | Bytes | Routes | Basis |
| --- | ---: | --- | --- |
| `json` | 32,768 | Event create/PATCH (also accept forms) | Event title/game 100 each, description 1,000, accessibility notes 1,000, location 255 (`src/admin/validation.ts`, `parseEventForm`). The 2,455 bounded UTF-16 code units need at most 22,095 bytes when percent-encoded (nine bytes per code unit); 32 KiB leaves room for dates, timezone, capacity and form/JSON framing. |
| `form` | 65,536 | Profile PATCH/form POST; admin event create/update | Profile bio 1,000 code points, games_text 1,700 (20 games × 80 plus separators), per legacy UpdateProfileRequest (`src/profiles/validation.ts`, `docs/w10-islands-respec.md`). 2,700 four-byte Unicode code points need at most 32,400 bytes when percent-encoded; 64 KiB accommodates form keys, `_method`, trap fields and multipart framing. Also covers the smaller admin event form. |
| `agent` | 32,768 | `/api/agent-events` | StoreEventRequest maxima: title/game 100, description 1,000, location 255, timezone 64 code points (`src/agent-events/payload.ts`, `validateFields`), plus idempotency_key 255 UTF-16 units. Even JSON-escaped surrogate pairs fit well below 32 KiB with the operation/version/key envelope. |
| `mcp` | 32,768 | `POST /mcp` | JSON-RPC request envelope plus tool arguments (event key 26 chars, paging integers). Tool calls carry filters, never content; 32 KiB matches the `json`/`agent` tier and the public API's 32 KiB response budget. |
| `featured` | 262,144 | Admin featured create/update (cap-first) | The four bounded title/URL/image/alt strings are 255 code units each and featured `body` is 1,000 Unicode code points after trim (`src/admin/validation-featured-form.ts`, `parseFeaturedForm`); over-max bodies 422 with a field-level error. 256 KiB is the unchanged total editorial-body transport allowance, not a claim of legacy equivalence; large submissions still receive 413 before validation instead of consuming unbounded memory. The create and update posts decide the cap before the admin-write throttle (zero spend on 413). |
| `action` | 4,096 | Logout (cap-first), QA login (cap-first), staging alert probe (cap before throttle: over-cap probes 413 with no throttle spend), publish/cancel, RSVP pause/reopen (public and admin), queue redispatch, featured delete (cap-first), RSVP PUT/DELETE | Actions do not consume bodies; RSVP only needs an enum, optional caller ID and honeypot. 4 KiB leaves form/JSON overhead while preventing bodyless endpoints from accepting arbitrary uploads. DELETE RSVP does read its honeypot body. Logout, QA login, featured delete, the staging alert probe, the four public `POST /events/:key/` actions, the four admin lifecycle actions and queue redispatch decide the cap before their throttle; the remaining throttled action routes keep the throttle-before-buffering order. |

Validation still determines which inputs are legitimate. Trimming, game
normalization, unknown fields and some unrestricted ancillary fields mean there
is no finite mathematical maximum for every input previously accepted. These
limits intentionally bound that excess; they do not change field maxima or add
support for file uploads.

## Response and exception

Every shared-limit overflow refusal is 413, `Cache-Control: no-store, private`, with no
submitted content, field names, limit internals or exception details. API routes
and callers accepting `application/json` get exactly:

```json
{"reason":"payload_too_large","message":"Reduce the size of your request and try again."}
```

Browsers receive the corresponding branded 413 page, following the existing
shared 429 content-negotiation convention.

`POST /mcp` uploads are the exception: over-cap and broken uploads answer the
route-native JSON-RPC error whatever `Accept` says (absent, wildcard or HTML
included), keeping the 413/400 status, the upload cancellation and the
cap-before-admission order. The id is always null — the upload fails before
any request id is known — and the code is the static transport code -32600:

```json
{"jsonrpc":"2.0","id": null,"error":{"code":-32600,"message":"Reduce the size of your request and try again."}}
```

A failed source read on `POST /mcp` answers the same shape with 400 and
`{"jsonrpc":"2.0","id": null,"error":{"code":-32600,"message":"Check your request and try again."}}`.
Both refusals send `Cache-Control: no-store, private` and merge `Accept`
into `Vary`, with no submitted bytes or exception details.

A failed source read instead returns 400 through the shared `badRequest`
helper. API routes and JSON-only event writes always receive
`{"error":"bad_request","message":"Check your request and try again."}`;
other routes negotiate JSON or the branded “Check your request” page using
Accept quality and specificity. Feed paths (`.ics`, `.rss`, `.md`, `/llms.txt`)
retain the exact plaintext `Bad request`. These refusals send
`Cache-Control: no-store, private` and merge `Accept` into `Vary`. No source
exception or submitted bytes enter the response, and the route is not called.
Malformed profile and admin form bodies use this same 400 contract.

`POST /csp-reports` deliberately retains its existing 8,192-byte capped reader
and always-204/drop behavior to avoid browser report retries. Its capped handler
identity and byte budget are pinned in the inventory assertion and the existing
CSP stream-cancellation tests. It is the sole exception to the shared 413 path,
not an exception to bounded bodies.

`test/body-limit.test.ts` enumerates the app's write routes, rejects any new
uncapped registration and pins the existing ALL-method middleware/fallback
paths. It tests every shared class at limit and limit+1, every registered limited
endpoint at both boundaries, misleading lengths, UTF-8 bytes and unbounded
chunked streams using memory sessions/local fixtures only. Admission regressions
also assert zero upload pulls and no throttle queries when trusted-host or
same-origin gates refuse advertised and chunked overflow. The separate local
`spike/hyperdrive-semantics` probe Worker is not a deployed app write route.
