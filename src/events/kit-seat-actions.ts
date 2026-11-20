import type { RsvpClosedReason } from "../islands/contracts";

export const KIT_SIGNUPS_OPEN = "Sign-ups open";
import type { ViewerRsvp } from "./reads";

interface SeatSnapshot {
  status: string;
  rsvpClosed: RsvpClosedReason | null;
  rsvpOpen: boolean;
  isOngoing?: boolean;
  review?: unknown;
  viewerMember: boolean;
  answer: ViewerRsvp | null;
  capacity: number | null;
  goingOccupancy: number;
  goingCount: number;
}

function upcoming(model: SeatSnapshot): boolean {
  return model.status === "published" && !model.rsvpClosed && !model.isOngoing && !model.review;
}

function hasSeat(model: SeatSnapshot): boolean {
  return model.capacity === null || model.goingOccupancy < model.capacity;
}

export function kitOpenSeat(model: SeatSnapshot): string | null {
  if (!upcoming(model) || !model.viewerMember || !model.rsvpOpen || model.answer || !hasSeat(model))
    return null;
  // Occupancy includes unnamed going rows and is the same count used to admit a seat.
  return model.capacity === null
    ? `${model.goingCount} going`
    : `${model.goingOccupancy} of ${model.capacity} in`;
}
