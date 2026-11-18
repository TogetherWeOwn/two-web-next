import { raw } from "hono/html";
import { render } from "svelte/server";
import { ScheduleShell } from "../../../../src/events/pages-shared";
import { renderEventsHtml as renderEventsDocument } from "../../../../src/kit-events-html";
import CalendarScreen from "../CalendarScreen.svelte";
import { projectEventsCalendar } from "./events-calendar";

export function renderEventsHtml(
  data: Parameters<typeof renderEventsDocument>[0],
  headers: Record<string, string>,
  restoredWrite: boolean,
) {
  return renderEventsDocument(data, headers, restoredWrite, async (data) => {
    const { body } = await render(CalendarScreen, {
      props: { ...projectEventsCalendar(data), joinResult: data.joinResult },
    });
    return (
      <ScheduleShell
        title="Events"
        canonical={data.canonical}
        description="Game nights, tournaments and whatever else the community puts on."
        robots={data.robots}
        member={data.member}
        session={data.session}
        loginReturnTo={data.loginReturnTo}
        markdownAlternate="/events.md"
      >
        {/* Only Svelte's escaped SSR output crosses into the document as HTML. */}
        {raw(body)}
        <script src="/islands/copy-link.js" defer />
        <script src="/islands/events-calendar.js" defer />
      </ScheduleShell>
    );
  });
}
