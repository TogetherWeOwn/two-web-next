import { loginUrl, RSVP_COPY, type RsvpClosedReason } from "../islands/contracts";
import { rsvpActionHref } from "./attendee-paths";
import { wallTimeHm } from "./date-format";
import type { ViewerRsvp } from "./reads";

export const KIT_SIGNUPS_OPEN = "Sign-ups open";

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
      detail: KIT_SIGNUPS_OPEN,
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
  if (!model.viewerMember && hasSeat(model)) {
    return {
      state: "guest",
      title: "Log in to RSVP",
      detail: model.rsvpOpen ? KIT_SIGNUPS_OPEN : "Paused",
      href: loginUrl(model.joinReturnTo),
      label: RSVP_COPY.guestCta,
    } as const;
  }
  return null;
}
