// Member leaderboard HTML.
//
// Rank + display name + going count only: no timestamps, no per-member detail.
// Server-rendered, no script. Rows never link to profiles from here.
import type { FC } from "hono/jsx";
import type { Session } from "../env";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import { canonicalUrl } from "../seo";
import { boardCaption } from "./captions";
import type { BoardRow, MemberScope } from "./members";

export type BoardQuery = { season: string; scope: MemberScope; activity: string | null };

export function boardPath({ season, scope, activity }: BoardQuery): string {
  const params = new URLSearchParams();
  if (season !== "all") params.set("season", season);
  if (scope !== "overall") params.set("scope", scope);
  if (activity !== null) params.set("activity", activity);
  const query = params.toString();
  return query === "" ? "/leaderboards/members" : `/leaderboards/members?${query}`;
}

export const MemberLeaderboardPage: FC<{
  appUrl: string;
  session: Session;
  query: BoardQuery;
  rows: BoardRow[];
  /** False when no database is configured: the empty board is not "nobody ranked". */
  available: boolean;
}> = ({ appUrl, session, query, rows, available }) => {
  const path = boardPath(query);
  const label = query.activity === null ? "every game" : query.activity;
  return (
    <Layout
      title="Member leaderboard — Together We Own"
      canonical={canonicalUrl(appUrl, "/leaderboards/members")}
      shareDescription="Members ranked by events attended."
      robots="noindex, nofollow"
      theme="schedule"
    >
      <SiteHeader session={session} active="leaderboard" loginReturnTo={path} />
      <main class="events-page" id="main" tabindex={-1}>
        <p class="strap">Members only</p>
        <h1>Member leaderboard</h1>
        <p>
          Members ranked by events they answered going to, for season {query.season} and {label}.
          Members can opt out of leaderboards; see the <a href="/privacy">privacy policy</a>.
        </p>
        <nav aria-label="Board scope">
          <ul>
            <li>
              <a
                href={boardPath({ ...query, scope: "overall" })}
                aria-current={query.scope === "overall" ? "page" : undefined}
              >
                Overall
              </a>
            </li>
            <li>
              <a
                href={boardPath({ ...query, scope: "relative" })}
                aria-current={query.scope === "relative" ? "page" : undefined}
              >
                Around you
              </a>
            </li>
          </ul>
        </nav>
        <form method="get" action="/leaderboards/members" aria-label="Filter the leaderboard">
          {query.scope === "overall" ? null : (
            <input type="hidden" name="scope" value={query.scope} />
          )}
          <p>
            <label for="board-season">Season (all, 2026, 2026-09 or 2026-Q3)</label>{" "}
            <input id="board-season" name="season" type="text" value={query.season} />
          </p>
          <p>
            <label for="board-activity">Game (blank for every game)</label>{" "}
            <input id="board-activity" name="activity" type="text" value={query.activity ?? ""} />
          </p>
          <p>
            <button class="btn" type="submit">
              Show board
            </button>
          </p>
        </form>
        {!available ? (
          <p role="status">Rankings are temporarily unavailable.</p>
        ) : rows.length === 0 ? (
          query.scope === "relative" ? (
            <p role="status">
              You are not ranked for this season and game yet. See the{" "}
              <a href={boardPath({ ...query, scope: "overall" })}>overall board</a>, or answer going
              to get ranked at an upcoming <a href="/events">event</a>.
            </p>
          ) : query.activity === null ? (
            <p role="status">
              Nobody is ranked for this season and game yet. Browse <a href="/events">events</a> to
              get ranked.
            </p>
          ) : (
            <p role="status">
              Nobody is ranked for this season and game yet. Browse <a href="/events">events</a> to
              get ranked, or <a href={boardPath({ ...query, activity: null })}>show every game</a>.
            </p>
          )
        ) : (
          <table class="member-board-table">
            <caption>{boardCaption(query)}</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Member</th>
                <th scope="col">Going</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr aria-current={row.userId === session.id ? "true" : undefined}>
                  <td>{row.rank}</td>
                  <th scope="row">{row.username}</th>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
      <SiteFooter />
    </Layout>
  );
};

// Bad-filter 400 in the member shell. The viewer passed the gate, so the
// refusal keeps their signed-in header and names the refused filter in the
// parse message's own words — never bare text, never outage copy. Served
// through bufferedMemberHtml so the member-read boundary classifies it like
// any other member response; no ranking read and no log writes happen.
export const MemberBoardFilterErrorPage: FC<{
  session: Session;
  /** The refused filter, e.g. "Unknown season". Static parse messages only;
   * most carry no closing period, so the lead supplies one. */
  problem: string;
}> = ({ session, problem }) => (
  <Layout title="Board filters — Together We Own" robots="noindex, nofollow" theme="schedule">
    <SiteHeader session={session} active="leaderboard" />
    <main class="events-page" id="main" tabindex={-1}>
      <p class="strap">Members only</p>
      <h1>Check the board filters</h1>
      <p class="lead">
        {problem.endsWith(".") ? problem : `${problem}.`} Show the board without filters, or head
        back to the homepage.
      </p>
      <p class="recovery-actions">
        <a class="btn" href="/leaderboards/members" data-testid="error-board">
          Show the board
        </a>{" "}
        <a href="/" data-testid="error-home">
          Back to the homepage
        </a>
      </p>
    </main>
    <SiteFooter />
  </Layout>
);
