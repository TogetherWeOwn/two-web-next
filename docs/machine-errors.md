# Machine errors

One vocabulary for covered transport errors: each carries a stable `code`,
a human `message`, a `request_id` for correlation, and a `next` naming one
safe action. On REST, feed and MCP surfaces `request_id` matches the
`x-request-id` response header; the ingress `request_id` is the audit-row
correlation id minted at admission.

| Surface | Shape |
|---|---|
| REST (`/api/public/*`) | `{ error: { code, message, request_id, next } }` |
| Ingress (`POST /api/agent-events`) | `{ code, reason, message, request_id, next }`; `reason` is a deprecated alias of `code` |
| Feed 503s (`*.rss`, `*.ics`) | plaintext by default, `Cache-Control: no-store` always; the REST shape for `Accept: application/json` |
| MCP (`POST /mcp` transport) | pre-handler refusals: JSON-RPC `{ jsonrpc, id: null, error: { code: -32600, message, data: { next, request_id } } }` |

REST codes: `internal`, `invalid_request`, `not_found`, `rate_limited`,
`unavailable` (`PUBLIC_DATA_ERROR_CODES`; never renamed). Ingress codes
equal the existing reasons.

Kept as-is: throttled feeds stay plaintext `Too many requests`; MCP tool
results keep `{ error: { code, message } }`; SDK protocol errors (malformed
JSON, bad `Accept`/version) keep their standard JSON-RPC codes without
`data`; success bodies never change.

Code: `src/public-data/contracts.ts`, `src/agent-events/envelope.ts`,
`src/events/routes-shared.ts`, `src/error-responses.tsx`,
`src/mcp/routes.ts`. REST schema: `GET /openapi.json`.
