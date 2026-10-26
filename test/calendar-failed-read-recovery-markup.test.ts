// Failed-read recovery markup contract, shared by both calendar route twins.
//
// The server screen carries the recovery host the fragment binder wires when a
// search/month/view read fails: an explicit retry, a safe return/clear, and a
// polite status naming the attempted destination. The controls are present but
// inert until a failure the binder observes, so they never fire on first paint
// and never take part in a fragment swap. Stable testids (the builder promotes
// them to island contract constants):
//   events-read-retry  explicit retry of the last failed GET intent
//   events-read-clear  safe return that drops the failed intent
//   events-read-status polite status for the failed destination
//
// Both twins render through the same screen component; these pins fail loudly
// if either twin diverges. Direct component render only: no DB, no network.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventsCalendarPage } from "../src/events/pages";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  CALENDAR_MONTH_STATUS_TESTID,
  EVENTS_CAL_FEEDBACK,
  EVENTS_SEARCH_STATUS_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  EVENTS_PAST_STATUS_TESTID,
  EVENTS_LOADING_TESTID,
  EVENTS_SEARCH_TESTID,
  type CalendarState,
} from "../src/islands/contracts";

const RETRY_TESTID = "events-read-retry";
const CLEAR_TESTID = "events-read-clear";
const STATUS_TESTID = "events-read-status";

const APP_URL = "https://example.test";
const NOW = new Date("2026-10-13T12:00:00Z");

const STATES: CalendarState[] = [
  { view: "list", month: "2026-10", q: "", past: false, page: 1, weekStart: "monday" },
  { view: "list", month: "2026-10", q: "raid", past: false, page: 1, weekStart: "monday" },
  { view: "calendar", month: "2026-10", q: "", past: false, page: 1, weekStart: "monday" },
];

const row = () => ({
  discordId: "recovery-1",
  status: "scheduled" as const,
  title: "Game night recovery",
  description: null,
  location: null,
  startsAt: new Date("2026-10-15T19:00:00Z"),
  endsAt: new Date("2026-10-15T21:00:00Z"),
});

async function honoBody(state: CalendarState): Promise<string> {
  return jsx(EventsCalendarPage, {
    state,
    upcoming: [row()],
    past: [],
    games: [],
    gameFilter: null,
    zone: "Europe/London",
    now: NOW,
    totalPages: 1,
    emptyState: null,
    discordFailed: false,
    member: false,
    inviteUrl: "https://discord.gg/example",
    appUrl: APP_URL,
    loginReturnTo: "/events",
  }).toString() as unknown as string;
}

async function kitBody(state: CalendarState): Promise<string> {
  const rendered = await renderEventsHtml(
    {
      state,
      upcoming: [row()],
      past: [],
      games: [],
      gameFilter: null,
      zone: "Europe/London",
      now: NOW,
      totalPages: 1,
      emptyState: null,
      robots: undefined,
      discordFailed: false,
      member: false,
      moderator: false,
      inviteUrl: "https://discord.gg/example",
      appUrl: APP_URL,
      canonical: `${APP_URL}/events`,
      loginReturnTo: "/events",
      joinResult: null,
      queryTooLong: false,
    } as never,
    {},
  );
  return rendered.body;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// A stable recovery hook moved inside any data-cal-zone fails: fragment swaps
// must never re-create the controls or the status line.
function assertOutsideZones(body: string, markers: string[]): void {
  const tagRe = /<[^>]+>/g;
  const stack: boolean[] = [];
  const violations: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const tag = match[0];
    if (tag.startsWith("<!--") || tag.startsWith("<!") || tag.startsWith("<?")) continue;
    if (tag.startsWith("</")) {
      stack.pop();
      continue;
    }
    const name =
      tag
        .slice(1)
        .split(/[\s/>]/, 1)[0]
        ?.toLowerCase() ?? "";
    const isSelfClosing = tag.endsWith("/>") || VOID_ELEMENTS.has(name);
    if (stack.some(Boolean)) {
      for (const marker of markers) {
        if (tag.includes(marker)) violations.push(marker);
      }
    }
    if (!isSelfClosing) {
      stack.push(tag.includes("data-cal-zone="));
    }
  }
  expect(violations).toEqual([]);
}

function elementFor(body: string, testid: string): string {
  const match = body.match(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`));
  expect(match, `missing data-testid="${testid}"`).not.toBeNull();
  return match![0];
}

describe.each([
  { twin: "hono", render: honoBody },
  { twin: "kit", render: kitBody },
])("$twin recovery markup", ({ render }) => {
  it.each(STATES)("carries an inert hidden recovery host ($view q=$q)", async (state) => {
    const body = await render(state);
    const retry = elementFor(body, RETRY_TESTID);
    const clear = elementFor(body, CLEAR_TESTID);
    const status = elementFor(body, STATUS_TESTID);
    // Keyboard-reachable by construction: native controls, never a div with a
    // handler. Hidden until the binder observes a failed read.
    expect(retry.startsWith("<button") || retry.startsWith("<a ")).toBe(true);
    expect(clear.startsWith("<button") || clear.startsWith("<a ")).toBe(true);
    expect(retry).toMatch(/\shidden(=""|\s|>|\/)/);
    expect(clear).toMatch(/\shidden(=""|\s|>|\/)/);
    expect(retry).not.toContain('tabindex="-1"');
    expect(clear).not.toContain('tabindex="-1"');
    // The status announces politely and starts empty: the binder names the
    // attempted destination only when a read actually fails.
    expect(status).toContain('role="status"');
    // Recovery never joins a fragment swap: swaps must not re-create it.
    assertOutsideZones(body, [
      `data-testid="${RETRY_TESTID}"`,
      `data-testid="${CLEAR_TESTID}"`,
      `data-testid="${STATUS_TESTID}"`,
    ]);
  });

  it.each(STATES)("keeps the existing failure and loading hooks ($view q=$q)", async (state) => {
    const body = await render(state);
    expect(body).toContain(EVENTS_CAL_FEEDBACK);
    expect(body).toContain("data-load-error=");
    expect(body).toContain(`data-testid="${EVENTS_LOADING_TESTID}"`);
    for (const testid of [
      EVENTS_VIEW_STATUS_TESTID,
      EVENTS_SEARCH_STATUS_TESTID,
      EVENTS_PAST_STATUS_TESTID,
      CALENDAR_MONTH_STATUS_TESTID,
      EVENTS_SEARCH_TESTID,
    ]) {
      expect(body).toContain(`data-testid="${testid}"`);
    }
    assertOutsideZones(body, [
      `data-testid="${EVENTS_VIEW_STATUS_TESTID}"`,
      `data-testid="${EVENTS_SEARCH_STATUS_TESTID}"`,
      `data-testid="${EVENTS_PAST_STATUS_TESTID}"`,
      `data-testid="${CALENDAR_MONTH_STATUS_TESTID}"`,
      `data-testid="${EVENTS_SEARCH_TESTID}"`,
      EVENTS_CAL_FEEDBACK,
    ]);
  });
});
