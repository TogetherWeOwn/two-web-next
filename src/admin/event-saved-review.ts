// Read-only advice from the persisted row, never from retained form values.
// Publication still judges status, end time and location under its row lock.
export type SavedEventReviewRow = {
  eventKey: string;
  status: string;
  location: string | null;
  endsAt: Date;
  // The real store always supplies this; narrower read-model fixtures may not.
  // Missing provenance must not be replaced with the rendering clock.
  updatedAt?: Date;
};

export function savedEventReview(row: SavedEventReviewRow, now: Date) {
  const corrections: { message: string; href: string; label: string }[] = [];
  if (!row.location?.trim()) {
    corrections.push({
      message: "The saved location is blank. Add a location before publishing.",
      href: "#f-location",
      label: "Edit location",
    });
  }
  // Equality is allowed by the publication guard, unlike the live-RSVP boundary.
  if (row.endsAt.getTime() < now.getTime()) {
    corrections.push({
      message: "The saved event has already ended. Update its dates before publishing.",
      href: "#f-ends-at",
      label: "Edit end time",
    });
  }
  return {
    href: `/events/${encodeURIComponent(row.eventKey)}`,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    guidance:
      row.status === "cancelled"
        ? "This saved event is cancelled. Cancellation is terminal; it cannot be republished."
        : row.status === "published"
          ? "This saved event is already published. Saving edits updates the published record."
          : corrections.length === 0
            ? "The saved draft is ready for the current publication checks."
            : "The saved draft needs corrections before publishing.",
    corrections,
  };
}

export type SavedEventReview = ReturnType<typeof savedEventReview>;
