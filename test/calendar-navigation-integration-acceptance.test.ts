import { beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  attribute,
  elements,
  firstPageName,
  hidePastName,
  lastPageName,
  links,
  navigationRouteFixture,
  params,
} from "./helpers/calendar-navigation-acceptance";

beforeEach(() => __resetAnonEventCacheForTests());
const cardKeys = (html: string) =>
  elements(html, "article")
    .filter((node) => attribute(node, "data-testid") === "event-card")
    .map((node) => attribute(node, "data-event-key"))
    .filter((key) => key?.startsWith("navigation-"));

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: actual calendar navigation pipeline`, () => {
    it("CONTROL: bounds reads and cards across all three pages without changing order or game scope", async () => {
      const fixture = navigationRouteFixture();
      const keys: (string | undefined)[] = [];
      for (const [index, [page, size]] of [
        [1, 20],
        [2, 20],
        [3, 5],
      ].entries()) {
        const before = fixture.queries.length;
        const response = await fixture.request(twin, `/events?game=Chess&page=${page}`, true);
        expect(response.status).toBe(200);
        const html = await response.text();
        const visible = cardKeys(html);
        expect(visible).toHaveLength(size!);
        keys.push(...visible);
        const queries = fixture.queries.slice(before);
        // Hono serves the facet list from its isolate cache after the first
        // page; Kit re-reads it per page.
        const gamesReads = twin === "Hono" && index > 0 ? 0 : 1;
        expect(queries).toHaveLength(5 + gamesReads);
        expect(queries.every((query) => /^select\b/i.test(query.sql))).toBe(true);
        expect(queries.filter((query) => /select\s+distinct/i.test(query.sql))).toHaveLength(
          gamesReads,
        );
        const reads = queries.filter(
          (query) =>
            query.sql.includes('from "events"') &&
            !/^select count|select\s+distinct/i.test(query.sql),
        );
        expect(
          reads
            .map((read) => read.params.at(read.sql.includes(" offset ") ? -2 : -1))
            .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([20, 21]);
      }
      expect(keys).toEqual(Array.from({ length: 45 }, (_, i) => `navigation-${i + 1}`));
    });

    it("CONTROL: repeated anonymous navigation screens retain existing cache isolation", async () => {
      const fixture = navigationRouteFixture();
      const path = "/events?game=Chess&past=1&page=2";
      const first = await fixture.request(twin, path);
      expect(first.status).toBe(200);
      const html = await first.text();
      const count = fixture.queries.length;
      expect(count).toBe(6);
      const repeated = await fixture.request(twin, path);
      expect(await repeated.text()).toBe(html);
      expect(fixture.queries).toHaveLength(count);
      expect(repeated.headers.get("cache-control")).toMatch(/public.*max-age=/);
      expect(html).toContain('name="robots" content="noindex, follow"');
      expect(html).not.toMatch(/discordAccessToken|sessionToken|passwordHash/);
    });

    it("native boundary destinations return the first/last matching rows with the original search scope", async () => {
      const fixture = navigationRouteFixture();
      const response = await fixture.request(
        twin,
        "/events?q=Navigation&game=Chess&past=1&page=2",
        true,
      );
      const html = await response.text();
      const all = links(html);
      const first = all.find((link) => firstPageName.test(link.name));
      const last = all.find((link) => lastPageName.test(link.name));
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      expect(params(first!.href).search).toEqual({ q: "Navigation", game: "Chess", past: "1" });
      expect(params(last!.href).search).toEqual({
        q: "Navigation",
        game: "Chess",
        past: "1",
        page: "3",
      });
      const firstScreen = await fixture.request(twin, first!.href, true);
      expect(cardKeys(await firstScreen.text())).toEqual(
        Array.from({ length: 20 }, (_, i) => `navigation-${i + 1}`),
      );
      const lastScreen = await fixture.request(twin, last!.href, true);
      expect(cardKeys(await lastScreen.text())).toEqual([
        "navigation-41",
        "navigation-42",
        "navigation-43",
        "navigation-44",
        "navigation-45",
      ]);
    });

    it("native Hide closes only the preview and adds no navigation-specific data reads", async () => {
      const fixture = navigationRouteFixture();
      const open = await fixture.request(twin, "/events?game=Chess&past=1&page=2", true);
      const openHtml = await open.text();
      expect(openHtml).toContain("Past navigation gathering");
      const hide = links(openHtml).find((link) => hidePastName.test(link.name));
      expect(hide).toBeDefined();
      expect(params(hide!.href).search).toEqual({ game: "Chess", page: "2" });
      const before = fixture.queries.length;
      const closed = await fixture.request(twin, hide!.href, true);
      const closedHtml = await closed.text();
      expect(closed.status).toBe(200);
      expect(closedHtml).not.toContain("Past navigation gathering");
      expect(cardKeys(closedHtml)).toEqual(cardKeys(openHtml));
      // Hono reuses the facet list cached by the open request; Kit re-reads it.
      expect(fixture.queries.length - before).toBe(twin === "Hono" ? 5 : 6);
      expect(closed.headers.get("cache-control")).toBe("public, max-age=60");
      expect(closed.headers.get("set-cookie")).toBeNull();
    });
  });
}
