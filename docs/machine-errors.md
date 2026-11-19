# Machine errors

Covered errors carry a stable `code`, a human `message`, a correlation
`request_id`, and a `next` naming one safe action. The ID matches `x-request-id`
on REST, feed and MCP. Ingress uses the admission ID (stored in audit rows for
audited denials), or the header ID for pre-service denials.

| Surface | Shape |
|---|---|
| REST (`/api/public/*`) | `{ error: { code, message, request_id, next } }` |
| Ingress (`POST /api/agent-events`) | `{ code, reason, message, request_id, next }`; `reason` is a deprecated alias of `code` |
| Feed 503s (`*.rss`, `*.ics`) | plaintext by default, `Cache-Control: no-store` always; the REST shape for `Accept: application/json` |
| MCP (`POST /mcp` transport) | pre-handler refusals: JSON-RPC `{ jsonrpc, id: null, error: { code: -32600, message, data: { next, request_id } } }` |

REST codes (`PUBLIC_DATA_ERROR_CODES`; never renamed): `internal`,
`invalid_request`, `not_found`, `rate_limited`, `unavailable`. Ingress codes equal the existing reasons.

Throttled feeds stay plaintext `Too many requests`; MCP tool results keep
`{ error: { code, message } }`; SDK protocol errors (malformed JSON, bad
`Accept`/version) keep standard JSON-RPC codes without `data`. Success bodies never change.

Code: `src/public-data/contracts.ts`, `src/agent-events/envelope.ts`,
`src/events/routes-shared.ts`, `src/error-responses.tsx`, `src/mcp/routes.ts`. REST schema: `GET /openapi.json`.

Future REST adapters can use [`withMachineErrors`](../src/http/machine-error.ts)
with a registered route pattern, never a raw path. It preserves returned responses
and maps throws and rejections to a no-store `500 internal` with a validated ID.

## Write refusals

The write surfaces (RSVP, moderator event writes, profile saves,
expired-write recovery and the same-origin guard) answer every JSON refusal
with one envelope, built by `jsonRefusal` in `src/json-refusal.ts`:

`{ error, request_id, ...extra }`

`error` is a fixed lowercase code from the table below, never renamed.
`request_id` is the log correlation id that `requestLog` also puts on
`x-request-id`; it is omitted only where no `requestLog` context exists (a
bare mount). Status codes, auth policy and rate limits are unchanged. Browser
callers keep their HTML and text bodies: only JSON callers (an exact
`application/json` range in `Accept`, or a JSON-only route) get the envelope.

| Code | Status | Extra keys | Meaning |
|---|---|---|---|
| `unauthenticated` | 401 | `recovery` on expired writes | No session, or the session died; follow `recovery` when present. |
| `forbidden` | 403 | `message` on profile writes | Signed in but not allowed to do this. |
| `cross_origin` | 403 | none | The write came from an untrusted origin. |
| `not_found` | 404 | none | No such event or member. |
| `method_not_allowed` | 405 | none | Wrong verb; the `Allow` header lists the right ones. |
| `unsupported_media_type` | 415 | none | Send JSON (or a form where the route takes one). |
| `invalid` | 422 | `fields` | Validation failed; `fields` maps each field name to a string message, except on RSVP where the value is a list of strings. |

Not part of this envelope: the 429 throttle shape above, `event_not_open`
RSVP refusals (`reason`), and 503 `db_unavailable`.

Offline: `npm run check:refusals` prints one JSON summary and exits 1 on code
list drift or a capitalized `error` code in `src/`. It is read-only and needs no
network or database.
