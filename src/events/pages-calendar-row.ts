// Calendar row model: anything the month grid or list renders — a persisted
// row or a Discord transient — plus the key/zone/title/location readers every
// calendar leaf shares.
import { transientEventKey } from "../islands/contracts";
import type { DiscordTransient } from "../islands/contracts";
import type { PublicEvent } from "./reads";

/** Anything the calendar renders: a persisted row or a Discord transient. */
export type CalRow = PublicEvent | DiscordTransient;
export const isTransient = (e: CalRow): e is DiscordTransient => "discordId" in e;

/** Schedule availability verdict shared by list cards and month-grid
 * entries, so members see paused/full/remaining seats without opening a
 * night. Deterministic precedence: cancelled and drafts carry no line (the
 * cancelled badge already says so; drafts are unpublished), then past
 * (explicit status or the end instant reached — an ongoing interval is not
 * past just because its start elapsed), paused, full/overfull, and finally
 * open finite/uncapped. Closed rows never advertise bookable seats; the
 * copy is a snapshot, never a guaranteed reservation or proof of
 * attendance. Remaining seats read seat occupancy, never the attributable
 * named count, so the card never offers a seat the write path cannot
 * grant. Uncapped rows name the open capacity without inventing a finite
 * count; Discord-native rows say Discord-managed, never site seats. */
export type ScheduleAvailabilityState =
  | "past"
  | "paused"
  | "full"
  | "open"
  | "uncapped"
  | "transient";
export interface ScheduleAvailability {
  state: ScheduleAvailabilityState;
  /** Concise visible copy, shared by the card line and the grid suffix. */
  text: string;
}
/** The persisted-row slice the verdict reads. A null end never reads Ended:
 * only a known end instant at or before `now` closes seats. */
interface AvailabilityRow {
  status: string;
  endsAt: Date | null;
  rsvpOpen: boolean;
  capacity: number | null;
  goingOccupancy: number;
}

function availabilityFor(
  e: AvailabilityRow,
  now?: Date | null,
  pastContext = false,
): ScheduleAvailability | null {
  if (e.status === "draft" || e.status === "cancelled") return null;
  const ended =
    pastContext ||
    e.status === "past" ||
    (now != null && e.endsAt !== null && e.endsAt.getTime() <= now.getTime());
  if (ended) return { state: "past", text: "Ended" };
  if (!e.rsvpOpen) return { state: "paused", text: "RSVPs paused" };
  if (e.capacity === null) return { state: "uncapped", text: "No seat limit" };
  const remaining = Math.max(0, e.capacity - e.goingOccupancy);
  if (remaining <= 0) return { state: "full", text: "Full" };
  return {
    state: "open",
    text: remaining === 1 ? "1 seat left" : `${remaining} seats left`,
  };
}

export function rowAvailability(
  e: CalRow,
  now?: Date | null,
  pastContext = false,
): ScheduleAvailability | null {
  if (isTransient(e)) return { state: "transient", text: "Discord-managed" };
  return availabilityFor(e, now, pastContext);
}

/** Homepage teaser slice (`HomeEvent` in `./reads`): the same public fields
 * the widened teaser read projects. Older hand-built fixtures may omit the
 * newer fields, so each one carries the fallback the renderers already
 * promise: a missing end never reads Ended, a missing `rsvpOpen` reads
 * open, and a missing occupancy falls back to the named count (the
 * `GoingCountState.occupancy` precedent). */
export interface TeaserAvailabilityRow {
  status?: string | undefined;
  endsAt?: Date | undefined;
  rsvpOpen?: boolean | undefined;
  capacity: number | null;
  goingCount: number;
  goingOccupancy?: number | undefined;
}

/** Teaser availability with the schedule verdict's precedence and copy, so
 * a homepage row and its schedule card never disagree about bookable seats.
 * `now` is the render instant: a row that ended between read and render
 * reads Ended instead of advertising seats. */
export function teaserAvailability(
  e: TeaserAvailabilityRow,
  now: Date,
): ScheduleAvailability | null {
  return availabilityFor(
    {
      status: e.status ?? "published",
      endsAt: e.endsAt ?? null,
      rsvpOpen: e.rsvpOpen ?? true,
      capacity: e.capacity,
      goingOccupancy: e.goingOccupancy ?? e.goingCount,
    },
    now,
  );
}
export const rowKey = (e: CalRow): string =>
  isTransient(e) ? transientEventKey(e.discordId) : e.eventKey;
export const rowZone = (e: CalRow, fallback: string): string =>
  isTransient(e) ? fallback : e.timezone;
export const rowTitle = (e: CalRow): string => e.title;
export const rowLocation = (e: CalRow): string | null => e.location;
