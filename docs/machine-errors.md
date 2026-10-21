# Machine errors

One vocabulary: every machine error carries a stable `code`, a human
`message`, a `request_id` for correlation, and a `next` naming one safe
action. `request_id` matches the `x-request-id` response header.

| Surface | Shape |
|---|---|
| REST (`/api/public/*`) | `{ error: { code, message, request_id, next } }` |
| Ingress (`POST /api/agent-events`) | `{ code, reason, message, request_id, next }`; `reason` is a deprecated alias of `code` |
| Feed 503s (`*.rss`, `*.ics`) | plaintext by default; the REST shape for `Accept: application/json` |
| MCP (`POST /mcp` transport) | JSON-RPC `{ jsonrpc, id: null, error: { code, message, data: { next, request_id } } }` |

REST codes: `internal`, `invalid_request`, `not_found`, `rate_limited`,
`unavailable` (`PUBLIC_DATA_ERROR_CODES`; never renamed). Ingress codes
equal the existing reasons. MCP transport uses `-32600` with a null id.

Kept as-is: throttled feeds stay plaintext `Too many requests`; MCP tool
results keep `{ error: { code, message } }`; success bodies never change.

Code: `src/public-data/contracts.ts`, `src/agent-events/envelope.ts`,
`src/events/routes-shared.ts`, `src/error-responses.tsx`,
`src/mcp/routes.ts`. REST schema: `GET /openapi.json`.
