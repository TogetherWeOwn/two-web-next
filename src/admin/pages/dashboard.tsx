// Admin dashboard screen (split from pages.tsx; zero behavior change).

import type { ZeroResultSearch } from "../../events/search-log";
import type { FC } from "hono/jsx";
import type { Actor } from "../guard";
import { JOIN_RETENTION_DAYS } from "../reads";
import { Shell } from "./shell";

export const AdminDashboard: FC<{
  actor: Actor;
  funnel?: Record<string, number>;
  zeroSearches?: ZeroResultSearch[];
}> = ({ actor, funnel, zeroSearches }) => (
  <Shell title="Dashboard">
    <section>
      <h1>Moderation</h1>
      <p class="lead">
        Signed in as <strong data-testid="admin-actor">{actor.username}</strong>.
      </p>
      <ul class="facts">
        <li class="card">
          <h2>
            <a href="/admin/events">Events</a>
          </h2>
          <p>Drafts, publishing, cancellations. Create-as-draft; events are never deleted.</p>
        </li>
        <li class="card">
          <h2>
            <a href="/admin/featured">Featured content</a>
          </h2>
          <p>Landing-page slots: publish toggle, ordering, show window.</p>
        </li>
        <li class="card">
          <h2>
            <a href="/admin/activity-log">Activity log</a>
          </h2>
          <p>Who changed what, when. Read-only; views that name a member are access-logged.</p>
        </li>
      </ul>
      {funnel ? (
        <section data-testid="join-funnel">
          <h2>Join funnel, last {JOIN_RETENTION_DAYS} days</h2>
          {Object.keys(funnel).length === 0 ? (
            <p data-testid="join-funnel-empty">No join attempts in the window.</p>
          ) : (
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(funnel).map(([outcome, n]) => (
                  <tr key={outcome}>
                    <td>{outcome}</td>
                    <td data-testid={`funnel-${outcome}`}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
      {zeroSearches ? (
        <section data-testid="top-zero-searches">
          <h2>Top searches with no results</h2>
          <p>
            What guests looked for on /events and found nothing. A repeat miss is a game night
            nobody posted yet.
          </p>
          {zeroSearches.length === 0 ? (
            <p data-testid="top-zero-searches-empty">No missed searches.</p>
          ) : (
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Search</th>
                  <th>Misses</th>
                  <th>Last searched</th>
                </tr>
              </thead>
              <tbody>
                {zeroSearches.map((r) => (
                  <tr key={r.query}>
                    <td>{r.query}</td>
                    <td>{r.searches}</td>
                    <td>{r.lastSearchedAt.toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </section>
  </Shell>
);
