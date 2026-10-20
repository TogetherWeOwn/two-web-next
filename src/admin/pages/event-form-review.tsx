import type { FC } from "hono/jsx";
import type { SavedEventReview } from "../event-saved-review";

export const EventReviewSection: FC<{ review: SavedEventReview }> = ({ review }) => (
  <section aria-label="Saved event review">
    <h2>Review the saved event</h2>
    <p>
      <a href={review.href}>Review saved event</a> on its detail page. Drafts remain visible only to
      moderators.
    </p>
    <p>
      {review.updatedAt ? (
        <>
          Saved record last updated: <time datetime={review.updatedAt}>{review.updatedAt}</time>{" "}
          (UTC). This is an update time, not an immutable revision or a preview check time.
        </>
      ) : (
        "Saved record update time is unavailable."
      )}
    </p>
    <p>
      Review and the separate Publish action use only the saved record. Unsaved edits are not
      included in either. Save successfully, then review again before publishing.
    </p>
    <p>{review.guidance}</p>
    {review.corrections.length > 0 ? (
      <ul>
        {review.corrections.map((issue) => (
          <li>
            {issue.message} <a href={issue.href}>{issue.label}</a> and Save.
          </li>
        ))}
      </ul>
    ) : null}
    <p class="hint">
      Advice reflects the saved record when this page rendered, not permission to publish. The
      server rechecks the current saved record when Publish runs.
    </p>
  </section>
);
