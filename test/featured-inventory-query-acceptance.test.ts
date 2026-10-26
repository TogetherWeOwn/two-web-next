// FI-Q: losing/reflecting unallowlisted facets or clearing unrelated browse state breaks these cases.
import { describe, expect, it } from "vitest";
import {
  featuredEmptyText,
  featuredListClearUrl,
  featuredListHasFilters,
  featuredListUrl,
  parseFeaturedListQuery,
} from "../src/admin/featured-list-query";
import { INVENTORY_STATES } from "./helpers/featured-inventory-acceptance";

function url(value: string) {
  return new URL(value, "https://example.test");
}

describe("featured inventory query authority", () => {
  it.each(INVENTORY_STATES)(
    "FI-Q01-%s: allowlist the effective state independently of publication",
    (state) => {
      const query = parseFeaturedListQuery({
        state,
        published: "0",
        q: "  raid  ",
        sort: "updated_at",
        order: "desc",
        page: "2",
      });
      expect(query).toMatchObject({
        state,
        published: "0",
        q: "raid",
        sort: "updated_at",
        order: "desc",
        page: 2,
      });
      const destination = url(featuredListUrl(query));
      expect(Object.fromEntries(destination.searchParams)).toEqual({
        state,
        published: "0",
        q: "raid",
        sort: "updated_at",
        order: "desc",
        page: "2",
      });
      expect(featuredListHasFilters(parseFeaturedListQuery({ state }))).toBe(true);
      expect(featuredEmptyText(parseFeaturedListQuery({ state }))).toMatch(
        /matches these filters/i,
      );
    },
  );

  it.each([undefined, "", "all", "LIVE", " live ", "unknown", "<script>", "live,expired"])(
    "FI-Q02-%s: absent or invalid state falls back to All without reflection",
    (state) => {
      const query = parseFeaturedListQuery({ state });
      // Missing state on the old authority is equivalent to All; do not manufacture a red control.
      expect((query as unknown as { state?: string }).state ?? "").toBe("");
      expect(url(featuredListUrl(query)).searchParams.has("state")).toBe(false);
      expect(featuredListHasFilters(query)).toBe(false);
      expect(featuredEmptyText(query)).toMatch(/No featured content yet/i);
    },
  );

  it("FI-Q03: page/sort changes retain intersections; clearing removes every facet and resets the page", () => {
    const query = parseFeaturedListQuery({
      state: "scheduled",
      published: "1",
      q: "Night & day",
      page: "3",
      sort: "updated_at",
      order: "desc",
    });
    const next = url(featuredListUrl(query, { page: 4 }));
    expect(next.searchParams.get("state")).toBe("scheduled");
    expect(next.searchParams.get("q")).toBe("Night & day");
    expect(next.searchParams.get("published")).toBe("1");
    expect(next.searchParams.get("page")).toBe("4");
    const sorted = url(featuredListUrl(query, { sort: "position", order: "asc", page: 1 }));
    expect(Object.fromEntries(sorted.searchParams)).toEqual({
      sort: "position",
      order: "asc",
      state: "scheduled",
      published: "1",
      q: "Night & day",
    });
    expect(Object.fromEntries(url(featuredListClearUrl(query)).searchParams)).toEqual({
      sort: "updated_at",
      order: "desc",
    });
  });

  it("FI-Q04-CONTROL: existing bounds, literal query text and later-page recovery survive", () => {
    const query = parseFeaturedListQuery({
      q: "\0  100%_night  ",
      published: "1",
      sort: "bogus",
      order: "bad",
      page: "9007199254740991",
    });
    expect(query).toMatchObject({
      q: "100%_night",
      published: "1",
      sort: "position",
      order: "asc",
      page: 1,
    });
    expect(parseFeaturedListQuery({ q: "x".repeat(129) }).q).toBe("");
    expect(featuredEmptyText(parseFeaturedListQuery({ state: "live", page: "9" }))).toMatch(
      /No results on this page/i,
    );
  });
});
