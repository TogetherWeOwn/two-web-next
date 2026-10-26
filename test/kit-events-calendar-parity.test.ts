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
import { describe, expect, it, vi } from "vitest";
import { loadEventsPage } from "../src/kit-events";
import {
  fixtureState,
  renderedElements,
  sharedSearch,
  sharingData,
  sharingHtml,
  viewLabel,
} from "./schedule-sharing.fixtures";
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

// Walk the serialized tags with a depth counter so a stable element moved
// inside any data-cal-zone fails, not just a missing testid.
function assertStableOutsideZones(body: string, markers: string[]): void {
  const tagRe = /<[^>]+>/g;
  const stack: boolean[] = [];
  const violations: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const tag = match[0];
    if (tag.startsWith("<!--") || tag.startsWith("<!") || tag.startsWith("<?")) continue;
    const isClosing = tag.startsWith("</");
    if (isClosing) {
      stack.pop();
      continue;
    }
    const name =
      tag
        .slice(1)
        .split(/[\s/>]/, 1)[0]
        ?.toLowerCase() ?? "";
    const isSelfClosing = tag.endsWith("/>") || VOID_ELEMENTS.has(name);
    const insideZone = stack.some(Boolean);
    if (insideZone) {
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

function zoneNames(body: string): string[] {
  return [...body.matchAll(/data-cal-zone="([^"]+)"/g)].map((m) => m[1] as string).sort();
}

const headers = {
  "cache-control": "public, max-age=60",
  vary: "Cookie, X-Two-Island",
  "x-two-events-cacheable": "true",
};

describe("Kit calendar island mount parity", () => {
  it("carries every data hook the fragment binder reads", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);

    // Mount identity the binder queries before doing anything.
    expect(rendered.body).toContain('data-island="events-calendar"');
    expect(rendered.body).toContain(`data-testid="${EVENTS_CALENDAR_TESTID}"`);
    expect(rendered.body).toContain('data-view="list"');
    expect(rendered.body).toContain('data-month="2026-10"');
    // Over-limit naming and failure copy come from data, never from the query.
    expect(rendered.body).toContain(`data-search-max-length="${EVENTS_SEARCH_MAX_LENGTH}"`);
    expect(rendered.body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    // The failure copy rides in an attribute, so the apostrophe is HTML-escaped.
    expect(rendered.body).toContain("data-load-error=");
    expect(rendered.body).toContain("refresh the events — try again.");
    // Stable zones: head/actions/miss/content/subscribe swap, everything else persists.
    for (const zone of ["head", "actions", "miss", "content", "subscribe"]) {
      expect(rendered.body).toContain(`data-cal-zone="${zone}"`);
    }
    expect(zoneNames(rendered.body)).toEqual(["actions", "content", "head", "miss", "subscribe"]);
    expect(rendered.body).toContain("data-cal-feedback");
    // A real row renders the list card instead of the out-of-range note.
    expect(rendered.body).toContain(`data-testid="${EVENT_CARD_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
    expect(rendered.body).not.toContain(`data-testid="${EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${EVENTS_CONTENT_TESTID}"`);
    // Skeleton stays hidden until a member-started action shows it.
    expect(rendered.body).toContain(`data-testid="${EVENTS_LOADING_TESTID}"`);
    expect(rendered.body).toMatch(
      new RegExp(`data-testid="${EVENTS_LOADING_TESTID}"[^>]*\\shidden`),
    );
    // Live regions stay outside the swapped zones so they are never re-created.
    for (const testid of [
      EVENTS_VIEW_STATUS_TESTID,
      EVENTS_SEARCH_STATUS_TESTID,
      EVENTS_PAST_STATUS_TESTID,
      CALENDAR_MONTH_STATUS_TESTID,
    ]) {
      expect(rendered.body).toContain(`data-testid="${testid}"`);
    }
    assertStableOutsideZones(rendered.body, [
      `data-testid="${EVENTS_VIEW_STATUS_TESTID}"`,
      `data-testid="${EVENTS_SEARCH_STATUS_TESTID}"`,
      `data-testid="${EVENTS_PAST_STATUS_TESTID}"`,
      `data-testid="${CALENDAR_MONTH_STATUS_TESTID}"`,
      `data-testid="${EVENTS_SEARCH_TESTID}"`,
      `data-testid="${EVENTS_LOADING_TESTID}"`,
      EVENTS_CAL_FEEDBACK,
    ]);
    // The binder itself: one deferred external script, the no-global-hydration deal.
    expect(rendered.body).toContain('<script src="/islands/events-calendar.js"');
    expect(rendered.body).toContain("defer");
  });

  it("renders the month grid with real prev/next and day-cell anchors", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "calendar", month: "2026-10", q: "", past: false, page: 1 },
      } as never,
      headers,
    );

    expect(rendered.body).toContain(`data-testid="${EVENTS_CALENDAR_GRID_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${CALENDAR_MONTH_TESTID}"`);
    expect(rendered.body).toContain(calendarMonthLabel("2026-10"));
    expect(rendered.body).toContain(`aria-label="${CALENDAR_PREV_LABEL}"`);
    expect(rendered.body).toContain(`aria-label="${CALENDAR_NEXT_LABEL}"`);
    // Month steps share the list's URL model: view + month params only.
    expect(rendered.body).toContain('href="/events?view=calendar&amp;month=2026-09"');
    expect(rendered.body).toContain('href="/events?view=calendar&amp;month=2026-11"');
    for (const day of WEEKDAY_HEADINGS) {
      expect(rendered.body).toContain(`<th scope="col">${day}</th>`);
    }
    // The fixture row lands in-month, so day cells carry real jump anchors.
    expect(rendered.body).toContain(`data-testid="${CALENDAR_DAY_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${CALENDAR_MONTH_STATUS_TESTID}"`);
    expect(rendered.body).toContain("data-cal-jump");
    expect(rendered.body).toContain("Game night parity");
  });

  it("keeps search a GET form with real anchors so no-JS stays functional", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "list", month: "2026-10", q: "chess", past: false, page: 1 },
      } as never,
      { ...headers, "cache-control": "private, no-store" },
    );

    expect(rendered.body).toContain('<form method="get" action="/events"');
    expect(rendered.body).toContain(`data-testid="${EVENTS_SEARCH_TESTID}"`);
    expect(rendered.body).toContain('name="q"');
    expect(rendered.body).toContain('type="submit"');
    // A settled search names its hit line and offers a real clear navigation.
    // The shared fixture carries a visible row, so this exercises the hit
    // branch (hasVisibleResults) rather than the out-of-range branch.
    expect(rendered.body).toContain(eventsSearchHitCopy("chess"));
    expect(rendered.body).toContain(`data-testid="${EVENT_CARD_TESTID}"`);
    expect(rendered.body).not.toContain(`data-testid="${EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${EVENTS_VIEW_LIST_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${EVENTS_VIEW_CALENDAR_TESTID}"`);
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

    expect(rendered.body).toContain("Nothing matches that search.");
    expect(rendered.body).toContain(`data-testid="${EVENTS_EMPTY_SEARCH_TESTID}"`);
    expect(rendered.body).toContain(`data-testid="${EVENTS_SEARCH_CLEAR_EMPTY_TESTID}"`);
  });

  it("keeps skip-link, main and heading focus targets for keyboard users", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);

    expect(rendered.body).toContain('class="skip-link"');
    expect(rendered.body).toContain('href="#main"');
    expect(rendered.body).toContain('id="main"');
    expect(rendered.body).toContain('id="events-heading"');
    expect(rendered.body).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
  });

  it("emits no inline scripts or handlers, keeping script-src 'self' intact", async () => {
    const rendered = await renderEventsHtml({ ...baseData() } as never, headers);

    expect(rendered.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(rendered.body).not.toMatch(/\son(click|load|error|input|submit|change|keydown)=/i);
    expect(rendered.body).not.toContain("application/ld+json");
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

// Catches sharing location.href, the feed URL, or an unnormalized model instead
// of the committed public schedule. The literals are independent URL oracles.
describe.each(["hono", "kit"] as const)("%s committed schedule sharing SSR", (target) => {
  it.each([
    { path: "/events", want: "/events" },
    { path: "/events?q=+++&game=+++", want: "/events" },
    { path: sharedSearch, want: sharedSearch },
    {
      path: "/events?game=Catan+%26+Co&past=1&view=calendar&month=2030-12&page=3",
      want: "/events?game=Catan+%26+Co&past=1&view=calendar&month=2030-12",
    },
  ])(
    "offers the normalized view $want and an associated readonly native fallback",
    async ({ path, want }) => {
      const body = await sharingHtml(
        target,
        fixtureState(new URL(path, "https://untrusted.example.test")),
        "https://public.example.test///",
      );
      const nodes = renderedElements(body);
      const action = nodes.filter((n) => ["a", "button"].includes(n.tag) && n.text === viewLabel);
      expect(
        action,
        "one labelled schedule-copy action, not the existing feed button",
      ).toHaveLength(1);
      expect(action[0]?.attrs["data-copy-link"]).toBe("https://public.example.test" + want);
      const fields = nodes.filter(
        (n) =>
          ["input", "textarea"].includes(n.tag) &&
          (n.attrs.value ?? n.text) === "https://public.example.test" + want,
      );
      expect(
        fields,
        "the committed value remains natively selectable without JavaScript",
      ).toHaveLength(1);
      const field = fields[0]!;
      expect(field.attrs).toHaveProperty("readonly");
      expect(field.attrs).not.toHaveProperty("disabled");
      expect(field.attrs).not.toHaveProperty("hidden");
      expect(field.attrs["aria-hidden"]).not.toBe("true");
      expect(
        nodes.some(
          (n) =>
            n.tag === "label" && n.attrs.for === field.attrs.id && /schedule|view/i.test(n.text),
        ),
      ).toBe(true);
      expect(
        nodes.filter((n) => n.tag === "script" && n.attrs.src === "/islands/copy-link.js"),
      ).toHaveLength(1);
    },
  );

  it("CONTROL: retains canonical, scoped subscription, export and feed bytes", async () => {
    const nodes = renderedElements(
      await sharingHtml(
        target,
        fixtureState(new URL(sharedSearch, "https://public.example.test")),
        "https://public.example.test",
      ),
    );
    expect(nodes.find((n) => n.tag === "link" && n.attrs.rel === "canonical")?.attrs.href).toBe(
      "https://public.example.test/events",
    );
    expect(
      nodes.find((n) => n.attrs["data-copy-feed"] !== undefined)?.attrs["data-copy-link"],
    ).toBe("https://public.example.test/events.ics?game=Catan+%26+Co");
    expect(
      nodes.find((n) => n.tag === "a" && n.text === "Download calendar (.ics)")?.attrs.href,
    ).toBe("https://public.example.test/events.ics?game=Catan+%26+Co");
    expect(
      nodes.some(
        (n) =>
          n.tag === "a" &&
          n.attrs.href === "webcal://public.example.test/events.ics?game=Catan+%26+Co",
      ),
    ).toBe(true);
  });
});

describe("schedule sharing request isolation", () => {
  it("ignores request host, tracking, token, member and hash input without another model read", async () => {
    const state = {
      view: "list" as const,
      month: "2030-11",
      q: "",
      game: "Catan",
      past: true,
      page: 2,
    };
    const modelForFn = vi.fn(async () => sharingData(state, "https://public.example.test"));
    const dbForFn = vi.fn(async () => ({}) as never);
    const requestUrl =
      "https://untrusted.example.test/events?game=Catan&past=1&page=2&utm_source=tracking&token=not-a-secret&member=private-context#unsent";
    const data = await loadEventsPage({
      env: { APP_URL: "https://public.example.test///" } as never,
      url: new URL(requestUrl),
      request: new Request(requestUrl),
      method: "GET",
      island: false,
      setHeaders: vi.fn(),
      deleteJoinCookie: vi.fn(),
      dbForFn,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });
    const nodes = renderedElements((await renderEventsHtml(data, {})).body);
    const action = nodes.find((n) => ["button", "a"].includes(n.tag) && n.text === viewLabel);
    expect(action?.attrs["data-copy-link"]).toBe(
      "https://public.example.test/events?game=Catan&past=1&page=2",
    );
    expect(dbForFn).toHaveBeenCalledTimes(1);
    expect(modelForFn).toHaveBeenCalledTimes(1);
  });
});
