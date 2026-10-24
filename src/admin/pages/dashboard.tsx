// Admin dashboard screen (split from pages.tsx; zero behavior change).

import type { ZeroResultSearch } from "../../events/search-log";
import type { FC } from "hono/jsx";
import type { Actor } from "../guard";
import { JOIN_RETENTION_DAYS } from "../reads";
import { joinAttemptsUrl, parseJoinAttemptsQuery } from "../table-list";
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
        <li class="card">
          <h2>
            <a href="/admin/join-attempts">Join attempts</a>
          </h2>
          <p>Every join try, outcome and refusal. Read-only.</p>
        </li>
      </ul>
      <section data-testid="join-funnel" aria-labelledby="join-funnel-heading">
        <h2 id="join-funnel-heading">Join funnel, last {JOIN_RETENTION_DAYS} days</h2>
        <p>
          Counts cover recorded join attempts retained for {JOIN_RETENTION_DAYS} days. Cached for 60
          seconds, they may lag a new attempt; this is not a live recount.
        </p>
        {funnel === undefined ? (
          <p data-testid="join-funnel-unavailable">Join counts are unavailable for this load.</p>
        ) : Object.keys(funnel).length === 0 ? (
          <p data-testid="join-funnel-empty">No join attempts in the window.</p>
        ) : (
          <>
            <p id="join-funnel-scroll-hint">
              Scroll horizontally to see all columns on smaller screens.
            </p>
            <div
              class="admin-table-scroll"
              role="region"
              aria-label="Join funnel"
              aria-describedby="join-funnel-scroll-hint"
              tabindex={0}
              data-testid="join-funnel-table-scroll"
            >
              <table class="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Outcome</th>
                    <th scope="col">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(funnel).map(([outcome, n]) => (
                    <tr key={outcome}>
                      <td>
                        <a
                          href={joinAttemptsUrl(parseJoinAttemptsQuery({ outcome }), 1)}
                          aria-label={`View join attempts with outcome ${outcome}`}
                        >
                          {outcome}
                        </a>
                      </td>
                      <td data-testid={`funnel-${outcome}`}>{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section data-testid="top-zero-searches" aria-labelledby="zero-searches-heading">
        <h2 id="zero-searches-heading">Top searches with no results</h2>
        <p>
          Recorded misses are content-planning hints, not proof of demand. This is not all searches:
          only complete event reads can record a miss. There is no searcher identity.
        </p>
        {zeroSearches === undefined ? (
          <p data-testid="top-zero-searches-unavailable">
            Missed searches are unavailable for this load.
          </p>
        ) : zeroSearches.length === 0 ? (
          <p data-testid="top-zero-searches-empty">No recorded missed searches.</p>
        ) : (
          <>
            <p id="top-zero-searches-scroll-hint">
              Scroll horizontally to see all columns on smaller screens.
            </p>
            <div
              class="admin-table-scroll"
              role="region"
              aria-label="Top searches with no results"
              aria-describedby="top-zero-searches-scroll-hint"
              tabindex={0}
              data-testid="top-zero-searches-table-scroll"
            >
              <table class="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Search</th>
                    <th scope="col">Misses</th>
                    <th scope="col">Last searched</th>
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
            </div>
          </>
        )}
      </section>
    </section>
  </Shell>
);
