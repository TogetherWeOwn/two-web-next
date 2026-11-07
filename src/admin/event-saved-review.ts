// Review uses only the persisted detail projection, never retained editor input.
import { instantIso } from "../events/date-format";

export type SavedEventReviewRow = {
  eventKey: string;
  title?: string;
  status: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  updatedAt?: Date;
};

const reviewErrors: Record<string, string> = {
  stale:
    "This draft changed after you opened review. You're now looking at the latest saved record — check it over before publishing.",
  location: "Location is blank. Add a location and save.",
  ended: "This event has already ended. Fix the end time and save.",
  dates: "The saved event times can't be read. Fix the times and save.",
  status: "This event is no longer a draft. Nothing was published from this review.",
};

export function savedEventReview(row: SavedEventReviewRow, now: Date, search = "") {
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
    for (const [field, date] of [
      ["start", row.startsAt],
      ["end", row.endsAt],
    ] as const) {
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
  const query = new URLSearchParams(search);
  const errorCode = query.get("publish_error") ?? "";
  return {
    href: `/e/${encodeURIComponent(row.eventKey)}?review=1`,
    editHref,
    publishHref: `${editHref}/publish`,
    title: row.title ?? "event",
    isDraft: row.status === "draft",
    error: Object.hasOwn(reviewErrors, errorCode) ? reviewErrors[errorCode] : null,
    unsaved: query.get("unsaved") === "1",
    updatedAt: row.updatedAt ? instantIso(row.updatedAt) || null : null,
    guidance:
      row.status === "draft"
        ? "This is a draft. Only moderators can see this page."
        : row.status === "published"
          ? "This event is already published. This is what members see now."
          : row.status === "cancelled"
            ? "This event is cancelled."
            : row.status === "past"
              ? "This event has ended and cannot be published as-is."
              : "This event is not a draft and cannot be published as-is.",
    corrections,
  };
}

export type SavedEventReview = ReturnType<typeof savedEventReview>;
