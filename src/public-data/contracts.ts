/** Shared, intentionally allowlisted contract for public data reads. */
export const PUBLIC_EVENT_STATUS = "published" as const;

export const PUBLIC_DATA_BOUNDS = {
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;

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
  "invalid_request",
  "not_found",
  "rate_limited",
  "unavailable",
] as const;
export type PublicDataErrorCode = (typeof PUBLIC_DATA_ERROR_CODES)[number];

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
