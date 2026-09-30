# Request body budgets

Every registered POST, PUT, PATCH and DELETE has a transport byte limit before
body parsing. The shared middleware uses Hono `bodyLimit`, counts actual stream
bytes even with an understated or invalid `Content-Length`, and cancels the
source upload on overflow. An advertised over-budget length is rejected without
reading the body. Existing authentication, field validation and throttles remain
in place; authenticated-only route groups may reject a guest before the limiter.
Shared throttles run before buffering: oversized attempts consume admission
budget and an exhausted bucket returns 429 without pulling the upload. The QA
environment gate runs first, so a disabled seam always returns 404 without reads
or throttle queries. Source-read failures return a static 400; downstream route
and store exceptions still reach their existing handlers.

## Classes and derivation

The legacy revision behind the parity port is `e1e939a` (`docs/parity.md`). These
budgets derive from its field rules as ported into the current validators, not
from a newly verified nginx/PHP configuration. They are **wire-byte budgets**,
including field names, escaping, multipart boundaries and metadata:

| Class | Bytes | Routes | Basis |
| --- | ---: | --- | --- |
| `json` | 32,768 | Event create/PATCH (also accept forms) | Event title/game 100 each, description 1,000, location 255 (`src/admin/validation.ts`, `parseEventForm`). The 1,455 bounded UTF-16 code units need at most 13,095 bytes when percent-encoded (nine bytes per code unit); 32 KiB leaves room for dates, timezone, capacity and form/JSON framing. |
| `form` | 65,536 | Profile PATCH/form POST; admin event create/update | Profile bio 1,000 code points, games_text 1,700 (20 games × 80 plus separators), per legacy UpdateProfileRequest (`src/profiles/validation.ts`, `docs/w10-islands-respec.md`). 2,700 four-byte Unicode code points need at most 32,400 bytes when percent-encoded; 64 KiB accommodates form keys, `_method`, trap fields and multipart framing. Also covers the smaller admin event form. |
| `agent` | 32,768 | `/api/agent-events` | StoreEventRequest maxima: title/game 100, description 1,000, location 255, timezone 64 code points (`src/agent-events/service.ts`, `validateFields`), plus idempotency_key 255 UTF-16 units. Even JSON-escaped surrogate pairs fit well below 32 KiB with the operation/version/key envelope. |
| `featured` | 262,144 | Admin featured create/update | The four bounded title/URL/image/alt strings are 255 code units each (`src/admin/validation.ts`, `parseFeaturedForm`), but featured `body` has **no legacy field maximum in this port**. 256 KiB is an explicit new total editorial-body transport allowance, not a claim of legacy equivalence; large submissions receive 413 instead of consuming unbounded memory. |
| `action` | 4,096 | Logout, QA login, publish/cancel, featured delete, RSVP PUT/DELETE | Actions do not consume bodies; RSVP only needs an enum, optional caller ID and honeypot. 4 KiB leaves form/JSON overhead while preventing bodyless endpoints from accepting arbitrary uploads. DELETE RSVP does read its honeypot body. |

Validation still determines which inputs are legitimate. Trimming, game
normalization, unknown fields and some unrestricted ancillary fields mean there
is no finite mathematical maximum for every input previously accepted. These
limits intentionally bound that excess; they do not change field maxima or add
support for file uploads.

## Response and exception

Every shared-limit refusal is 413, `Cache-Control: no-store, private`, with no
submitted content, field names, limit internals or exception details. API routes
and callers accepting `application/json` get exactly:

```json
{"reason":"payload_too_large","message":"Reduce the size of your request and try again."}
```

Browsers receive the corresponding branded 413 page, following the existing
shared 429 content-negotiation convention.

`POST /csp-reports` deliberately retains its existing 8,192-byte capped reader
and always-204/drop behavior to avoid browser report retries. Its capped handler
identity and byte budget are pinned in the inventory assertion and the existing
CSP stream-cancellation tests. It is the sole exception to the shared 413 path,
not an exception to bounded bodies.

`test/body-limit.test.ts` enumerates the app's write routes, rejects any new
uncapped registration and pins the existing ALL-method middleware/fallback
paths. It tests every shared class at limit and limit+1, every registered limited
endpoint at both boundaries, misleading lengths, UTF-8 bytes and unbounded
chunked streams using memory sessions/local fixtures only. The separate local
`spike/hyperdrive-semantics` probe Worker is not a deployed app write route.
