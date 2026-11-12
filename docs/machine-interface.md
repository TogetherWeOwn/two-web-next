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
- Every event result fits 32 KiB, measured on the whole serialized MCP
  tool result (text and `structuredContent` copies plus SDK metadata).
  REST serves the same DTO bytes, so its body is smaller. Long
  descriptions trim with a `…` marker, rows are never dropped. The
  JSON-RPC envelope and HTTP framing are not counted.
- A trimmed MCP event result adds a second text block that says so and
  how to read more: a smaller `per_page`, `get_event`, or the event page.
- Events are published-only: drafts and cancelled rows read as not found.
- Unknown counts read as `null`, never `0` (`going_count`,
  `going_occupancy`, `member_count`, `online_count`).

## Conditional reads

The four public REST reads accept `If-None-Match`. Save the `ETag` from a
successful response and send it on a later request for the same representation.
A matching validator returns `304 Not Modified` without a body; exact and weak
tags, comma-separated lists and `*` are supported. A non-match returns the
normal `200` representation. These reads do not use `If-Modified-Since`.

Admission and the shared public-read rate limit still apply before a `304`:
a refused request can return `429` instead. Both `200` and `304` carry the
validator and cache policy. A cached event response advertises only its remaining
freshness, not a renewed 60-second window; a read overtaken by retirement uses
`public, max-age=0, must-revalidate`. Event invalidation is isolate-local, so
other isolates can serve their cached representation until its TTL expires.

`GET /openapi.json` also supports ETag revalidation, independently of the four
public-read routes and their shared admission budget. Its cache lifetime is one
hour; it is not itself one of the four operations described by the OpenAPI
`paths` object.

## Errors

Failures keep `isError` on MCP and `{ error: { code, message } }` on
REST and in the MCP text content. Codes and next actions:

| Code | Meaning | Next action |
| ---- | ------- | ----------- |
| `invalid_request` | Rejected input, e.g. a malformed event key. | Fix the input and try again. |
| `not_found` | No published row for that key. | Check the key and try again. |
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
