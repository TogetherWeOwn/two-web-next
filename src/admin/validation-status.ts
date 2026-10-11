// Event status transition guard (W11). Pure move out of `./validation`,
// ports EventService::transitionTo and EventStatus::isMirrored.
// `./validation` re-exports every name below, so all existing importers keep
// working untouched.

import { ValidationError } from "./validation-shared";

export type EventStatus = "draft" | "published" | "cancelled" | "past";

/** Transition guard (ports EventService::transitionTo): cancelled is terminal. */
export function nextStatus(from: EventStatus, to: "published" | "cancelled"): EventStatus {
  if (from === "cancelled") {
    throw new ValidationError({
      status: "A cancelled event stays cancelled — Discord was already told.",
    });
  }
  if (to === "published" && from !== "draft") {
    throw new ValidationError({ status: "Only a draft can be published." });
  }
  if (to === "cancelled" && from !== "draft" && from !== "published") {
    throw new ValidationError({ status: "Only a draft or a published event can be cancelled." });
  }
  return to;
}

/** Whether a row in this status is mirrored to Discord (ports EventStatus::isMirroredInDiscord). */
export function isMirrored(status: EventStatus): boolean {
  return status === "published" || status === "cancelled";
}
