// Admin event-form status section (split from event-form.tsx; zero behavior change).
// Edit-only status heading with the publish, cancel and RSVP pause/reopen actions.

import type { FC } from "hono/jsx";
import type { EventRow } from "../store";
import { RsvpAction } from "./shell";

export const EventStatusSection: FC<{ row: EventRow; now?: Date }> = ({ row, now }) => {
  return (
    <section aria-label="Status">
      <h2>Status: {row.status}</h2>
      <div class="actions">
        {row.status === "draft" ? (
          <form method="post" action={`/admin/events/${row.eventKey}/publish`}>
            <button type="submit" class="btn" data-testid="publish-event">
              Publish
            </button>
          </form>
        ) : null}
        {row.status === "draft" || row.status === "published" ? (
          <form method="post" action={`/admin/events/${row.eventKey}/cancel`}>
            <button type="submit" class="link" data-testid="cancel-event">
              Cancel event
            </button>
          </form>
        ) : null}
        <RsvpAction row={row} now={now} />
      </div>
    </section>
  );
};
