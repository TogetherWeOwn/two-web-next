// Admin activity-log screen: read-only viewer (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import type { ActivityLogViewerRow } from "../reads";
import { resolveActivitySubjectHref } from "../moderator-links";
import {
  formatActivityCauser,
  activityLogEmptyText,
  activityLogUrl,
  type ActivityLogQuery,
} from "../table-list";
import { Shell } from "./shell";

// Imported rows keep legacy internal causer IDs (docs/data-import.md), which the
// access-log guard cannot take as subjects (snowflakes only). The shared
// formatActivityCauser labels them so a legacy ID never reads as a Discord
// identity — one copy for the Hono page and the Kit viewer.

export const ActivityLogPage: FC<{
  rows: ActivityLogViewerRow[];
  query: ActivityLogQuery;
  hasNext: boolean;
}> = ({ rows, query, hasNext }) => (
  <Shell title="Activity log">
    <section>
      <h1>Activity log</h1>
      <p class="hint">
        Read-only. Who changed what, when. Views that name a member are access-logged; imported
        causer IDs are labeled legacy.
      </p>
      <form method="get" action="/admin/activity-log" class="filters">
        <div class="field">
          <label for="subject">Subject</label>
          <input id="subject" name="subject" type="search" value={query.subject} />
        </div>
        <div class="field">
          <label for="causer">Causer</label>
          <input id="causer" name="causer" type="search" value={query.causer} />
        </div>
        <div class="field">
          <button type="submit" class="btn">
            Filter
          </button>
        </div>
      </form>
      <p id="activity-log-scroll-hint">
        Scroll horizontally to see all columns on smaller screens.
      </p>
      <div
        class="admin-table-scroll"
        role="region"
        aria-label="Activity log list"
        aria-describedby="activity-log-scroll-hint"
        tabindex={0}
        data-testid="activity-log-table-scroll"
      >
        <table class="admin-table" data-testid="activity-log-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">When</th>
              <th scope="col">Subject</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={4} data-testid="activity-log-empty">
                  {activityLogEmptyText(query)}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                // Validated Next-written subjects link straight to their
                // canonical saved editor; anything else keeps the inert
                // escaped text it always rendered. The event suffix stays
                // plain text beside the link, never inside it.
                const href = resolveActivitySubjectHref(r.subjectType, r.subjectId);
                const label = [r.subjectType, r.subjectId].filter(Boolean).join(" ") || "—";
                return (
                  <tr key={r.id}>
                    <td>{formatActivityCauser(r.causerId)}</td>
                    <td>{r.description}</td>
                    <td>
                      <time datetime={r.createdAt.toISOString()}>{r.createdAt.toISOString()}</time>
                    </td>
                    <td>
                      {href ? <a href={href}>{label}</a> : label}
                      {r.event ? ` (${r.event})` : ""}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <nav aria-label="Activity pages" class="actions">
        {query.page > 1 ? (
          <a rel="prev" href={activityLogUrl(query, query.page - 1)}>
            Previous
          </a>
        ) : null}
        <span>Page {query.page}</span>
        {hasNext ? (
          <a rel="next" href={activityLogUrl(query, query.page + 1)}>
            Next
          </a>
        ) : null}
      </nav>
    </section>
  </Shell>
);
