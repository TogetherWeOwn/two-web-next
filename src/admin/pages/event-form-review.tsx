/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import type { SavedEventReview } from "../event-saved-review";

export const SavedEventNotice: FC<{ eventKey: string }> = ({ eventKey }) => (
  <p class="notice" role="status" data-testid="event-saved-review">
    Saved.{" "}
    <a class="link" href={`/e/${encodeURIComponent(eventKey)}?review=1`}>
      Review the saved event before publishing
    </a>
  </p>
);

export function renderSavedEventNoticeHtml(eventKey: string): string {
  return String(<SavedEventNotice eventKey={eventKey} />);
}

export const EventPublishedNotice: FC = () => (
  <p class="notice" role="status" data-testid="event-published">
    Published. Members can now see this event.
  </p>
);

export function renderEventPublishedNoticeHtml(): string {
  return String(<EventPublishedNotice />);
}

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
      <section aria-label="Preview RSVP">
        <button type="button" class="btn" disabled aria-describedby="preview-rsvp-hint">
          RSVP
        </button>
        <p id="preview-rsvp-hint">RSVP is disabled in preview.</p>
      </section>
    );
  }
  if (part === "actions") {
    return (
      <div class="review-actions" data-testid="event-review-actions">
        <div class="actions">
          {review.isDraft ? (
            <form method="post" action={review.publishHref}>
              <input type="hidden" name="review" value="1" />
              <input type="hidden" name="reviewed_updated_at" value={review.updatedAt ?? ""} />
              <button
                class="btn"
                type="submit"
                aria-label={`Publish ${review.title}`}
                disabled={review.corrections.length > 0 || !review.updatedAt}
                data-testid="publish-reviewed-event"
              >
                Publish
              </button>
            </form>
          ) : null}
          <a class="btn" href={review.editHref}>
            Back to edit
          </a>
        </div>
        {review.isDraft ? (
          <p class="hint">
            {review.corrections.length > 0 || !review.updatedAt
              ? "Fix the problems above, save, then review again."
              : "Publishing uses the saved record you are reviewing. The server checks the current saved record again when you publish."}
          </p>
        ) : null}
      </div>
    );
  }
  const needsCorrections = review.corrections.length > 0;
  return (
    <section
      class="notice"
      aria-label="Preview — moderator only"
      role={needsCorrections || review.error ? "alert" : "status"}
      data-testid="event-review"
    >
      {review.error ? (
        <p tabindex={-1} autofocus data-testid="event-review-error">
          <strong>{review.error}</strong>
        </p>
      ) : null}
      <p>
        <strong>
          {needsCorrections ? "Fix these before publishing" : "Preview — as members will see it"}
        </strong>
      </p>
      <p>
        {review.guidance}
        {review.isDraft && !needsCorrections
          ? " Check it over, then publish from the bottom of this page when you're ready."
          : null}
      </p>
      {review.unsaved ? (
        <p data-testid="event-review-unsaved">
          You have unsaved edits in the editor. This preview and Publish use only the last saved
          record. Save first, then review again.
        </p>
      ) : null}
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
