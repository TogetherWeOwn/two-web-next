import { beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { GAME_TWINS, gameRecoveryFixture, gameRow } from "./helpers/calendar-game-recovery";
import { EventsCalendarPage } from "../src/events/pages-calendar";
import type { CalRow } from "../src/events/pages-calendar-row";
import {
  attribute,
  document,
  elements,
  lateSearchDescription,
  passage,
  scheduleSearchEvent,
  scheduleSearchNow,
  tag,
  testId,
  text,
} from "./helpers/schedule-search-context-acceptance";

function render(q: string, upcoming: CalRow[] = [scheduleSearchEvent()]) {
  return document(
    String(
      EventsCalendarPage({
        state: { view: "list", month: "2035-06", q, game: "Tabletop", past: false, page: 1 },
        upcoming,
        past: [],
        zone: "UTC",
        now: scheduleSearchNow,
        totalPages: 2,
        emptyState: null,
        discordFailed: false,
        games: ["Tabletop", "Other game"],
        gameFilter: "Tabletop",
        member: false,
        inviteUrl: "https://example.com/invite",
        appUrl: "https://example.com",
        loginReturnTo: "/events?q=needle&game=Tabletop",
      }),
    ),
  );
}

function firstCard(q: string, row = scheduleSearchEvent()) {
  return testId(render(q, [row]), "event-card")[0]!;
}

// Breaks caught: lost query plumbing; first-240-only clipping; regex/wildcard
// interpretation; unsafe HTML insertion; presentation re-filtering SQL rows.
// Expectations below are literal, not computed with searchContext itself.
describe("upcoming schedule literal match explanations", () => {
  it("marks each locatable title match without truncating the native detail link", () => {
    const title = `${"A long evening ".repeat(10)}NEEDLE, needle and friends`;
    const card = firstCard("needle", scheduleSearchEvent({ title, description: "Bring snacks." }));
    const heading = tag(card, "h3")[0]!;
    const link = tag(heading, "a")[0]!;
    expect(text(link)).toBe(title);
    expect(attribute(link, "href")).toBe("/e/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(tag(heading, "mark").map(text)).toEqual(["NEEDLE", "needle"]);
    expect(tag(passage(card), "mark")).toHaveLength(0);
    expect(tag(card, "details")).toHaveLength(0);
  });

  it("shows one bounded late matching passage while retaining the entire native disclosure", () => {
    const card = firstCard("needle");
    const excerpt = passage(card);
    expect(text(excerpt)).toContain("Bring your NEEDLE deck; another needle deck is welcome.");
    expect(tag(excerpt, "mark").map(text)).toEqual(["NEEDLE", "needle"]);
    expect([...text(excerpt)].length).toBeLessThanOrEqual(320);
    expect(text(excerpt).startsWith("…")).toBe(true);
    const details = tag(card, "details");
    expect(details).toHaveLength(1);
    expect(tag(details[0]!, "summary")).toHaveLength(1);
    expect(text(tag(details[0]!, "summary")[0]!)).toContain("Full description");
    expect(text(tag(details[0]!, "p")[0]!)).toBe(lateSearchDescription);
  });

  it.each([
    {
      q: "%",
      title: "100% casual",
      description: "100% casual, not 100X casual",
      marks: ["%"],
    },
    { q: "_", title: "co_op", description: "co_op, not co-op", marks: ["_"] },
    { q: "\\", title: "path\\night", description: "path\\night, not path/night", marks: ["\\"] },
    { q: ".*", title: "literal .* night", description: "literal .* only", marks: [".*"] },
    { q: "[", title: "literal [ night", description: "literal [ only", marks: ["["] },
    { q: "é", title: "café night", description: "café, not café", marks: ["é"] },
    {
      q: "🧩",
      title: "🧩 night",
      description: `${"🌱".repeat(400)}🧩${"🌻".repeat(400)}`,
      marks: ["🧩"],
    },
  ])("keeps $q literal in titles and description passages", ({ q, title, description, marks }) => {
    const card = firstCard(q, scheduleSearchEvent({ title, description }));
    expect(text(tag(card, "h3")[0]!)).toBe(title);
    expect(tag(tag(card, "h3")[0]!, "mark").map(text)).toEqual([q]);
    expect(tag(passage(card), "mark").map(text)).toEqual(marks);
    expect([...text(passage(card))].length).toBeLessThanOrEqual(320);
    expect(text(passage(card))).not.toContain("�");
  });

  it("escapes hostile title, query and description text rather than creating markup", () => {
    const q = "<svg/onload=alert(1)>";
    const title = `Play ${q} & chat`;
    const description = `A literal ${q} is not an element.`;
    const card = firstCard(q, scheduleSearchEvent({ title, description }));
    expect(text(tag(card, "h3")[0]!)).toBe(title);
    expect(text(passage(card))).toBe(description);
    expect(tag(card, "mark").map(text)).toEqual([q, q]);
    expect(elements(card, (element) => ["svg", "script", "img"].includes(element.tagName))).toEqual(
      [],
    );
    expect(
      elements(card, (element) => element.attrs.some((attr) => attr.name.startsWith("on"))),
    ).toEqual([]);
  });

  it.each([
    { q: "i", title: "İ", description: `İ${" No match here.".repeat(50)}` },
    { q: "οσ", title: "ΟΣ", description: `ΟΣ${" No match here.".repeat(50)}` },
    { q: "café", title: "café", description: `café${" No match here.".repeat(50)}` },
  ])(
    "retains an admitted SQL row when $q has no faithful JavaScript span",
    ({ q, title, description }) => {
      const page = render(q, [scheduleSearchEvent({ title, description })]);
      const cards = testId(page, "event-card");
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(text(tag(card, "h3")[0]!)).toBe(title);
      expect(tag(card, "mark")).toHaveLength(0);
      const excerpt = text(passage(card));
      expect(excerpt.length).toBeGreaterThan(0);
      expect([...excerpt].length).toBeLessThanOrEqual(320);
      expect(excerpt.replace(/…$/u, "")).toBe(
        description.slice(0, excerpt.replace(/…$/u, "").length),
      );
      expect(text(tag(tag(card, "details")[0]!, "p")[0]!)).toBe(description);
      expect(testId(page, "events-empty-search")).toHaveLength(0);
    },
  );

  it.each(["", "   \t\n"])("retains the ordinary compact card for blank query %j", (q) => {
    const card = firstCard(q);
    expect(tag(card, "mark")).toHaveLength(0);
    expect(text(passage(card))).toBe(`${[...lateSearchDescription].slice(0, 240).join("")}…`);
    expect(text(tag(tag(card, "details")[0]!, "p")[0]!)).toBe(lateSearchDescription);
  });

  it("preserves source row order, cancelled and transient action semantics, facet and paging", () => {
    const cancelled = scheduleSearchEvent({
      id: 2,
      eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      title: "Cancelled NEEDLE night",
      status: "cancelled",
    });
    const page = render("needle", [
      cancelled,
      {
        discordId: "123456789012345678",
        status: "scheduled",
        title: "Discord needle night",
        description: "Bring a needle deck.",
        location: "Discord",
        startsAt: new Date("2035-06-05T18:00:00Z"),
        endsAt: null,
      },
      scheduleSearchEvent({ title: "NEEDLE social" }),
    ]);
    const cards = testId(page, "event-card");
    expect(cards.map((card) => attribute(card, "data-event-key"))).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "discord-123456789012345678",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]);
    expect(text(tag(cards[0]!, "h3")[0]!)).toBe("Cancelled NEEDLE night");
    expect.soft(tag(tag(cards[0]!, "h3")[0]!, "mark").map(text)).toEqual(["NEEDLE"]);
    expect(tag(tag(cards[0]!, "h3")[0]!, "a")).toHaveLength(0);
    expect(testId(cards[0]!, "signin")).toHaveLength(0);
    expect(text(testId(cards[0]!, "event-going-count")[0]!)).toContain("existing responses");
    expect.soft(tag(tag(cards[1]!, "h3")[0]!, "mark").map(text)).toEqual(["needle"]);
    expect.soft(tag(passage(cards[1]!), "mark").map(text)).toEqual(["needle"]);
    expect(tag(tag(cards[1]!, "h3")[0]!, "a")).toHaveLength(0);
    expect(testId(cards[1]!, "event-going-count")).toHaveLength(0);
    expect(tag(cards[1]!, "a").some((link) => text(link) === "RSVP in Discord")).toBe(true);
    expect.soft(tag(cards[2]!, "mark").length).toBeGreaterThan(0);
    const next = testId(page, "events-pager-next")[0]!;
    const url = new URL(attribute(next, "href")!, "https://example.com");
    expect(url.searchParams.get("q")).toBe("needle");
    expect(url.searchParams.get("game")).toBe("Tabletop");
    expect(url.searchParams.get("page")).toBe("2");
  });
});

for (const twin of GAME_TWINS) {
  describe(`${twin} schedule search-context route boundary`, () => {
    beforeEach(() => __resetAnonEventCacheForTests());

    for (const island of [false, true]) {
      it(`uses effective normalized text for ${island ? "fragment" : "full-page"} results`, async () => {
        const fixture = gameRecoveryFixture({
          upcomingRows: [
            { ...gameRow(1, "Chess"), title: "NEEDLE night", description: lateSearchDescription },
          ],
          pastRows: [],
        });
        const query = new URLSearchParams({
          q: "  \0NEEDLE\0  ",
          game: " chess ",
          view: "calendar",
        });
        const response = await fixture.render(twin, `/events?${query}`, island);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("private");
        const page = document(await response.text());
        const cards = testId(page, "event-card");
        expect(cards).toHaveLength(1);
        expect.soft(tag(tag(cards[0]!, "h3")[0]!, "mark").map(text)).toEqual(["NEEDLE"]);
        expect.soft(tag(passage(cards[0]!), "mark").map(text)).toEqual(["NEEDLE", "needle"]);
        expect(attribute(testId(page, "events-calendar")[0]!, "data-view")).toBe("list");
        const selected = elements(
          page,
          (element) => element.tagName === "option" && attribute(element, "selected") !== undefined,
        );
        expect(selected.map(text)).toContain("Chess");
        const searchReads = fixture.queries.filter(({ sql }) => /\bilike\b/i.test(sql));
        expect(searchReads.length).toBeGreaterThan(0);
        expect(searchReads.every(({ params }) => params.includes("%NEEDLE%"))).toBe(true);
        expect(searchReads.every(({ params }) => params.includes("chess"))).toBe(true);
        expect(fixture.discordCalls).toHaveLength(1);
      });
    }

    it("CONTROL keeps literal filter SQL, classified read count and sources unchanged", async () => {
      const fixture = gameRecoveryFixture({
        upcomingRows: [{ ...gameRow(1, "Chess"), title: "Literal %_\\ night" }],
        pastRows: [],
      });
      const path = `/events?${new URLSearchParams({ q: "%_\\", game: "Chess" })}`;
      const response = await fixture.render(twin, path);
      expect(response.status).toBe(200);
      const page = document(await response.text());
      expect(testId(page, "event-card")).toHaveLength(1);
      const searches = fixture.queries.filter(({ sql }) => /\bilike\b/i.test(sql));
      expect(searches).toHaveLength(3);
      for (const read of searches) {
        expect(read.sql).toMatch(
          /"events"\."title" ilike \$\d+ or "events"\."description" ilike \$\d+/i,
        );
        expect(read.params.filter((p) => typeof p === "string" && p.startsWith("%"))).toEqual([
          "%\\%\\_\\\\%",
          "%\\%\\_\\\\%",
        ]);
      }
      expect(fixture.queries.filter(({ sql }) => sql.includes('from "events"'))).toHaveLength(4);
      expect(fixture.queries.filter(({ sql }) => sql.includes('from "rsvps"'))).toHaveLength(1);
      expect(fixture.discordCalls).toHaveLength(1);
    });
  });
}
