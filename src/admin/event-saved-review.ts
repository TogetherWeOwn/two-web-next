// Review uses only the persisted detail projection, never retained editor input.
import { instantIso } from "../events/date-format";

export type SavedEventReviewRow = {
  eventKey: string;
  status: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  updatedAt?: Date;
};

export function savedEventReview(row: SavedEventReviewRow, now: Date) {
  const editHref = `/admin/events/${encodeURIComponent(row.eventKey)}`;
  const corrections: { message: string; href: string; label: string }[] = [];
  if (row.status === "draft") {
    if (!row.location?.trim()) {
      corrections.push({
        message: "Location is blank. Add a location and save.",
        href: `${editHref}#f-location`,
        label: "Edit location",
      });
    }
    for (const [field, date] of [["start", row.startsAt], ["end", row.endsAt]] as const) {
      if (!instantIso(date)) {
        corrections.push({
          message: `The saved ${field} time can't be read. Fix the ${field} time and save.`,
          href: `${editHref}#f-${field === "start" ? "starts" : "ends"}-at`,
          label: `Edit ${field} time`,
        });
      }
    }
    if (row.endsAt.getTime() < now.getTime()) {
      corrections.push({
        message: "This event has already ended. Fix the end time and save.",
        href: `${editHref}#f-ends-at`,
        label: "Edit end time",
      });
    }
  }
  return {
    href: `/e/${encodeURIComponent(row.eventKey)}?review=1`,
    editHref,
    updatedAt: row.updatedAt ? instantIso(row.updatedAt) || null : null,
    guidance:
      row.status === "draft"
        ? "This is a draft. Only moderators can see this page."
        : row.status === "published"
          ? "This event is already published. This is what members see now."
          : row.status === "cancelled"
            ? "This event is cancelled. Members don't see it in listings."
            : row.status === "past"
              ? "This event has ended and cannot be published as-is."
              : "This event is not a draft and cannot be published as-is.",
    corrections,
  };
}

export type SavedEventReview = ReturnType<typeof savedEventReview>;
