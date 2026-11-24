import { raw } from "hono/html";
import { render } from "svelte/server";
import { renderEventsHtml as renderEventsDocument } from "../../../../src/kit-events-html";
import CalendarScreen from "../CalendarScreen.svelte";
import EventsDocument from "../EventsDocument.svelte";
import { projectEventsCalendar } from "./events-calendar";

export function renderEventsHtml(
  data: Parameters<typeof renderEventsDocument>[0],
  headers: Record<string, string>,
  restoredWrite = false,
  island = false,
) {
  return renderEventsDocument(data, headers, restoredWrite, async (data) => {
    const screen = { ...projectEventsCalendar(data), joinResult: data.joinResult, island };
    if (island) {
      const { body } = await render(CalendarScreen, { props: screen });
      return (
        <>
          <link rel="canonical" href={data.canonical} />
          {!data.session && !data.member && data.loginReturnTo ? (
            <header hidden>
              <a
                data-testid="signin"
                href={`/auth/discord?next=${encodeURIComponent(data.loginReturnTo)}`}
              >
                Sign in with Discord
              </a>
            </header>
          ) : null}
          {raw(body)}
        </>
      );
    }

    const { head, body } = await render(EventsDocument, {
      props: { canonical: data.canonical, robots: data.robots, session: data.session, screen },
    });
    return (
      <>
        {raw("<!doctype html>")}
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="theme-color" content="#15100f" />
            <link rel="manifest" href="/site.webmanifest" />
            <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
            <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
            <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
            {/* Only Svelte's escaped SSR output crosses into the document as HTML. */}
            <link rel="stylesheet" href="/theme-tokens.css" />
            {raw(head)}
          </head>
          <body class="base-theme schedule-theme kit-events-document">
            {raw(body)}
            <script src="/islands/copy-link.js" defer />
            <script src="/islands/events-calendar.js" defer />
          </body>
        </html>
      </>
    );
  });
}
