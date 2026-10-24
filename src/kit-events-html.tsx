import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import { EventsCalendarPage, EventsSearchTooLongPage } from "./events/pages";
import type { KitEventsLoadData } from "./kit-events";

export interface KitEventsHtml {
  status: 200;
  headers: Record<string, string>;
  body: string;
}

// Twinned deliberately (never imported from the .tsx): importing the Hono
// screen would bundle the JSX runtime into the Kit worker, and the
// acceptance suite pins both copies byte-identical.
const RESTORED_WRITE_BANNER =
  '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';

/**
 * Render the Kit events-list model through the Hono calendar screen, so the
 * native endpoint answers byte-identical HTML to GET /events without a
 * Svelte page component (and its client entries/node) in the Kit bundle.
 *
 * Props mirror src/events/routes-calendar.tsx exactly: the too-long branch
 * renders the notice screen with the app URL only (never the query), and the
 * list branch carries the same state/rows/zone/now/pagination/empty-state,
 * member chrome, invite URL, login return and one-shot flash. Status stays
 * 200 here: the dispatch rewrites the marked too-long render to the Hono 422
 * on the way out, exactly like the Hono handler's c.html(..., 422).
 *
 * A restored-write notice injects the "you signed in again" banner first
 * inside <main> with Hono's own injection regex, exactly as the
 * expiredWriteBanner middleware places it; the destination is never
 * rendered, so a hostile value stays inert. Absent by default, so existing
 * callers render byte-identical HTML. The hook core consumes the one-shot
 * cookie after the released response and marks it uncacheable.
 */
export async function renderEventsHtml(
  data: KitEventsLoadData | { queryTooLong: true; appUrl: string },
  headers: Record<string, string>,
  options?: { restoredWrite?: string | null },
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
      inviteUrl={data.inviteUrl}
      appUrl={data.appUrl}
      loginReturnTo={data.loginReturnTo}
      joinResult={data.joinResult}
      markdownAlternate="/events.md"
    />
  );
  const body = await resolveCallback(element, HtmlEscapedCallbackPhase.Stringify, false, {});
  const html = String(body);
  return {
    status: 200,
    headers: { ...headers, "content-type": "text/html; charset=UTF-8" },
    body: options?.restoredWrite
      ? html.replace(/(<main\b[^>]*>)/, `$1${RESTORED_WRITE_BANNER}`)
      : html,
  };
}
