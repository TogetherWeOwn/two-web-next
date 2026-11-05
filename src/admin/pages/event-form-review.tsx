/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import type { SavedEventReview } from "../event-saved-review";

type ReviewPart = "banner" | "actions" | "rsvp";

// Kit consumes escaped server-rendered leaves; member content stays in its detail renderer.
export function renderSavedEventReviewHtml(
  review: SavedEventReview,
  part: ReviewPart = "banner",
): string {
  return String(<EventReviewSection review={review} part={part} />);
}

export const EventReviewSection: FC<{ review: SavedEventReview; part?: ReviewPart }> = ({
  review,
  part = "banner",
}) => {
  if (part === "rsvp") {
    return (
      <>
        <button type="button" class="btn" disabled aria-describedby="preview-rsvp-hint">
          RSVP
        </button>
        <p id="preview-rsvp-hint">RSVP is disabled in preview.</p>
      </>
    );
  }
  if (part === "actions") {
    return (
      <div class="actions" data-testid="event-review-actions">
        <a class="btn" href={review.editHref}>Back to edit</a>
      </div>
    );
  }
  const needsCorrections = review.corrections.length > 0;
  return (
    <section
      class="notice"
      aria-label="Preview — moderator only"
      role={needsCorrections ? "alert" : "status"}
      data-testid="event-review"
    >
      <p>
        <strong>
          {needsCorrections ? "Fix these before publishing" : "Preview — as members will see it"}
        </strong>
      </p>
      <p>{review.guidance}</p>
      <p>
        {review.updatedAt ? (
          <>
            Saved record last updated: <time datetime={review.updatedAt}>{review.updatedAt}</time>{" "}
            (UTC).
          </>
        ) : (
          "Saved record update time is unavailable."
        )}
      </p>
      {needsCorrections ? (
        <ul>
          {review.corrections.map((issue) => (
            <li>
              {issue.message} <a href={issue.href}>{issue.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
