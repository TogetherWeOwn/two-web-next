import { jsx } from "hono/jsx/jsx-runtime";
import { defaultTreeAdapter, parseFragment, serialize } from "parse5";
import { expect, it } from "vitest";
import { MonthGrid } from "../src/events/pages-calendar-grid";
import { monthGrid } from "../src/islands/contracts";

it("keeps the month table inside the focusable region after the jump form", async () => {
  const html = await jsx(MonthGrid, {
    state: { view: "calendar", month: "2030-01", q: "", game: "", past: false, page: 1 },
    weeks: monthGrid<never>("2030-01", "2030-01-15", new Map()),
    zone: "UTC",
    now: new Date("2030-01-15T12:00:00Z"),
  }).toString();

  const { isElementNode } = defaultTreeAdapter;
  const [calendar] = parseFragment(html).childNodes.filter(isElementNode);
  const siblings = calendar!.childNodes.filter(isElementNode);
  expect(siblings.map((node) => node.tagName)).toEqual(["p", "form", "div"]);
  expect(siblings[1]!.attrs).toContainEqual({ name: "data-testid", value: "calendar-month-jump" });

  const region = siblings[2]!;
  expect(Object.fromEntries(region.attrs.map(({ name, value }) => [name, value]))).toMatchObject({
    role: "region",
    "aria-label": "Events calendar; scroll horizontally to see all days",
    tabindex: "0",
    "data-testid": "events-calendar-scroll",
  });

  const tables = region.childNodes.filter(isElementNode);
  expect(tables.map((node) => node.tagName)).toEqual(["table"]);
  const table = tables[0]!;
  expect(table.attrs).toContainEqual({ name: "data-testid", value: "events-calendar-grid" });
  const parts = table.childNodes.filter(isElementNode);
  expect(parts.map((node) => node.tagName)).toEqual(["caption", "thead", "tbody"]);
  expect(serialize(parts[0]!)).toBe("January 2030");
});
