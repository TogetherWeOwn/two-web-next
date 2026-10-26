// route-inventory: GET /events
// Independent test-first contract. Only the SQL/network/framework boundaries are
// fixtures; both route adapters, the Kit endpoint, reads, model and renderer run.
import { parse } from "parse5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEEK_NOW,
  WEEK_ORIGIN,
  WEEK_TWINS,
  attr,
  calendarCells,
  calendarHeadings,
  effectiveWeek,
  elements,
  nativeFields,
  probeChoice,
  testElement,
  text,
  weekChoice,
  weekFixture,
  weekPath,
  weekRows,
} from "./helpers/calendar-week-start-acceptance";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(WEEK_NOW);
  vi.stubGlobal("fetch", () => {
    throw new Error("WEEK_EXTERNAL_FETCH: use local fixtures only");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// These ranges are hand-checked Gregorian fixtures, not production-helper output.
// January year 1 and December 9999 retain the supported overflow neighbour cells.
const geometry = [
  ["G01", "2026-11", "monday", "2026-10-26", "2026-12-06", 42, 30],
  ["G02", "2026-11", "sunday", "2026-11-01", "2026-12-05", 35, 30],
  ["G03", "2027-02", "monday", "2027-02-01", "2027-02-28", 28, 28],
  ["G04", "2027-02", "sunday", "2027-01-31", "2027-03-06", 35, 28],
  ["G05", "2028-02", "monday", "2028-01-31", "2028-03-05", 35, 29],
  ["G06", "2028-02", "sunday", "2028-01-30", "2028-03-04", 35, 29],
  ["G07", "0001-01", "monday", "0001-01-01", "0001-02-04", 35, 31],
  ["G08", "0001-01", "sunday", "0000-12-31", "0001-02-03", 35, 31],
  ["G09", "9999-12", "monday", "9999-11-29", "+010000-01-02", 35, 31],
  ["G10", "9999-12", "sunday", "9999-11-28", "+010000-01-01", 35, 31],
] as const;
const MONDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SUNDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

for (const twin of WEEK_TWINS)
  describe(`${twin} week-start acceptance`, () => {
    it("W01 native choice is labelled, allowlisted, GET-only and does not persist", async () => {
      const fixture = weekFixture();
      const response = await fixture.render(
        twin,
        "/events?view=calendar&month=2027-02&game=Chess&past=1",
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      const choice = weekChoice(html);
      expect(
        choice,
        "WEEK_CONTROL_MISSING: add a labelled native GET Monday/Sunday choice",
      ).not.toBeNull();
      expect(
        choice!.labelled,
        "WEEK_CONTROL_UNLABELLED: associate the native control with its label",
      ).toBe(true);
      expect(choice!.monday).not.toBe(choice!.sunday);
      const offered = elements(choice!.form!)
        .filter(
          (node) =>
            (node.tagName === "option" &&
              elements(choice!.form!, "select").some(
                (select) =>
                  attr(select, "name") === choice!.name &&
                  elements(select, "option").includes(node),
              )) ||
            (node.tagName === "input" &&
              attr(node, "type") === "radio" &&
              attr(node, "name") === choice!.name),
        )
        .filter((node) => attr(node, "disabled") === undefined);
      expect(offered.map((node) => attr(node, "value") ?? text(node)).sort()).toEqual(
        [choice!.monday, choice!.sunday].sort(),
      );
      expect(choice!.selected).toBe(choice!.monday);
      expect(choice!.form, "WEEK_GET_FORM_MISSING: retain the no-JS path").toBeDefined();
      expect((attr(choice!.form!, "method") ?? "get").toLowerCase()).toBe("get");
      expect(new URL(attr(choice!.form!, "action") ?? "/events", WEEK_ORIGIN).pathname).toBe(
        "/events",
      );
      const params = nativeFields(choice!.form!);
      params.set(choice!.name, choice!.sunday);
      expect(params.getAll(choice!.name)).toEqual([choice!.sunday]);
      const selected = await fixture.render(twin, `/events?${params}`);
      const selectedHtml = await selected.text();
      expect(calendarHeadings(selectedHtml)).toEqual(SUNDAY);
      expect(weekChoice(selectedHtml)?.selected).toBe(choice!.sunday);
      expect(
        new URL(
          attr(testElement(selectedHtml, "calendar-this-month"), "href")!,
          WEEK_ORIGIN,
        ).searchParams.get("game"),
      ).toBe("Chess");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(selected.headers.get("set-cookie")).toBeNull();
      expect(
        fixture.queries.filter((query) => /^(insert|update|delete)\b/i.test(query.sql)),
      ).toEqual([]);
    });

    for (const [id, month, start, first, last, count, inMonth] of geometry)
      it(`${id} ${start} ${month}: headings, cells, neighbours and today agree`, async () => {
        const fixture = weekFixture();
        const initial = await (
          await fixture.render(twin, `/events?view=calendar&month=${month}`)
        ).text();
        const choice = probeChoice(initial);
        const response = await fixture.render(
          twin,
          weekPath(`/events?view=calendar&month=${month}`, choice, start),
        );
        expect(response.status).toBe(200);
        if (twin === "Kit") expect(response.headers.get("x-two-renderer")).toBe("kit");
        const html = await response.text();
        const cells = calendarCells(html);
        expect(
          cells[0]?.date,
          "WEEK_GEOMETRY: rotate cells and read window, not headings alone",
        ).toBe(first);
        expect(cells.at(-1)?.date).toBe(last);
        expect(cells).toHaveLength(count);
        expect(cells.filter((cell) => !cell.outside)).toHaveLength(inMonth);
        expect(calendarHeadings(html)).toEqual(start === "monday" ? MONDAY : SUNDAY);
        for (let index = 1; index < cells.length; index++)
          expect(
            Date.parse(`${cells[index]!.date}T00:00:00Z`) -
              Date.parse(`${cells[index - 1]!.date}T00:00:00Z`),
          ).toBe(86_400_000);
        expect(cells.filter((cell) => cell.today).map((cell) => cell.date)).toEqual(
          month === "2026-11" ? ["2026-11-01"] : [],
        );
        expect(
          elements(testElement(html, "events-calendar-grid"), "th").every(
            (node) => attr(node, "scope") === "col",
          ),
        ).toBe(true);
      });

    it("C01 unchanged Monday route reads exactly once per scope and preserves continuation/list semantics", async () => {
      const fixture = weekFixture();
      const html = await (
        await fixture.render(twin, "/events?view=calendar&month=2027-02&game=Chess&past=1")
      ).text();
      expect(fixture.queries).toHaveLength(9);
      const month = fixture.queries.filter((query) => Number(query.params.at(-1)) === 200);
      expect(month).toHaveLength(1);
      expect(month[0]!.params.map(String)).toEqual(
        expect.arrayContaining(["2027-03-02T00:00:00.000Z", "2027-01-31T00:00:00.000Z"]),
      );
      expect(fixture.queries.every((query) => /^select\b/i.test(query.sql))).toBe(true);
      expect(
        calendarCells(html)
          .filter((cell) =>
            elements(cell.node, "a").some((link) =>
              (attr(link, "href") ?? "").includes(weekRows[0]!.eventKey),
            ),
          )
          .map((cell) => cell.date),
      ).toEqual(["2027-02-01", "2027-02-02"]);
      fixture.queries.length = 0;
      const list = await (await fixture.render(twin, "/events")).text();
      expect(fixture.queries).toHaveLength(6);
      expect(
        elements(parse(list))
          .filter((node) => attr(node, "data-testid") === "event-card")
          .map((node) => attr(node, "id")),
      ).toEqual([1, 2, 6, 3, 4, 5].map((id) => `event-${weekRows[id - 1]!.eventKey}`));
    });

    it("C02 locale and a similarly named cookie never choose the default layout", async () => {
      const fixture = weekFixture();
      const base = "/events?view=calendar&month=2027-02";
      const choice = probeChoice(await (await fixture.render(twin, base)).text());
      const response = await fixture.render(twin, base, false, false, {
        "accept-language": "en-US,en;q=0.9",
        cookie: `${choice.name}=${encodeURIComponent(choice.sunday)}`,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(calendarHeadings(html)).toEqual(MONDAY);
      expect(calendarCells(html)[0]?.date).toBe("2027-02-01");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("W02 absent, duplicate and invalid choices normalize to Monday on full and fragment reads", async () => {
      const fixture = weekFixture();
      const base = "/events?view=calendar&month=2027-02&game=Chess&past=1";
      const choice = probeChoice(await (await fixture.render(twin, base)).text());
      const invalid = ["", "Sunday", "sunday-first-invalid", " sunday ", "<script>"]
        .filter((value) => value !== choice.monday && value !== choice.sunday)
        .map((value) => [value]);
      for (const values of [
        [],
        ...invalid,
        [choice.sunday, choice.monday],
        [choice.monday, choice.sunday],
        [choice.sunday, choice.sunday],
      ]) {
        const url = new URL(base, WEEK_ORIGIN);
        for (const value of values) url.searchParams.append(choice.name, value);
        for (const island of [false, true]) {
          const response = await fixture.render(twin, url.pathname + url.search, island);
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(calendarCells(html)[0]?.date).toBe("2027-02-01");
          expect(calendarHeadings(html)).toEqual(MONDAY);
          const nav = elements(parse(html), "a").filter((node) =>
            ["Previous month", "Next month"].includes(attr(node, "aria-label") ?? ""),
          );
          expect(nav).toHaveLength(2);
          for (const link of nav)
            expect(effectiveWeek(attr(link, "href")!, choice)).toBe(choice.monday);
        }
      }
    });

    for (const island of [false, true])
      it(`W03 fragment=${island}: Sunday SQL window, spillovers and continuations share one bounded read`, async () => {
        const fixture = weekFixture();
        const base = "/events?view=calendar&month=2027-02&game=Chess&past=1";
        const choice = probeChoice(await (await fixture.render(twin, base)).text());
        fixture.queries.length = 0;
        const beforeDiscord = fixture.discordCalls;
        const response = await fixture.render(twin, weekPath(base, choice, "sunday"), island);
        const html = await response.text();
        const monthReads = fixture.queries.filter((query) => Number(query.params.at(-1)) === 200);
        expect(
          monthReads,
          "WEEK_QUERY_COUNT: use the existing month read, not a second rowset",
        ).toHaveLength(1);
        const read = monthReads[0]!;
        expect(
          read.params.map(String),
          "WEEK_SQL_WINDOW: widen from the selected Sunday grid",
        ).toEqual(expect.arrayContaining(["2027-03-08T00:00:00.000Z", "2027-01-30T00:00:00.000Z"]));
        expect(read.sql).toMatch(/"starts_at" < \$\d+/);
        expect(read.sql).toMatch(/"ends_at" > \$\d+/);
        expect(fixture.queries).toHaveLength(9);
        expect(fixture.discordCalls - beforeDiscord).toBe(1);
        expect(fixture.queries.every((query) => /^select\b/i.test(query.sql))).toBe(true);
        const cells = calendarCells(html);
        const occupied = (id: number) =>
          cells
            .filter((cell) =>
              elements(cell.node, "a").some((node) =>
                (attr(node, "href") ?? "").includes(weekRows[id - 1]!.eventKey),
              ),
            )
            .map((cell) => cell.date);
        expect(occupied(1)).toEqual(["2027-01-31", "2027-02-01", "2027-02-02"]);
        expect(occupied(2)).toEqual(["2027-01-31"]);
        expect(occupied(3)).toEqual(["2027-02-14", "2027-02-15"]);
        expect(occupied(4)).toEqual(["2027-03-06"]);
        expect(occupied(5)).toEqual([]);
        expect(occupied(6)).toEqual([]); // unrelated game must not fill the new cells
        const continuation = cells.find((cell) => cell.date === "2027-02-15")!;
        const link = elements(continuation.node, "a").find((node) =>
          (attr(node, "href") ?? "").includes(weekRows[2]!.eventKey),
        )!;
        expect(text(link)).toMatch(/^Continues /);
        expect(attr(link, "aria-label")).toContain(weekRows[2]!.title);
        expect(attr(link, "aria-label")).toMatch(/15 February 2027/);
        expect(effectiveWeek(attr(link, "href")!, choice)).toBe(choice.sunday);
      });

    it("W04 month/native form/view/game/past links carry the committed choice; canonical and feeds do not", async () => {
      const fixture = weekFixture();
      const base = "/events?view=calendar&month=2027-02&game=Chess&past=1";
      const choice = probeChoice(await (await fixture.render(twin, base)).text());
      const html = await (await fixture.render(twin, weekPath(base, choice, "sunday"))).text();
      const doc = parse(html);
      for (const link of elements(doc, "a").filter(
        (node) =>
          ["Previous month", "Next month"].includes(attr(node, "aria-label") ?? "") ||
          ["calendar-this-month", "events-view-list"].includes(attr(node, "data-testid") ?? ""),
      )) {
        const href = attr(link, "href")!;
        expect(effectiveWeek(href, choice), "WEEK_LINK_STATE: keep layout through navigation").toBe(
          choice.sunday,
        );
        expect(new URL(href, WEEK_ORIGIN).searchParams.get("game")).toBe("Chess");
        expect(new URL(href, WEEK_ORIGIN).searchParams.get("past")).toBe("1");
      }
      const jump = nativeFields(testElement(html, "calendar-month-jump"));
      expect(jump.getAll(choice.name)).toEqual([choice.sunday]);
      jump.set("month", "2028-02");
      const jumped = await (await fixture.render(twin, `/events?${jump}`)).text();
      expect(calendarCells(jumped)[0]?.date).toBe("2028-01-30");
      const search = elements(doc, "form").find((form) =>
        elements(form, "select").some((node) => attr(node, "name") === "game"),
      )!;
      const fields = nativeFields(search);
      expect(fields.getAll(choice.name)).toEqual([choice.sunday]);
      fields.set("game", "Go");
      const filtered = await (await fixture.render(twin, `/events?${fields}`)).text();
      expect(calendarHeadings(filtered)).toEqual(SUNDAY);
      expect(
        calendarCells(filtered).some((cell) =>
          elements(cell.node, "a").some((link) =>
            (attr(link, "aria-label") ?? "").includes(weekRows[5]!.title),
          ),
        ),
      ).toBe(true);
      const canonical = elements(doc, "link").find((node) => attr(node, "rel") === "canonical")!;
      expect(attr(canonical, "href")).toBe(`${WEEK_ORIGIN}/events`);
      const feeds = elements(doc, "a").filter((node) =>
        (attr(node, "href") ?? "").includes("/events.ics"),
      );
      expect(feeds.length).toBeGreaterThan(0);
      for (const feed of feeds) {
        const url = new URL(attr(feed, "href")!, WEEK_ORIGIN);
        expect(url.searchParams.has(choice.name)).toBe(false);
        expect(url.searchParams.get("game")).toBe("Chess");
      }
    });

    it("W05 list order/count and search-forces-list survive either layout without a grid read", async () => {
      const fixture = weekFixture();
      const choice = probeChoice(
        await (await fixture.render(twin, "/events?view=calendar&month=2027-02")).text(),
      );
      const orders: string[][] = [];
      for (const start of ["monday", "sunday"] as const) {
        fixture.queries.length = 0;
        const html = await (await fixture.render(twin, weekPath("/events", choice, start))).text();
        orders.push(
          elements(parse(html))
            .filter((node) => attr(node, "data-testid") === "event-card")
            .map((node) => attr(node, "id")!),
        );
        expect(fixture.queries).toHaveLength(6);
        expect(fixture.queries.filter((query) => Number(query.params.at(-1)) === 200)).toEqual([]);
        const toggle = testElement(html, "events-view-calendar");
        expect(effectiveWeek(attr(toggle, "href")!, choice)).toBe(choice[start]);
      }
      expect(orders[0]).toEqual(
        [1, 2, 6, 3, 4, 5].map((id) => `event-${weekRows[id - 1]!.eventKey}`),
      );
      expect(orders[1]).toEqual(orders[0]);
      fixture.queries.length = 0;
      const result = await (
        await fixture.render(
          twin,
          weekPath("/events?view=calendar&month=2027-02&q=fixture", choice, "sunday"),
        )
      ).text();
      expect(attr(testElement(result, "events-calendar"), "data-view")).toBe("list");
      expect(
        elements(parse(result), "table").filter(
          (node) => attr(node, "data-testid") === "events-calendar-grid",
        ),
      ).toEqual([]);
      expect(fixture.queries.filter((query) => Number(query.params.at(-1)) === 200)).toEqual([]);
      for (const link of elements(parse(result), "a").filter((node) =>
        (attr(node, "href") ?? "").startsWith("/e/"),
      ))
        expect(new URL(attr(link, "href")!, WEEK_ORIGIN).searchParams.has(choice.name)).toBe(false);
    });
  });
