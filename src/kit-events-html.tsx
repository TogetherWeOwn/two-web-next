import type { JSX } from "hono/jsx/jsx-runtime";
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

/** Render a calendar or the shared refusal; dispatch turns the marked refusal into 422. */
export async function renderEventsHtml(
  data: KitEventsLoadData | { queryTooLong: true; appUrl: string },
  headers: Record<string, string>,
  restoredWrite = false,
  renderCalendar?: (data: KitEventsLoadData) => Promise<JSX.Element>,
): Promise<KitEventsHtml> {
  const element = data.queryTooLong ? (
    <EventsSearchTooLongPage appUrl={data.appUrl} />
  ) : renderCalendar ? (
    await renderCalendar(data)
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
