import { loginUrl, RSVP_COPY, type RsvpClosedReason } from "../islands/contracts";
import { rsvpActionHref } from "./attendee-paths";
import { wallTimeHm } from "./date-format";
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

export function kitOpenSeat(model: SeatSnapshot): string | null {
  if (!upcoming(model) || !model.viewerMember || !model.rsvpOpen || model.answer) return null;
  const { capacity, goingOccupancy, goingCount } = model;
  if (capacity === null) return `${goingCount} going`;
  // Occupancy includes unnamed going rows and is the same count used to admit a seat.
  return goingOccupancy < capacity ? `${goingOccupancy} of ${capacity} in` : null;
}

export function kitSeatActionBar(
  model: SeatSnapshot & {
    eventKey: string;
    joinReturnTo: string;
    timeDatetime: string;
    zoneLabel: string;
    attendeesPaging: { page: number };
  },
) {
  if (!upcoming(model)) return null;
  const open = kitOpenSeat(model);
  if (open) {
    return {
      state: "open",
      title: open,
      detail: "Sign-ups open",
      action: rsvpActionHref(model.eventKey, model.attendeesPaging.page),
    } as const;
  }
  if (model.viewerMember && model.answer?.status === "going") {
    return {
      state: "saved",
      title: "You're in",
      detail: model.timeDatetime
        ? `Starts at ${wallTimeHm(new Date(model.timeDatetime), model.zoneLabel)}`
        : "Time unavailable",
    } as const;
  }
  if (!model.viewerMember) {
    return {
      state: "guest",
      title: "Log in to RSVP",
      detail: model.rsvpOpen ? "Sign-ups open" : "Paused",
      href: loginUrl(model.joinReturnTo),
      label: RSVP_COPY.guestCta,
    } as const;
  }
  return null;
}
