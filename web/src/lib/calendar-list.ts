import type { CalendarState } from "../../../src/islands/contracts";
import type { SearchSegment } from "../../../src/events/search-context";

/**
 * Public presentation data for one calendar list card. Callers project rows
 * (persisted or Discord transient) into this shape, so a new rendered field
 * fails typecheck here instead of widening the page payload. Search spans,
 * availability and the draft/cancelled verdict stay server-side authorities.
 */
interface CalendarCardBase {
  /** Anchor key: the event key, or `discord-<id>` for a transient. */
  key: string;
  title: string;
  /** Pre-segmented title during an upcoming search; null otherwise. */
  titleSegments: SearchSegment[] | null;
  /** Effective event zone (a transient carries the calendar zone). */
  zone: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  description: string | null;
  /** Bounded description passage during an upcoming search; null otherwise. */
  passage: SearchSegment[] | null;
  /**
   * Availability snapshot with the drawer context already applied
   * (`rowAvailability(e, now, isPast)`); null for drafts and cancelled rows.
   */
  availability: CalendarCardAvailability | null;
}

export interface CalendarCardAvailability {
  state: "past" | "paused" | "full" | "open" | "uncapped" | "transient";
  text: string;
  /** Under way at the render instant; a badge, never a replacement verdict. */
  ongoing: boolean;
}

export interface CalendarPersistedCard extends CalendarCardBase {
  kind: "event";
  eventKey: string;
  status: "draft" | "published" | "cancelled" | "past";
  game: string | null;
  /** Public organizer, trimmed; blank renders no host line. */
  host: string;
  goingCount: number;
  /** Seat occupancy, which drives the Full marker. */
  goingOccupancy: number;
  capacity: number | null;
}

export interface CalendarTransientCard extends CalendarCardBase {
  kind: "discord";
}

export type CalendarListCard = CalendarPersistedCard | CalendarTransientCard;

/** Viewer facts that decide the action area; shared by cards and the drawer. */
export interface CalendarViewer {
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}

export interface CalendarPastDrawerProps extends CalendarViewer {
  state: CalendarState;
  /** Bounded past cards; persisted rows only, prepared with `isPast` context. */
  past: CalendarPersistedCard[];
  showPast: boolean;
}

export interface CalendarListProps extends CalendarPastDrawerProps {
  upcoming: CalendarListCard[];
  totalPages: number;
  outOfRange: boolean;
}
