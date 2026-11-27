// Kit calendar/search progressive-enhancement parity.
//
// The native GET /events endpoint renders the Hono calendar screen through
// renderEventsHtml with no Svelte page and no global hydration; the shipped
// binder (assets/islands/events-calendar.js) upgrades the same markup. These
// pins prove the Kit render preserves the contract the merged island fixes
// rely on: one shareable URL model for list/month/search/bookmark, fragment
// swaps that never touch auth lineage, the data hooks every fix reads, the
// no-JS fallback (real anchors + GET form) and the CSP/keyboard surface.
// Green on arrival: the shared screen already carries all of it; the pins
// exist so a Kit divergence fails loudly instead of silently dropping a fix.
import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it, vi } from "vitest";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import { resolveCalendarInput } from "../src/events/page-models.server";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_STATUS_TESTID,
  CALENDAR_MONTH_TESTID,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  EVENTS_CAL_FEEDBACK,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_TESTID,
  EVENTS_CONTENT_TESTID,
  EVENTS_LIST_TESTID,
  EVENTS_LOADING_TESTID,
  EVENTS_OUT_OF_RANGE_TESTID,
  EVENTS_PAST_STATUS_TESTID,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  EVENTS_SEARCH_CLEAR_TESTID,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_STATUS_TESTID,
  EVENTS_SEARCH_TESTID,
  EVENTS_SEARCH_TOO_LONG_COPY,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_LIST_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  EVENT_CARD_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  WEEKDAY_HEADINGS,
  calendarJumpUrl,
  calendarMonthLabel,
  calendarUrl,
  eventsSearchHitCopy,
} from "../src/islands/contracts";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

const env = {
  APP_URL: "https://example.test",
  DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next_tog22135parity0001",
  DISCORD_INVITE_URL: "https://discord.gg/example",
} as never;

const sampleRow = () => ({
  discordId: "parity-1",
  status: "scheduled" as const,
  title: "Game night parity",
  description: null,
  location: null,
  startsAt: new Date("2026-10-15T19:00:00Z"),
  endsAt: new Date("2026-10-15T21:00:00Z"),
});

const baseData = () => ({
  state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
  upcoming: [sampleRow()],
  past: [],
  zone: "Europe/London",
  now: new Date("2026-10-13T12:00:00Z"),
  totalPages: 1,
  emptyState: null,
  games: [],
  gameFilter: null,
  robots: undefined,
  discordFailed: false,
  member: false,
  moderator: false,
  inviteUrl: "https://discord.gg/example",
  appUrl: "https://example.test",
  canonical: "https://example.test/events",
  loginReturnTo: "/events",
  joinResult: null,
  queryTooLong: false,
});

type Element = DefaultTreeAdapterMap["element"];

function byTestId(nodes: Element[], testId: string): Element | undefined {
  return nodes.find((node) => attr(node, "data-testid") === testId);
}

function inSwapZone(element: Element): boolean {
  for (
    let node: Element["parentNode"] = element;
    node;
    node = defaultTreeAdapter.getParentNode(node)
  ) {
    if ("tagName" in node && attr(node, "data-cal-zone") !== undefined) return true;
  }
  return false;
}

const headers = {
  "cache-control": "public, max-age=60",
  vary: "Cookie, X-Two-Island",
  "x-two-events-cacheable": "true",
};

describe("Kit calendar island mount parity", () => {
  it("carries every data hook the fragment binder reads", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);
    const document = elements(parse(rendered.body));

    // Mount identity the binder queries before doing anything.
    const mount = document.find((node) => attr(node, "data-island") === "events-calendar");
    expect(mount).toBeDefined();
    expect(attr(mount!, "data-testid")).toBe(EVENTS_CALENDAR_TESTID);
    expect(attr(mount!, "data-view")).toBe("list");
    expect(attr(mount!, "data-month")).toBe("2026-10");
    // Over-limit naming and failure copy come from data, never from the query.
    expect(attr(mount!, "data-search-max-length")).toBe(String(EVENTS_SEARCH_MAX_LENGTH));
    expect(attr(mount!, "data-search-too-long")).toBe(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(attr(mount!, "data-load-error")).toBe("Couldn't refresh the events — try again.");
    // Stable zones: head/actions/miss/content/subscribe swap, everything else persists.
    const nodes = elements(mount!).slice(1);
    const zones = nodes
      .map((node) => attr(node, "data-cal-zone"))
      .filter((zone) => zone !== undefined);
    expect(zones.sort()).toEqual(["actions", "content", "head", "miss", "subscribe"]);
    expect(nodes.some((node) => attr(node, EVENTS_CAL_FEEDBACK) !== undefined)).toBe(true);
    // A real row renders the list card instead of the out-of-range note.
    expect(byTestId(nodes, EVENT_CARD_TESTID)).toBeDefined();
    expect(byTestId(nodes, EVENTS_LIST_TESTID)).toBeDefined();
    expect(byTestId(document, EVENTS_OUT_OF_RANGE_TESTID)).toBeUndefined();
    expect(attr(byTestId(nodes, EVENTS_CONTENT_TESTID)!, "data-cal-zone")).toBe("content");
    // Skeleton stays hidden until a member-started action shows it.
    const skeleton = byTestId(nodes, EVENTS_LOADING_TESTID);
    expect(skeleton).toBeDefined();
    expect(attr(skeleton!, "hidden")).toBeDefined();
    // Live regions stay outside the swapped zones so they are never re-created.
    const stableIds = [
      EVENTS_VIEW_STATUS_TESTID,
      EVENTS_SEARCH_STATUS_TESTID,
      EVENTS_PAST_STATUS_TESTID,
      CALENDAR_MONTH_STATUS_TESTID,
      EVENTS_SEARCH_TESTID,
      EVENTS_LOADING_TESTID,
    ];
    for (const testId of stableIds) {
      expect(byTestId(nodes, testId)).toBeDefined();
    }
    const stableNodes = nodes.filter(
      (node) =>
        stableIds.some((id) => attr(node, "data-testid") === id) ||
        attr(node, EVENTS_CAL_FEEDBACK) !== undefined,
    );
    expect(stableNodes.filter(inSwapZone)).toEqual([]);
    // The binder itself: one deferred external script, the no-global-hydration deal.
    const scripts = document.filter(
      (node) => node.tagName === "script" && attr(node, "src") === "/islands/events-calendar.js",
    );
    expect(scripts).toHaveLength(1);
    expect(attr(scripts[0]!, "defer")).toBeDefined();
  });

  it("renders the month grid with real prev/next and day-cell anchors", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "calendar", month: "2026-10", q: "", past: false, page: 1 },
      } as never,
      headers,
    );

    const nodes = elements(parse(rendered.body));
    const grid = byTestId(nodes, EVENTS_CALENDAR_GRID_TESTID);
    expect(grid?.tagName).toBe("table");
    const month = byTestId(nodes, CALENDAR_MONTH_TESTID);
    expect(month).toBeDefined();
    expect(textOf(month!)).toBe(calendarMonthLabel("2026-10"));
    // Month steps share the list's URL model: view + month params only.
    for (const [label, month] of [
      [CALENDAR_PREV_LABEL, "2026-09"],
      [CALENDAR_NEXT_LABEL, "2026-11"],
    ]) {
      const step = nodes.find((node) => node.tagName === "a" && attr(node, "aria-label") === label);
      expect(step).toBeDefined();
      expect(attr(step!, "href")).toBe(`/events?view=calendar&month=${month}`);
    }
    const cells = elements(grid!);
    const headings = cells.filter((node) => node.tagName === "th" && attr(node, "scope") === "col");
    expect(headings.map(textOf)).toEqual(WEEKDAY_HEADINGS);
    // The fixture row lands in-month, so day cells carry real jump anchors.
    const day = cells.find(
      (node) =>
        attr(node, "data-testid") === CALENDAR_DAY_TESTID &&
        attr(node, "data-date") === "2026-10-15",
    );
    expect(day?.tagName).toBe("td");
    expect(byTestId(nodes, CALENDAR_MONTH_STATUS_TESTID)).toBeDefined();
    const jump = elements(day!).find(
      (node) => node.tagName === "a" && attr(node, "data-cal-jump") !== undefined,
    );
    expect(attr(jump!, "href")).toBe(calendarJumpUrl(false, "discord-parity-1"));
    expect(textOf(jump!)).toContain("Game night parity");
  });

  it("keeps search a GET form with real anchors so no-JS stays functional", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "list", month: "2026-10", q: "chess", past: false, page: 1 },
        upcoming: [{ ...sampleRow(), title: "Chess night" }],
      } as never,
      { ...headers, "cache-control": "private, no-store" },
    );

    const nodes = elements(parse(rendered.body));
    const form = nodes.find((node) => node.tagName === "form" && attr(node, "role") === "search");
    expect(attr(form!, "method")).toBe("get");
    expect(attr(form!, "action")).toBe("/events");
    const controls = elements(form!);
    const query = byTestId(controls, EVENTS_SEARCH_TESTID);
    expect(query?.tagName).toBe("input");
    expect(attr(query!, "name")).toBe("q");
    expect(attr(query!, "value")).toBe("chess");
    expect(
      controls.some((node) => node.tagName === "button" && attr(node, "type") === "submit"),
    ).toBe(true);
    // A settled search names its hit line and offers a real clear navigation.
    expect(textOf(byTestId(nodes, EVENTS_SEARCH_STATUS_TESTID)!)).toBe(
      eventsSearchHitCopy("chess"),
    );
    expect(textOf(byTestId(nodes, EVENT_CARD_TESTID)!)).toContain("Chess night");
    expect(byTestId(nodes, EVENTS_OUT_OF_RANGE_TESTID)).toBeUndefined();
    for (const [link, href] of [
      [byTestId(controls, EVENTS_SEARCH_CLEAR_TESTID), "/events"],
      [byTestId(nodes, EVENTS_VIEW_LIST_TESTID), "/events?q=chess"],
      [byTestId(nodes, EVENTS_VIEW_CALENDAR_TESTID), "/events?q=chess&view=calendar&month=2026-10"],
    ] as const) {
      expect(link?.tagName).toBe("a");
      expect(attr(link!, "href")).toBe(href);
    }
  });

  it("renders the search-miss block with a clear-empty navigation", async () => {
    // totalPages 0 keeps the screen out of the out-of-range branch: a miss
    // with matches on another page renders the pager note instead, by contract.
    // upcoming [] overrides the shared visible-row fixture so this renders a
    // true miss, and the assertion pins the miss block's own clear link.
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "list", month: "2026-10", q: "xyzzy", past: false, page: 1 },
        upcoming: [],
        totalPages: 0,
      } as never,
      { ...headers, "cache-control": "private, no-store" },
    );

    const miss = byTestId(elements(parse(rendered.body)), EVENTS_EMPTY_SEARCH_TESTID);
    expect(miss).toBeDefined();
    expect(textOf(miss!)).toContain("Nothing matches that search.");
    const clear = byTestId(elements(miss!), EVENTS_SEARCH_CLEAR_EMPTY_TESTID);
    expect(clear?.tagName).toBe("a");
    expect(attr(clear!, "href")).toBe("/events");
  });

  it("keeps skip-link, main and heading focus targets for keyboard users", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);

    const nodes = elements(parse(rendered.body));
    const skipLink = nodes.find((node) => attr(node, "class")?.split(/\s+/).includes("skip-link"));
    expect(skipLink?.tagName).toBe("a");
    expect(attr(skipLink!, "href")).toBe("#main");
    const main = nodes.find((node) => attr(node, "id") === "main");
    expect(main?.tagName).toBe("main");
    expect(attr(main!, "tabindex")).toBe("-1");
    const heading = elements(main!).find((node) => attr(node, "id") === "events-heading");
    expect(heading?.tagName).toBe("h1");
    expect(attr(heading!, "tabindex")).toBe("-1");
    expect(byTestId(elements(main!), EVENTS_LIST_TESTID)).toBeDefined();
  });

  it("emits no inline scripts or handlers, keeping script-src 'self' intact", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);

    // A browser parses noscript markup differently depending on whether scripting is enabled.
    for (const scriptingEnabled of [true, false]) {
      const nodes = elements(parse(rendered.body, { scriptingEnabled }));
      for (const node of nodes) {
        if ("content" in node)
          nodes.push(...elements(node.content as DefaultTreeAdapterMap["documentFragment"]));
      }
      const scripts = nodes.filter((node) => node.tagName === "script");
      const context = `scriptingEnabled=${scriptingEnabled}`;
      expect(
        scripts.filter((node) => node.namespaceURI !== html.NS.HTML || !attr(node, "src")?.trim()),
        context,
      ).toEqual([]);
      expect(
        nodes.flatMap((node) => node.attrs).filter(({ name }) => name.startsWith("on")),
        context,
      ).toEqual([]);
      expect(
        scripts.filter(
          (node) => attr(node, "type")?.trim().toLowerCase() === "application/ld+json",
        ),
        context,
      ).toEqual([]);
    }
  });
});

describe("Kit calendar shared URL model", () => {
  it("forces searches into the list view with the raw query preserved", () => {
    const input = resolveCalendarInput({ q: " chess ", view: "calendar", month: "2026-10" });

    expect(input.searching).toBe(true);
    expect(input.view).toBe("list");
    expect(input.q).toBe(" chess ");
    expect(
      calendarUrl({ view: "list", month: "2026-10", q: "chess", game: "", past: false, page: 1 }),
    ).toBe("/events?q=chess");
  });

  it("addresses month steps and bookmark jumps through the same params", () => {
    expect(
      calendarUrl({ view: "calendar", month: "2026-10", q: "", game: "", past: false, page: 1 }),
    ).toBe("/events?view=calendar&month=2026-10");
    expect(calendarJumpUrl(false, "ev-1")).toBe("/events?event=ev-1#event-ev-1");
    expect(calendarJumpUrl(true, "ev-1")).toBe("/events?event=ev-1&past=1#event-ev-1");
  });

  it("passes bookmark jumps to the model with the raw return-to intact", async () => {
    const modelForFn = vi.fn(async () => ({
      state: { view: "list" as const, month: "2026-10", q: "", game: "", past: true, page: 1 },
      upcoming: [],
      past: [],
      zone: "Europe/London",
      totalPages: 1,
      emptyState: null,
      robots: "noindex, follow",
      discordFailed: false,
      games: [],
      gameFilter: null,
    }));
    const setHeaders = vi.fn();
    const data = await loadEventsPage({
      env,
      url: new URL("https://example.test/events?event=ev-1&past=1"),
      method: "GET",
      island: false,
      request: new Request("https://example.test/events?event=ev-1&past=1"),
      setHeaders,
      deleteJoinCookie: vi.fn(),
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });

    expect(modelForFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ jumpKey: "ev-1", jumpRequested: true, past: true }),
      }),
    );
    expect(data).toMatchObject({ loginReturnTo: "/events?event=ev-1&past=1" });
  });
});

describe("Kit calendar fragment auth lineage", () => {
  it("personalizes island fragments without consuming the join flash", async () => {
    const journeyForFn = vi.fn(async () => "added" as const);
    const deleteJoinCookie = vi.fn();
    const setHeaders = vi.fn();
    const modelForFn = vi.fn(async () => ({
      state: { view: "calendar" as const, month: "2026-10", q: "", game: "", past: false, page: 1 },
      upcoming: [],
      past: [],
      zone: "Europe/London",
      totalPages: 1,
      emptyState: null,
      robots: undefined,
      discordFailed: false,
      games: [],
      gameFilter: null,
    }));
    const data = await loadEventsPage({
      env,
      url: new URL("https://example.test/events?view=calendar&month=2026-10"),
      method: "GET",
      island: true,
      request: new Request("https://example.test/events?view=calendar&month=2026-10", {
        headers: { "x-two-island": "events-calendar" },
      }),
      setHeaders,
      deleteJoinCookie,
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => ({ username: "parity-member", member: true, moderator: false }),
      journeyForFn,
      modelForFn,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });

    // The fragment still resolves viewer bits (member chrome) through the
    // read-only session path, but a refresh that only swaps zones must never
    // spend the one-shot banner or rotate the session: no cookie write is queued.
    expect(data).toMatchObject({ member: true, joinResult: null });
    expect(journeyForFn).not.toHaveBeenCalled();
    expect(deleteJoinCookie).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );
    // The Kit-owned translation forwards the shared URL model to the model.
    expect(modelForFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ view: "calendar", month: "2026-10", page: 1 }),
      }),
    );
  });

  it("forwards month and page turns to the Kit model", async () => {
    const modelForFn = vi.fn(async () => ({
      state: { view: "calendar" as const, month: "2026-10", q: "", game: "", past: false, page: 2 },
      upcoming: [],
      past: [],
      zone: "Europe/London",
      totalPages: 2,
      emptyState: null,
      robots: undefined,
      discordFailed: false,
      games: [],
      gameFilter: null,
    }));
    await loadEventsPage({
      env,
      url: new URL("https://example.test/events?view=calendar&month=2026-10&page=2"),
      method: "GET",
      island: true,
      request: new Request("https://example.test/events?view=calendar&month=2026-10&page=2", {
        headers: { "x-two-island": "events-calendar" },
      }),
      setHeaders: vi.fn(),
      deleteJoinCookie: vi.fn(),
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });

    expect(modelForFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ view: "calendar", month: "2026-10", page: 2 }),
      }),
    );
  });
});
