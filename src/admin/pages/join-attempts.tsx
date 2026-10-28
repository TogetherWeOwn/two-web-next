// Admin join-attempts screens: list and detail (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import { JOIN_RETENTION_DAYS, type JoinAttemptRow } from "../reads";
import {
  joinAttemptsUrl,
  type JoinAttemptsQuery,
  JOIN_EVIDENCE_NOTE,
  joinAttemptContextSearch,
  joinAttemptsEmptyText,
  joinDiagnostic,
} from "../table-list";
import { Shell } from "./shell";

export const JoinAttemptsPage: FC<{
  rows: JoinAttemptRow[];
  query: JoinAttemptsQuery;
  hasNext: boolean;
  outcomes: readonly string[];
}> = ({ rows, query, hasNext, outcomes }) => {
  const contextSearch = joinAttemptContextSearch(query);
  return (
    <Shell title="Join attempts">
      <section>
        <h1>Join attempts</h1>
        <p class="hint">
          Read-only. Last {JOIN_RETENTION_DAYS} days, newest first. Search is an exact Discord id or
          request id.
        </p>
        <form method="get" action="/admin/join-attempts" class="filters">
          <div class="field">
            <label for="q">Discord id or request id</label>
            <input id="q" name="q" type="search" value={query.q} />
          </div>
          <div class="field">
            <label for="outcome">Outcome</label>
            <select id="outcome" name="outcome">
              {["", ...outcomes].map((o) => (
                <option value={o} selected={o === query.outcome}>
                  {o === "" ? "All" : o}
                </option>
              ))}
              {/* An unrecognized outcome is still the active exact filter, so it
                gets its own selected option instead of misleadingly showing
                All. Hono escapes the value and label. */}
              {query.outcome !== "" && !(outcomes as readonly string[]).includes(query.outcome) ? (
                <option value={query.outcome} selected>
                  {query.outcome}
                </option>
              ) : null}
            </select>
          </div>
          <div class="field">
            <button type="submit" class="btn">
              Filter
            </button>
          </div>
        </form>
        {query.outcome || query.q ? (
          <p>
            <a href="/admin/join-attempts">Clear filters</a>
          </p>
        ) : null}
        <p>{JOIN_EVIDENCE_NOTE}</p>
        <p id="join-attempts-scroll-hint">
          Scroll horizontally to see all columns on smaller screens.
        </p>
        <div
          class="admin-table-scroll"
          role="region"
          aria-label="Join attempts list"
          aria-describedby="join-attempts-scroll-hint"
          tabindex={0}
          data-testid="join-attempts-table-scroll"
        >
          <table class="admin-table" data-testid="join-attempts-table">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Source</th>
                <th scope="col">Discord id</th>
                <th scope="col">Request id</th>
                <th scope="col">Attempted</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colspan={5} data-testid="join-attempts-empty">
                    {joinAttemptsEmptyText(query, JOIN_RETENTION_DAYS)}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a
                        href={`/admin/join-attempts/${r.id}${contextSearch}`}
                        aria-label={`View join attempt ${r.id}: ${r.outcome}`}
                      >
                        {r.outcome}
                      </a>
                    </td>
                    <td>{joinDiagnostic(r.source)}</td>
                    <td>{joinDiagnostic(r.discordId)}</td>
                    <td>{joinDiagnostic(r.requestId)}</td>
                    <td>{r.createdAt.toISOString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && query.page > 1 ? (
          <p>
            <a href={joinAttemptsUrl(query, 1)}>First page</a>
          </p>
        ) : null}
        <nav aria-label="Join attempt pages" class="actions">
          {query.page > 1 ? (
            <a rel="prev" href={joinAttemptsUrl(query, query.page - 1)}>
              Previous
            </a>
          ) : null}
          <span>Page {query.page}</span>
          {hasNext ? (
            <a rel="next" href={joinAttemptsUrl(query, query.page + 1)}>
              Next
            </a>
          ) : null}
        </nav>
      </section>
    </Shell>
  );
};

export const JoinAttemptPage: FC<{ row: JoinAttemptRow; returnUrl?: string }> = ({
  row,
  returnUrl = "/admin/join-attempts",
}) => (
  <Shell title={`Join attempt ${row.id}`}>
    <section>
      <p>
        <a href={returnUrl}>Back to join attempts</a>
      </p>
      <h1>Join attempt {row.id}</h1>
      <p class="hint">Read-only. Attempted at and trace identifiers are shown as recorded.</p>
      <p>{JOIN_EVIDENCE_NOTE}</p>
      <h2>Outcome</h2>
      <dl>
        <dt>Outcome</dt>
        <dd>{row.outcome}</dd>
        <dt>Source</dt>
        <dd>{joinDiagnostic(row.source)}</dd>
        <dt>Attempted at (UTC)</dt>
        <dd>
          <time datetime={row.createdAt.toISOString()}>{row.createdAt.toISOString()}</time>
        </dd>
      </dl>
      <h2>Trace</h2>
      <dl>
        <dt>Request ID</dt>
        <dd>{joinDiagnostic(row.requestId)}</dd>
        <dt>Discord ID</dt>
        <dd>{joinDiagnostic(row.discordId)}</dd>
      </dl>
    </section>
  </Shell>
);
