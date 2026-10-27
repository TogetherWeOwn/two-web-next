import { jsx } from "hono/jsx/jsx-runtime";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Env } from "../../src/env";
import { EventsCalendarPage } from "../../src/events/pages";
import { dispatchEventsRequest } from "../../src/kit-events";
import { GAME_ORIGIN, gameRecoveryFixture, gameRow, type GameTwin } from "./calendar-game-recovery";
import type { CalendarState } from "../../src/islands/contracts";
import { renderEventsHtml } from "../../src/kit-events-html";
import { gathering } from "./calendar-multiday-acceptance";

export const navigationState: CalendarState = {
  view: "list",
  month: "2060-07",
  q: "",
  game: "Co-op",
  past: false,
  page: 3,
  weekStart: "monday",
};

export function navigationData(state: Partial<CalendarState> = {}, totalPages = 7, empty = false) {
  return {
    state: { ...navigationState, ...state },
    upcoming: empty ? [] : [gathering({ title: "Upcoming navigation fixture" })],
    past: [
      gathering({
        title: "Past navigation fixture",
        startsAt: new Date("2025-01-01T12:00:00Z"),
        endsAt: new Date("2025-01-01T14:00:00Z"),
      }),
    ],
    pastMayBeTruncated: true,
    zone: "UTC",
    now: new Date("2026-10-26T00:00:00Z"),
    totalPages,
    emptyState: null,
    discordFailed: false,
    games: ["Co-op", "Other"],
    gameFilter: "Co-op",
    member: false,
    session: null,
    moderator: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://calendar.example.test",
    canonical: "https://calendar.example.test/events",
    loginReturnTo: "/events",
    joinResult: null,
    queryTooLong: false,
    robots: "noindex, follow",
  };
}

export async function navigationHtml(
  twin: "Hono" | "Kit",
  state: Partial<CalendarState> = {},
  totalPages = 7,
  empty = false,
): Promise<string> {
  const data = navigationData(state, totalPages, empty);
  return twin === "Hono"
    ? await jsx(EventsCalendarPage, data).toString()
    : (await renderEventsHtml(data, {})).body;
}

type Node = DefaultTreeAdapterMap["node"];
export function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
export function elements(html: string, tag: string) {
  const found: DefaultTreeAdapterMap["element"][] = [];
  function visit(node: Node) {
    if ("tagName" in node && node.tagName === tag) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  return found;
}
export function attribute(node: DefaultTreeAdapterMap["element"], name: string) {
  return node.attrs.find((attr) => attr.name === name)?.value;
}
export function links(html: string) {
  return elements(html, "a").map((node) => ({
    name: attribute(node, "aria-label") ?? text(node).replace(/\s+/g, " ").trim(),
    href: attribute(node, "href") ?? "",
  }));
}
export function params(href: string) {
  const url = new URL(href, "https://calendar.example.test");
  return { path: url.pathname, search: Object.fromEntries(url.searchParams), hash: url.hash };
}

// SQL-boundary fixture keeps the actual Hono route and Kit loader/model/render.
// Chronological keys are unique across three pages; decoys catch lost filters.
export function navigationRouteFixture() {
  const rows = Array.from({ length: 45 }, (_, i) => ({
    ...gameRow(i + 1, "Chess"),
    eventKey: `navigation-${i + 1}`,
    title: `Navigation gathering ${i + 1}`,
    startsAt: new Date(Date.UTC(2099, 4, 1, i)),
    endsAt: new Date(Date.UTC(2099, 4, 1, i + 2)),
  }));
  const fixture = gameRecoveryFixture({
    upcomingRows: [
      ...rows,
      { ...gameRow(50, "Go"), eventKey: "navigation-decoy", title: "Other game decoy" },
    ],
    pastRows: Array.from({ length: 20 }, (_, i) => ({
      ...gameRow(i + 100, "Chess", true),
      eventKey: `past-navigation-${i}`,
      title: `Past navigation gathering ${i}`,
    })),
  });
  const env = { APP_URL: GAME_ORIGIN, ADMIN_DB: fixture.db } as unknown as Env;
  return {
    ...fixture,
    async request(twin: GameTwin, path: string, island = false) {
      if (twin === "Hono") return fixture.render(twin, path, island);
      const request = new Request(new URL(path, GAME_ORIGIN), {
        headers: island ? { "x-two-island": "events-calendar" } : {},
      });
      return dispatchEventsRequest(request, env, () => fixture.render(twin, path, island), {
        guard: async () => null,
        sessionFor: async () => null,
        journeyFor: async () => null,
      });
    },
  };
}

export const firstPageName = /first.*(?:page|events)/i;
export const lastPageName = /last.*(?:page|events)/i;
export const hidePastName = /hide past events/i;
