// Admin featured-list screen (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import { FeaturedStatusBadge } from "../../featured-status";
import type { FeaturedRow } from "../store";
import { featuredEmptyText, featuredListUrl, type FeaturedListQuery } from "../table-list";
import { Shell, TableSortHeader } from "./shell";

export const FeaturedPage: FC<{
  rows: FeaturedRow[];
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
          <button type="submit" class="btn">
            Filter
          </button>
        </div>
      </form>
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
              rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/admin/featured/${r.id}`}>{r.title}</a>
                  </td>
                  <td data-testid={`featured-status-${r.id}`}>
                    <FeaturedStatusBadge row={r} now={now} />
                  </td>
                  <td data-testid={`featured-position-${r.id}`}>{r.position}</td>
                  <td>
                    <span class="featured-window-bound">
                      {r.startsAt ? (
                        <time datetime={r.startsAt.toISOString()}>{r.startsAt.toISOString()}</time>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span class="featured-window-bound">
                      →{" "}
                      {r.endsAt ? (
                        <time datetime={r.endsAt.toISOString()}>{r.endsAt.toISOString()}</time>
                      ) : (
                        "—"
                      )}
                    </span>
                  </td>
                  <td>
                    <time datetime={r.updatedAt.toISOString()}>{r.updatedAt.toISOString()}</time>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
