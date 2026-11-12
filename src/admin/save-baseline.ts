// Full-form saves compare the displayed snapshot under the committing row lock.
// Include the write version as well as content: a change followed by a revert
// must not make an old moderator draft current again. This is a precondition,
// not an authorization token; the existing moderator guard still owns access.
import { sha256Hex } from "../bot/signer";
import type { EventRow } from "./store-event-writes";
import type { FeaturedEditRow } from "./store-featured";

export const SAVE_BASELINE_FIELD = "saved_baseline";

export class StaleSaveError<Row = unknown> extends Error {
  constructor(readonly current?: Row) {
    super("The saved version changed.");
    this.name = "StaleSaveError";
  }
}

export function isSaveBaseline(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// Legacy nonfinite dates stay repairable rather than throwing during a GET.
function instant(value: Date | null | undefined): string | null {
  if (value == null) return null;
  return Number.isFinite(value.getTime()) ? value.toISOString() : "nonfinite";
}

export type EventSaveSnapshot = Pick<
  EventRow,
  | "eventKey"
  | "title"
  | "game"
  | "description"
  | "startsAt"
  | "endsAt"
  | "timezone"
  | "location"
  | "capacity"
  | "status"
  | "rsvpOpen"
> &
  Partial<
    Pick<
      EventRow,
      | "accessibilityNotes"
      | "organizer_name"
      | "join_url"
      | "join_instructions"
      | "updatedAt"
      | "agentVersion"
    >
  >;

export async function eventSaveBaseline(row: EventSaveSnapshot): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      "event",
      row.eventKey,
      instant(row.updatedAt),
      row.agentVersion ?? null,
      row.title,
      row.game,
      row.description,
      row.accessibilityNotes ?? null,
      instant(row.startsAt),
      instant(row.endsAt),
      row.timezone,
      row.location,
      row.capacity,
      row.organizer_name ?? null,
      row.join_url ?? null,
      row.join_instructions ?? null,
      row.status,
      row.rsvpOpen,
    ]),
  );
}

export async function featuredSaveBaseline(row: FeaturedEditRow): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      "featured",
      row.id,
      instant(row.updatedAt),
      row.title,
      row.body,
      row.url,
      row.imageUrl,
      row.imageAlt,
      row.isPublished,
      row.position,
      row.startsAtText,
      row.endsAtText,
    ]),
  );
}

// Called only while holding the row lock, including featured unpublish. A
// frozen/backwards clock cannot reissue the version of a prior saved form.
export function nextSaveVersion(previous: Date, now = new Date()): Date {
  const time = previous.getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(time) ? time + 1 : 0));
}
