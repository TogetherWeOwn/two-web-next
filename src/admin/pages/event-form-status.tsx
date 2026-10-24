// Admin event-form status section (split from event-form.tsx; zero behavior change).
// Edit-only status heading with the publish, cancel and RSVP pause/reopen actions.

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import { RsvpAction } from "./shell";
import { TerminalReview } from "./terminal-review";

export const EventStatusSection: FC<{ row: EventRow }> = ({ row }) => {
  return (
    <section aria-label="Status">
      <h2>Status: {row.status}</h2>
      <div class="actions terminal-actions">
        {row.status === "draft" ? (
          <form method="post" action={`/admin/events/${row.eventKey}/publish`}>
            <button type="submit" class="btn" data-testid="publish-event">
              Publish
            </button>
          </form>
        ) : null}
        {row.status === "draft" || row.status === "published" ? (
          <TerminalReview
            kind="cancel"
            title={row.title}
            targetId={row.eventKey}
            action={`/admin/events/${row.eventKey}/cancel`}
            testId="cancel-event"
          />
        ) : null}
        <RsvpAction row={row} />
      </div>
    </section>
  );
};
