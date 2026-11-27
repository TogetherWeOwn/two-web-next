// route-inventory: GET /events/past
// Preserve the existing server-rendered row while its presentation changes.
import { html, parse } from "parse5";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import {
  ARCHIVE_NOW,
  ARCHIVE_ORIGIN,
  archiveReadFixture,
  archiveRow,
  compileArchiveKit,
  requestArchive,
} from "./helpers/past-archive-search-acceptance";

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
}, 60_000);
afterAll(() => kit?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Kit archive event row", () => {
  it.each(["", "Raid"])("keeps the title and archive link in SSR for query %j", async (q) => {
    const source = archiveReadFixture();
    source.replaceRows([archiveRow(701, { title: "Raid night", eventKey: "raid-night" })]);
    const path = `/events/past?${new URLSearchParams({ q })}`;
    const response = await requestArchive("Kit", path, source.env, kit);
    expect(response.status).toBe(200);
    const markup = await response.text();
    for (const scriptingEnabled of [true, false]) {
      const cards = elements(parse(markup, { scriptingEnabled })).filter(
        (node) =>
          node.namespaceURI === html.NS.HTML &&
          node.tagName === "li" &&
          attr(node, "data-event-key") === "raid-night",
      );
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      const nodes = elements(card);
      const links = nodes.filter((node) => node.tagName === "a");
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.namespaceURI).toBe(html.NS.HTML);
      expect(textOf(link).trim()).toBe("Raid night");
      const url = new URL(attr(link, "href")!, ARCHIVE_ORIGIN);
      expect(url.origin).toBe(ARCHIVE_ORIGIN);
      expect(url.pathname).toBe("/e/raid-night");
      expect(url.searchParams.get("archivePage")).toBe("1");
      expect(url.searchParams.get("archiveQuery")).toBe(q || null);
      const times = nodes.filter(
        (node) => node.namespaceURI === html.NS.HTML && node.tagName === "time",
      );
      expect(times.map((time) => attr(time, "datetime"))).toEqual(["2020-01-01T20:00:00.000Z"]);
      const glyphs = nodes.filter(
        (node) => node.namespaceURI === html.NS.SVG && node.tagName === "svg",
      );
      expect(glyphs.map((glyph) => attr(glyph, "aria-hidden"))).toEqual(["true"]);
      expect(textOf(card)).toContain("Sign-up record");
      const marks = elements(link).filter(
        (node) => node.namespaceURI === html.NS.HTML && node.tagName === "mark",
      );
      expect(marks).toHaveLength(q ? 1 : 0);
      if (q) expect(marks[0]!.childNodes).toMatchObject([{ nodeName: "#text", value: "Raid" }]);
    }
  });
});
