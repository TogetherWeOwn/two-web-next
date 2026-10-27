# Machine interface

Short contract for agents reading Together We Own over HTTP or MCP.
Human-facing docs live elsewhere in this directory; this file is the
machine surface only.

## Endpoints

- `POST /mcp` — JSON-RPC MCP server, protocol `2025-06-18`, no auth and
  no session. Four read-only tools: `list_events`, `get_event`,
  `get_community`, `get_join`. Every tool advertises a typed
  `outputSchema` through `tools/list`; success results carry
  `structuredContent` matching it.
- `GET /openapi.json` — OpenAPI 3.1 for the REST mirrors:
  `/api/public/events`, `/api/public/events/{key}`,
  `/api/public/community`, `/api/public/join`. Same DTOs as the MCP
  tools, byte for byte.
- `GET /llms.txt` — page index plus the links above.

## Limits

- Collections cap at 20 rows per response (`per_page` clamps to 20);
  past-the-end pages clamp to the last page.
- Every JSON body fits 32 KiB: long descriptions trim with a `…`
  marker, rows are never dropped.
- Events are published-only: drafts and cancelled rows read as not found.
- Unknown counts read as `null`, never `0` (`going_count`,
  `going_occupancy`, `member_count`, `online_count`).

## Conditional reads

The four REST reads send an `ETag`. Repeat it in `If-None-Match` (exact,
weak `W/`, comma list or `*`) and a match answers an empty `304` with
`ETag` and `Cache-Control`. Admission runs first: a spent budget is `429`,
never `304`. Freshness is what remains of the 60s window, and retirement
is per isolate, so other isolates converge on TTL expiry. There is no
`If-Modified-Since`.

## Errors

Failures keep `isError` on MCP and `{ error: { code, message } }` on
REST and in the MCP text content; REST errors also carry `request_id` (matches
`x-request-id`) and `next`. Every unknown path under `/api/public` answers
404 `not_found` as JSON (GET and HEAD, never HTML). Codes and next actions:

| Code | Meaning | Next action |
| ---- | ------- | ----------- |
| `invalid_request` | Rejected input, e.g. a malformed event key. | Fix the input and try again. |
| `not_found` | No published row for that key, or an unknown `/api/public/*` path. | Check the key and try again. |
| `rate_limited` | Shared public-read budget exhausted. | Honor `Retry-After`, then try again. |
| `unavailable` | Event data temporarily unreadable. | Wait and try again. |
| `internal` | The read failed on our side. | Wait and try again. |

Sign-in and joining stay in the browser and Discord: there are no
OAuth, login, member-directory or write tools. Nothing here grants
model-training permission.

## Contract check

Run the offline check (no database, no network):

`npm run check:machine-contract`

It exits 0 when this guide, `/llms.txt` discovery and the advertised
MCP output schemas all match the canonical contract.
