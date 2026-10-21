/** Shared, intentionally allowlisted contract for public data reads. */
export const PUBLIC_EVENT_STATUS = "published" as const;

export const PUBLIC_DATA_BOUNDS = {
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;

/**
 * A3 bounds for the session-free `/api/public/*` surface. The collection is
 * capped at 20 rows (tighter than the session-gated `/events.json` 100) and
 * every JSON body must fit 32 KiB so AI pollers stay cheap to serve.
 */
export const API_PUBLIC_BOUNDS = {
  defaultPageSize: 20,
  maxPageSize: 20,
  maxBodyBytes: 32 * 1024,
} as const;

/** One published event as the public API serves it. `going_count` is null — never 0 — when the RSVP aggregate cannot be read. */
export interface PublicApiEventDto extends Omit<PublicEventDto, "going_count" | "going_occupancy"> {
  going_count: number | null;
  /** Seat occupancy for spots/full; null when the rollup is unavailable. */
  going_occupancy: number | null;
}

export interface PublicApiEventCollectionDto {
  data: PublicApiEventDto[];
  page: number;
  limit: number;
  meta: {
    current_page: number;
    per_page: number;
    total: number;
    last_page: number;
  };
}

export interface CommunityRankDto {
  key: string;
  label: string;
  member_count: number | null;
}

/** Live community snapshot. Unavailable collectors read as null, never 0: an unknown community size must not present as empty. */
export interface CommunitySnapshotDto {
  member_count: number | null;
  online_count: number | null;
  ranks: CommunityRankDto[];
}

/** Join is a Discord handoff only: the public invite plus the /join intro, no member data. */
export interface JoinHandoffDto {
  intro: string;
  invite_url: string;
}

/**
 * Single source for the event projection: the serializer emits exactly these
 * keys in this order, and the OpenAPI schema requires exactly these keys, so
 * `serializer output == spec required == this list` is asserted in tests.
 */
export const PUBLIC_API_EVENT_FIELDS = [
  "event_key",
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "starts_at_local",
  "ends_at_local",
  "timezone",
  "location",
  "capacity",
  "going_count",
  "going_occupancy",
  "status",
  "rsvp_open",
  "synced_to_discord",
] as const;

export const COMMUNITY_SNAPSHOT_FIELDS = ["member_count", "online_count", "ranks"] as const;

export const COMMUNITY_RANK_FIELDS = ["key", "label", "member_count"] as const;

/**
 * Collection envelope keys, in serializer order. The OpenAPI collection
 * schema and the MCP list_events output schema both require exactly these,
 * so the envelope cannot drift between surfaces.
 */
export const PUBLIC_API_COLLECTION_FIELDS = ["data", "page", "limit", "meta"] as const;

/** Paging cursor keys, in serializer order. Required by both the OpenAPI meta schema and the MCP output schema. */
export const PUBLIC_API_META_FIELDS = ["current_page", "per_page", "total", "last_page"] as const;

export const JOIN_HANDOFF_FIELDS = ["intro", "invite_url"] as const;

export type PublicEventId = string & { readonly __brand: "PublicEventId" };

const PUBLIC_EVENT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Public event IDs use the stored uppercase ULID, never the database row ID. */
export function parsePublicEventId(value: string): PublicEventId | null {
  return PUBLIC_EVENT_ID.test(value) ? (value as PublicEventId) : null;
}

export interface PublicEventDto {
  event_key: PublicEventId;
  title: string;
  game: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  starts_at_local: string;
  ends_at_local: string;
  timezone: string;
  location: string | null;
  capacity: number | null;
  going_count: number;
  /** Seat occupancy for spots/full; aggregate only. Optional so older fakes
   * still typecheck; the serializer always emits it. */
  going_occupancy?: number;
  status: typeof PUBLIC_EVENT_STATUS;
  rsvp_open: boolean;
  synced_to_discord: boolean;
}

export interface PublicEventCollectionDto {
  data: PublicEventDto[];
  page: number;
  limit: number;
  meta: {
    current_page: number;
    per_page: number;
    total: number;
    last_page: number;
  };
}

export const PUBLIC_DATA_ERROR_CODES = [
  "internal",
  "invalid_request",
  "not_found",
  "rate_limited",
  "unavailable",
] as const;
export type PublicDataErrorCode = (typeof PUBLIC_DATA_ERROR_CODES)[number];

/**
 * Static `internal` message for unexpected public-read faults: never
 * err.message (drizzle echoes the failed SQL, column names and bound params).
 * Shared by the REST 500 envelope and the MCP tool error so the two machine
 * surfaces cannot drift; the real error goes to error.alert only.
 */
export const PUBLIC_DATA_INTERNAL_MESSAGE = "Event data could not be read.";

/** New routes use this envelope; existing event routes retain legacy errors for compatibility. */
export interface PublicDataErrorDto {
  error: {
    code: PublicDataErrorCode;
    message: string;
  };
}

/** Exclusions are part of the public contract, not fields callers can opt into. */
export const PUBLIC_DATA_EXCLUSIONS = [
  "draft events",
  "attendee identities and RSVP records",
  "raw Discord identifiers",
  "viewer-specific RSVP or waitlist state",
  "member directories or profiles",
  "model-training permission",
  "OAuth remote tools",
] as const;
