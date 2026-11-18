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

type EventsHtmlData = KitEventsLoadData | { queryTooLong: true; appUrl: string };

/** Status stays 200 here; dispatch rewrites the marked refusal to 422. */
export async function renderEventsDocument(
  data: EventsHtmlData,
  headers: Record<string, string>,
  restoredWrite: boolean,
  renderCalendar: (data: KitEventsLoadData) => JSX.Element | Promise<JSX.Element>,
): Promise<KitEventsHtml> {
  const element = data.queryTooLong ? (
    <EventsSearchTooLongPage appUrl={data.appUrl} />
  ) : (
    await renderCalendar(data)
  );
  const body = await resolveCallback(element, HtmlEscapedCallbackPhase.Stringify, false, {});
  let html = String(body);
  // The endpoint only requests the notice on a full navigation, not on swaps.
  if (restoredWrite && !data.queryTooLong && /^\s*<!doctype html>/i.test(html))
    html = html.replace(/<main\b[^>]*>/i, (open) => `${open}${RESTORED_WRITE_NOTICE}`);
  return {
    status: 200,
    headers: { ...headers, "content-type": "text/html; charset=UTF-8" },
    body: html,
  };
}

/** Hono reference renderer for the shared read-model and parity fixtures. */
export function renderEventsHtml(
  data: EventsHtmlData,
  headers: Record<string, string>,
  restoredWrite = false,
): Promise<KitEventsHtml> {
  return renderEventsDocument(data, headers, restoredWrite, (data) => (
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
  ));
}
