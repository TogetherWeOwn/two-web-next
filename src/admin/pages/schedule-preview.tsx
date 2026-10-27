// Not-saved schedule preview for the new-event form. Renders the dates the
// existing weekly enumerator (`occurrences`) names for the submitted values; it
// never expands a series itself, writes nothing and holds no submit control.
// Each row shows the host-zone wall time and the UTC instant of the same moment.

import type { FC } from "hono/jsx";
import type { Occurrence } from "../recurrence";
import { utcToWall } from "../validation";

/** What the route hands the form: the enumerated dates and the zone they read in. */
export type SchedulePreview = { occurrences: Occurrence[]; timezone: string };

/** An end as wall text: the time alone when it falls on the start's date. */
const endText = (start: string, end: string): string =>
  end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end;

export const SchedulePreviewPanel: FC<{ preview: SchedulePreview }> = ({ preview }) => {
  const { occurrences: list, timezone } = preview;
  const first = list[0]!.startsAt;
  const last = list[list.length - 1]!.startsAt;
  const noun = list.length === 1 ? "occurrence" : "occurrences";
  return (
    <section
      id="schedule-preview"
      class="notice schedule-preview"
      data-testid="schedule-preview"
      aria-labelledby="schedule-preview-heading"
    >
      <h2 id="schedule-preview-heading">Schedule preview</h2>
      <p>
        <strong>Not saved.</strong> Nothing is stored until you use the create button below.
      </p>
      <p data-testid="preview-count">
        {list.length} {noun}
      </p>
      <p>
        <span data-testid="preview-first">
          First <time datetime={first.toISOString()}>{utcToWall(first, timezone)}</time>
        </span>
        {" · "}
        <span data-testid="preview-last">
          Last <time datetime={last.toISOString()}>{utcToWall(last, timezone)}</time>
        </span>
      </p>
      <details data-testid="preview-list">
        <summary>
          All {list.length} {noun}
        </summary>
        <p class="hint">{timezone} wall times, with the UTC instant beside each.</p>
        <ol>
          {list.map(({ startsAt, endsAt }) => {
            const [wall, end] = [utcToWall(startsAt, timezone), utcToWall(endsAt, timezone)];
            const [utc, utcEnd] = [utcToWall(startsAt, "UTC"), utcToWall(endsAt, "UTC")];
            return (
              <li>
                <time datetime={startsAt.toISOString()}>{wall}</time>
                {" to "}
                <time datetime={endsAt.toISOString()}>{endText(wall, end)}</time>{" "}
                <span class="hint">
                  (UTC {utc} to {endText(utc, utcEnd)})
                </span>
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
};
