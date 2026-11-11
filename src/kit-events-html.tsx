import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import { EventsCalendarPage, EventsSearchTooLongPage } from "./events/pages";
import type { KitEventsLoadData } from "./kit-events";

const RESTORED_WRITE_NOTICE =
  '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';

export interface KitEventsHtml {
  status: 200;
  headers: Record<string, string>;
  body: string;
}

/**
 * Render the Kit events-list model through the Hono calendar screen, so the
 * native endpoint answers byte-identical HTML to GET /events without a
 * Svelte page component (and its client entries/node) in the Kit bundle.
 *
 * Props mirror src/events/routes-calendar.tsx exactly: the too-long branch
 * renders the notice screen with the app URL only (never the query), and the
 * list branch carries the same state/rows/zone/now/pagination/empty-state,
 * member chrome, header session, invite URL, login return and one-shot flash. Status stays
 * 200 here: the dispatch rewrites the marked too-long render to the Hono 422
 * on the way out, exactly like the Hono handler's c.html(..., 422).
 */
export async function renderEventsHtml(
  data: KitEventsLoadData | { queryTooLong: true; appUrl: string },
  headers: Record<string, string>,
  restoredWrite = false,
): Promise<KitEventsHtml> {
  const element = data.queryTooLong ? (
    <EventsSearchTooLongPage appUrl={data.appUrl} />
  ) : (
    <EventsCalendarPage
      state={data.state}
      upcoming={data.upcoming}
      past={data.past}
      pastMayBeTruncated={data.pastMayBeTruncated}
      zone={data.zone}
      now={data.now}
      totalPages={data.totalPages}
      emptyState={data.emptyState}
      robots={data.robots}
      discordFailed={data.discordFailed}
      games={data.games}
      gameFilter={data.gameFilter}
      member={data.member}
      session={data.session}
      inviteUrl={data.inviteUrl}
      appUrl={data.appUrl}
      loginReturnTo={data.loginReturnTo}
      joinResult={data.joinResult}
      markdownAlternate="/events.md"
    />
  );
  const body = await resolveCallback(element, HtmlEscapedCallbackPhase.Stringify, false, {});
  let html = String(body);
  // Full successful calendar documents only: never the too-long 422 screen or
  // an island fragment (no doctype/main). The notice leads the main landmark.
  if (restoredWrite && !data.queryTooLong && /^\s*<!doctype html>/i.test(html))
    html = html.replace(/<main\b[^>]*>/i, (open) => `${open}${RESTORED_WRITE_NOTICE}`);
  return {
    status: 200,
    headers: { ...headers, "content-type": "text/html; charset=UTF-8" },
    body: html,
  };
}
