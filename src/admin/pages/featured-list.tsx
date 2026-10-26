// Admin featured-list screen (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import { featuredBoundDisplay, featuredInventoryStatus } from "../../featured-eligibility";
import type { FeaturedListRow } from "../store";
import {
  FEATURED_STATES,
  featuredEmptyText,
  featuredListUrl,
  featuredListHasFilters,
  featuredListClearUrl,
  type FeaturedListQuery,
} from "../featured-list-query";
import { Shell, TableSortHeader } from "./shell";

export const FeaturedPage: FC<{
  rows: FeaturedListRow[];
  query: FeaturedListQuery;
  hasNext?: boolean;
  now?: Date;
}> = ({ rows, query, hasNext = false, now = new Date() }) => (
  <Shell title="Featured content">
    <section>
      <h1>Featured content</h1>
      <p>
        <a class="btn" href="/admin/featured/new" data-testid="new-featured">
          New featured slot
        </a>
      </p>
      <form method="get" action="/admin/featured" class="filters">
        <input type="hidden" name="sort" value={query.sort} />
        <input type="hidden" name="order" value={query.order} />
        <div class="field">
          <label for="q">Search titles</label>
          <input id="q" name="q" type="search" value={query.q} />
        </div>
        <div class="field">
          <label for="published">Published</label>
          <select id="published" name="published">
            <option value="" selected={query.published === ""}>
              All
            </option>
            <option value="1" selected={query.published === "1"}>
              Published
            </option>
            <option value="0" selected={query.published === "0"}>
              Unpublished
            </option>
          </select>
        </div>
        <div class="field">
          <label for="state">Effective state</label>
          <select id="state" name="state">
            {FEATURED_STATES.map((s) => (
              <option value={s.value} selected={query.state === s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <button type="submit" class="btn">
            Filter
          </button>
        </div>
        {featuredListHasFilters(query) ? (
          <div class="field">
            <a href={featuredListClearUrl(query)}>Clear filters</a>
          </div>
        ) : null}
      </form>
      <p>
        Statuses are a point-in-time eligibility verdict, not proof of guest homepage delivery —
        verify the homepage as a guest.
      </p>
      <p id="featured-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
      <div
        class="featured-table-scroll"
        role="region"
        aria-label="Featured content list"
        aria-describedby="featured-scroll-hint"
        tabindex={0}
        data-testid="featured-table-scroll"
      >
        <table class="admin-table featured-table" data-testid="featured-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <TableSortHeader
                label="Position"
                active={query.sort === "position"}
                order={query.order}
                url={(order) => featuredListUrl(query, { sort: "position", order, page: 1 })}
              />
              <th scope="col">Window (UTC)</th>
              <TableSortHeader
                label="Last changed"
                active={query.sort === "updated_at"}
                order={query.order}
                url={(order) => featuredListUrl(query, { sort: "updated_at", order, page: 1 })}
              />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={5} data-testid="featured-empty">
                  {featuredEmptyText(query)}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                // Guarded admin eligibility/bound-display semantics, shared
                // with the Kit list and the edit panel: an undecodable window
                // withholds the verdict and shows its exact saved text.
                const status = featuredInventoryStatus(r, now);
                const startsAt = featuredBoundDisplay(r.startsAt, r.startsAtText);
                const endsAt = featuredBoundDisplay(r.endsAt, r.endsAtText);
                return (
                  <tr key={r.id}>
                    <td>
                      <a href={`/admin/featured/${r.id}`}>{r.title}</a>
                    </td>
                    <td data-testid={`featured-status-${r.id}`}>
                      <span
                        class={`featured-status featured-status-${status}`}
                        data-status={status}
                      >
                        {status}
                      </span>
                    </td>
                    <td data-testid={`featured-position-${r.id}`}>{r.position}</td>
                    <td>
                      <span class="featured-window-bound">
                        {startsAt.kind === "instant" ? (
                          <time datetime={startsAt.iso}>{startsAt.iso}</time>
                        ) : startsAt.kind === "text" ? (
                          startsAt.text
                        ) : (
                          "—"
                        )}
                      </span>
                      <span class="featured-window-bound">
                        →{" "}
                        {endsAt.kind === "instant" ? (
                          <time datetime={endsAt.iso}>{endsAt.iso}</time>
                        ) : endsAt.kind === "text" ? (
                          endsAt.text
                        ) : (
                          "—"
                        )}
                      </span>
                    </td>
                    <td>
                      <time datetime={r.updatedAt.toISOString()}>{r.updatedAt.toISOString()}</time>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && query.page > 1 ? (
        <p>
          <a href={featuredListUrl(query, { page: 1 })}>First page of these results</a>
        </p>
      ) : null}
      <nav aria-label="Featured content pages" class="actions">
        {query.page > 1 ? (
          <a rel="prev" href={featuredListUrl(query, { page: query.page - 1 })}>
            Previous
          </a>
        ) : null}
        <span>Page {query.page}</span>
        {hasNext ? (
          <a rel="next" href={featuredListUrl(query, { page: query.page + 1 })}>
            Next
          </a>
        ) : null}
      </nav>
    </section>
  </Shell>
);
