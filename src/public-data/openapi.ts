// Served OpenAPI 3.1 document for the bounded public read API. The schemas
// are built from the contracts.ts field lists, so `serializer output == spec
// required == field list` is asserted in test/api-public-openapi.test.ts —
// the spec cannot drift from the code it documents.
import {
  API_PUBLIC_BOUNDS,
  COMMUNITY_RANK_FIELDS,
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
} from "./contracts";

export interface JsonSchema {
  type: string | string[];
  format?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

type EventField = (typeof PUBLIC_API_EVENT_FIELDS)[number];

const EVENT_PROPERTIES: Record<EventField, JsonSchema> = {
  event_key: { type: "string", description: "Stored uppercase ULID, never the database row id." },
  title: { type: "string" },
  game: { type: ["string", "null"] },
  description: { type: ["string", "null"], description: "Trimmed with a … marker past 32 KiB." },
  starts_at: { type: "string", format: "date-time" },
  ends_at: { type: "string", format: "date-time" },
  starts_at_local: { type: "string", description: "Wall reading in the event timezone." },
  ends_at_local: { type: "string", description: "Wall reading in the event timezone." },
  timezone: { type: "string" },
  location: { type: ["string", "null"] },
  capacity: { type: ["integer", "null"] },
  going_count: {
    type: ["integer", "null"],
    description:
      "Attributable going RSVPs (named members only, matching the roster), or null when the rollup is unavailable — never 0 by default. Use going_occupancy for seats.",
  },
  going_occupancy: {
    type: ["integer", "null"],
    description:
      "Seat occupancy: every going row including nameless ones, like the write path counts it. Full when it reaches capacity; null when the rollup is unavailable.",
  },
  status: { type: "string", enum: ["published"] },
  rsvp_open: { type: "boolean" },
  synced_to_discord: {
    type: "boolean",
    description: "Derives from the mirror column; the raw Discord id never leaves the server.",
  },
};

const RANK_PROPERTIES: Record<(typeof COMMUNITY_RANK_FIELDS)[number], JsonSchema> = {
  key: { type: "string" },
  label: { type: "string" },
  member_count: { type: ["integer", "null"] },
};

const COMMUNITY_PROPERTIES: Record<(typeof COMMUNITY_SNAPSHOT_FIELDS)[number], JsonSchema> = {
  member_count: {
    type: ["integer", "null"],
    description: "Null when the collector is unavailable — never 0 by default.",
  },
  online_count: {
    type: ["integer", "null"],
    description: "Null when the collector is unavailable — never 0 by default.",
  },
  ranks: {
    type: "array",
    items: { type: "object", properties: RANK_PROPERTIES, required: [...COMMUNITY_RANK_FIELDS] },
  },
};

const JOIN_PROPERTIES: Record<(typeof JOIN_HANDOFF_FIELDS)[number], JsonSchema> = {
  intro: { type: "string" },
  invite_url: { type: "string", format: "uri" },
};

function error(status: number, description: string) {
  return {
    description,
    // OpenAPI 3.1 allows headers on the Response Object only; the Media
    // Type Object takes schema/examples/encoding. A Retry-After under the
    // media type fails schema validation on every 429.
    ...(status === 429 ? { headers: { "Retry-After": { schema: { type: "integer" } } } } : {}),
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/PublicDataError" },
      },
    },
  };
}

/**
 * These served descriptions are the single source for paging coercion rules.
 * Consistency and behavioral tests pin the alias, ceiling, integer-prefix
 * page parsing, defaults and clamp-to-last-page behavior (never a 422).
 */
const PAGING_PARAMETERS = [
  {
    name: "page",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: API_PUBLIC_BOUNDS.maxPage, default: 1 },
    description:
      "1-based page. Accepts a leading integer prefix (2abc and 2.9 read as 2), " +
      "with optional sign and leading whitespace. Invalid or malformed values " +
      "without an integer prefix, or values below 1, fall back to the default 1; " +
      `out-of-range values are coerced: capped at the maximum ${API_PUBLIC_BOUNDS.maxPage} pages, then ` +
      "clamped to the last page. Never a 422.",
  },
  {
    name: "per_page",
    in: "query",
    schema: {
      type: "integer",
      minimum: 1,
      maximum: API_PUBLIC_BOUNDS.maxPageSize,
      default: API_PUBLIC_BOUNDS.defaultPageSize,
    },
    description:
      "Rows per page. Invalid or malformed values fall back to the default 20; " +
      "out-of-range values are clamped and coerced to 1..20. Takes precedence " +
      "over the limit alias when both are present.",
  },
  {
    name: "limit",
    in: "query",
    schema: {
      type: "integer",
      minimum: 1,
      maximum: API_PUBLIC_BOUNDS.maxPageSize,
      default: API_PUBLIC_BOUNDS.defaultPageSize,
    },
    description:
      "Alias for per_page with identical bounds and defaults. Invalid or " +
      "malformed values fall back to the default 20; out-of-range values are " +
      "clamped and coerced to 1..20. Ignored when per_page is present.",
  },
];

function jsonRef(name: string, description: string) {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
    },
  };
}

/** The document served at GET /openapi.json. Pure function of the public base URL. */
export function getOpenApiDocument(appUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Together We Own public read API",
      version: "1.0.0",
      description:
        "Session-free, published-only reads for search and AI assistants: events, one event, " +
        "the community snapshot and the Discord join handoff. No member directory, no " +
        "attendee identities, no model-training permission. Collections cap at 20 rows and " +
        "32 KiB; errors use { error: { code, message, request_id, next } } with code internal, " +
        "invalid_request, not_found, rate_limited or unavailable. request_id matches the " +
        "x-request-id response header for correlation; next names one safe action. " +
        "On internal, retry the read; the envelope never carries exception text. Freshness: a cache " +
        "hit carries only the remaining freshness of the original 60s window — a hit " +
        "just before expiry answers max-age=1, never a fresh full window — and a " +
        "fresh miss re-arms the full 60s bound. Committed moderator or agent " +
        "create, update, publish and cancel operations retire collection and " +
        "detail entries in the mutating isolate at once (pause/reopen and RSVP " +
        "writes stay TTL-bounded); same-isolate retirement is not a global " +
        "edge purge, so every other isolate converges on TTL expiry.",
    },
    servers: [{ url: appUrl }],
    paths: {
      "/api/public/events": {
        get: {
          summary: "Published events, soonest first",
          parameters: PAGING_PARAMETERS,
          responses: {
            "200": jsonRef("PublicApiEventCollection", "At most 20 published events."),
            "429": error(429, "Shared public-read budget exhausted."),
            "500": error(500, "Unexpected failure reading event data. Try again shortly."),
            "503": error(503, "Event data temporarily unavailable."),
          },
        },
      },
      "/api/public/events/{key}": {
        get: {
          summary: "One published event",
          parameters: [
            {
              name: "key",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Stored uppercase ULID event key.",
            },
          ],
          responses: {
            "200": jsonRef("PublicApiEvent", "The published event."),
            "404": error(404, "No published event with that key (drafts and cancelled rows 404)."),
            "422": error(422, "That event key is not valid."),
            "429": error(429, "Shared public-read budget exhausted."),
            "500": error(500, "Unexpected failure reading event data. Try again shortly."),
            "503": error(503, "Event data temporarily unavailable."),
          },
        },
      },
      "/api/public/community": {
        get: {
          summary: "Community snapshot",
          responses: {
            "200": jsonRef(
              "CommunitySnapshot",
              "Live counts, null when the collectors are unavailable.",
            ),
            "429": error(429, "Shared public-read budget exhausted."),
          },
        },
      },
      "/api/public/join": {
        get: {
          summary: "Join handoff",
          description: "Joining happens in Discord only; this is the public invite.",
          responses: {
            "200": jsonRef("JoinHandoff", "The public invite and intro."),
            "429": error(429, "Shared public-read budget exhausted."),
          },
        },
      },
    },
    components: {
      schemas: {
        PublicApiEvent: {
          type: "object",
          properties: EVENT_PROPERTIES,
          required: [...PUBLIC_API_EVENT_FIELDS],
        },
        PublicApiEventCollection: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: "#/components/schemas/PublicApiEvent" } },
            page: { type: "integer" },
            limit: { type: "integer" },
            meta: {
              type: "object",
              properties: {
                current_page: { type: "integer" },
                per_page: { type: "integer" },
                total: { type: "integer" },
                last_page: { type: "integer" },
              },
              required: ["current_page", "per_page", "total", "last_page"],
            },
          },
          required: ["data", "page", "limit", "meta"],
        },
        CommunitySnapshot: {
          type: "object",
          properties: COMMUNITY_PROPERTIES,
          required: [...COMMUNITY_SNAPSHOT_FIELDS],
        },
        CommunityRank: {
          type: "object",
          properties: RANK_PROPERTIES,
          required: [...COMMUNITY_RANK_FIELDS],
        },
        JoinHandoff: {
          type: "object",
          properties: JOIN_PROPERTIES,
          required: [...JOIN_HANDOFF_FIELDS],
        },
        PublicDataError: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: ["internal", "invalid_request", "not_found", "rate_limited", "unavailable"],
                },
                message: { type: "string" },
                request_id: {
                  type: "string",
                  description: "Matches the x-request-id response header, for correlation.",
                },
                next: { type: "string", description: "One safe next action for the caller." },
              },
              required: ["code", "message", "request_id", "next"],
            },
          },
          required: ["error"],
        },
      },
    },
  };
}
