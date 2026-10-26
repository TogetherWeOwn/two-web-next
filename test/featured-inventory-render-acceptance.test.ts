// FI-R: a corrupt row must not crash/drop its healthy siblings or manufacture live eligibility.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKitFeaturedList } from "../src/admin/kit-featured";
import type { Db } from "../src/db";
import { renderInventory as renderRoute } from "./helpers/admin-inventory-recovery";
import {
  INVENTORY_NOW,
  INVENTORY_STATES,
  INVENTORY_TWINS,
  inventoryIds,
  inventoryLinks,
  inventoryRow,
  inventoryText,
  renderInventory,
} from "./helpers/featured-inventory-acceptance";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INVENTORY_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BROKEN = [
  {
    id: "positive-infinity",
    patch: { startsAt: new Date(Number.NaN), startsAtText: "infinity" },
    text: "infinity",
  },
  {
    id: "negative-infinity",
    patch: { endsAt: new Date(Number.NaN), endsAtText: "-infinity" },
    text: "-infinity",
  },
  {
    id: "undecodable-finite",
    patch: { startsAt: new Date(Number.NaN), startsAtText: "294276-01-01 00:00:00.000000" },
    text: "294276-01-01 00:00:00.000000",
  },
  {
    id: "escaped-saved-text",
    patch: { endsAt: new Date(Number.NaN), endsAtText: "<img src=x onerror=alert(1)>" },
    text: "&lt;img",
  },
] as const;

for (const twin of INVENTORY_TWINS) {
  describe(`${twin} executed inventory rendering`, () => {
    for (const broken of BROKEN) {
      for (const published of [true, false]) {
        it(`FI-R01-${broken.id}-${published}: keep exact text, edit destination and healthy sibling`, async () => {
          const html = await renderInventory(twin, [
            inventoryRow(),
            inventoryRow({
              id: 902,
              title: "Inspect saved broken window",
              isPublished: published,
              ...broken.patch,
            }),
          ]);
          expect(inventoryIds(html)).toEqual([901, 902]);
          const cell = html.match(/data-testid="featured-status-902"[^>]*>([\s\S]*?)<\/td>/)?.[1];
          expect(cell).toContain(`data-status="${published ? "unavailable" : "unpublished"}"`);
          expect(inventoryLinks(html).some((link) => link.pathname === "/admin/featured/902")).toBe(
            true,
          );
          expect(html).toContain(broken.text);
          expect(html).not.toContain("<img src=x");
          expect(html).not.toMatch(
            /datetime="(?:infinity|-infinity|Invalid Date|NaN|294276|&lt;img)/i,
          );
          for (const match of html.matchAll(/datetime="([^"]+)"/g))
            expect(Number.isFinite(Date.parse(match[1]!)), match[1]).toBe(true);
        });
      }
    }

    it("FI-R02-CONTROL: finite start inclusive, end exclusive, open and unpublished behavior survives", async () => {
      const rows = [
        inventoryRow({ id: 901 }),
        inventoryRow({ id: 902, startsAt: INVENTORY_NOW }),
        inventoryRow({ id: 903, endsAt: INVENTORY_NOW }),
        inventoryRow({ id: 904, startsAt: new Date(INVENTORY_NOW.getTime() + 1) }),
        inventoryRow({
          id: 905,
          isPublished: false,
          startsAt: new Date(INVENTORY_NOW.getTime() + 1),
        }),
      ];
      const html = await renderInventory(twin, rows);
      expect(inventoryIds(html)).toEqual([901, 902, 903, 904, 905]);
      for (const [id, state] of [
        [901, "live"],
        [902, "live"],
        [903, "expired"],
        [904, "scheduled"],
        [905, "unpublished"],
      ] as const) {
        expect(
          html.match(new RegExp(`data-testid="featured-status-${id}"[^>]*>([\\s\\S]*?)</td>`))?.[1],
        ).toContain(`data-status="${state}"`);
      }
      expect(html).toContain(`datetime="${INVENTORY_NOW.toISOString()}"`);
    });

    it("FI-R03: native GET facet offers all effective states independently from Published", async () => {
      const html = await renderInventory(twin, [], {
        state: "scheduled",
        published: "1",
        q: "Night",
        sort: "updated_at",
        order: "desc",
        page: "2",
      });
      const form = html.match(/<form\b[^>]*method="get"[\s\S]*?<\/form>/)?.[0];
      expect(form).toBeDefined();
      const select = form!.match(/<select\b[^>]*name="state"[^>]*>([\s\S]*?)<\/select>/)?.[1];
      expect(
        select,
        "FI-FACET-MISSING: add an accessible native effective-state select",
      ).toBeDefined();
      for (const state of ["", ...INVENTORY_STATES]) expect(select).toContain(`value="${state}"`);
      expect(select).toMatch(/<option\b(?=[^>]*value="scheduled")(?=[^>]*selected)[^>]*>/);
      expect(form).toContain('name="published"');
      expect(form).toContain('name="q"');
      expect(form).not.toMatch(/name="page"/);
    });

    it("FI-R04: sort, pager and first-page recovery retain the state; Clear removes all filters", async () => {
      const params = {
        state: "scheduled",
        published: "1",
        q: "Night & day",
        sort: "updated_at",
        order: "desc",
        page: "2",
      };
      const html = await renderInventory(
        twin,
        Array.from({ length: 25 }, (_, i) => inventoryRow({ id: 901 + i })),
        params,
        true,
      );
      const browse = inventoryLinks(html).filter((link) => link.pathname === "/admin/featured");
      const scoped = browse.filter((link) => link.searchParams.get("q") === "Night & day");
      expect(scoped.length).toBeGreaterThanOrEqual(4);
      for (const link of scoped) {
        expect(link.searchParams.get("state"), link.href).toBe("scheduled");
        expect(link.searchParams.get("published"), link.href).toBe("1");
      }
      expect(browse.some((link) => link.searchParams.get("page") === "3")).toBe(true);
      const clear = html.match(/href="([^"]+)"[^>]*>\s*Clear filters/);
      expect(clear).not.toBeNull();
      const cleared = new URL(clear![1]!.replaceAll("&amp;", "&"), "https://example.test");
      expect(Object.fromEntries(cleared.searchParams)).toEqual({
        sort: "updated_at",
        order: "desc",
      });
      const empty = await renderInventory(twin, [], params);
      const first = inventoryLinks(empty).find(
        (link) =>
          link.pathname === "/admin/featured" &&
          link.searchParams.get("q") === "Night & day" &&
          !link.searchParams.has("page"),
      );
      expect(first?.searchParams.get("state")).toBe("scheduled");
      expect(inventoryText(empty)).toMatch(/No results on this page/i);
    });

    it("FI-R05: state-only empty results are filtered, clearable and not a claim of empty inventory", async () => {
      const html = await renderInventory(twin, [], { state: "unavailable" });
      expect(inventoryText(html)).toMatch(/matches these filters/i);
      expect(inventoryText(html)).toMatch(/Clear filters/i);
      expect(inventoryText(html)).not.toMatch(/No featured content yet/i);
    });

    it("FI-R06: explain eligibility is point-in-time, not proof of guest homepage delivery", async () => {
      const html = await renderInventory(twin, [inventoryRow()]);
      expect(inventoryText(html)).toMatch(
        /(?:point.in.time|check time|at this (?:instant|time)|current eligibility)/i,
      );
      expect(inventoryText(html)).toMatch(
        /(?:not (?:proof|confirmation)|does not (?:prove|guarantee)|verify.{0,50}(?:guest|homepage))/i,
      );
    });

    for (const admission of ["guest", "member"] as const) {
      it(`FI-R07-CONTROL-${admission}: refuse before any inventory reads even with state supplied`, async () => {
        const result = await renderRoute(twin, "featured", "?state=unavailable", [], admission);
        expect(result.status).toBe(admission === "guest" ? 302 : 403);
        expect(result.probe.queries).toEqual([]);
        expect(result.probe.transactions).toBe(0);
        expect(result.bindingCalls).toBe(0);
      });
    }
  });
}

describe("inventory model failure boundaries", () => {
  it("FI-M01-CONTROL: missing DB and classified read failure remain unavailable, never empty success", async () => {
    const list = vi.fn(async () => []);
    expect(await resolveKitFeaturedList({}, { db: null, list })).toEqual({ kind: "unavailable" });
    expect(list).not.toHaveBeenCalled();
    const outage = Object.assign(new Error("fixture transport"), { code: "ECONNRESET" });
    expect(
      await resolveKitFeaturedList(
        {},
        {
          db: {} as Db,
          list: async () => {
            throw outage;
          },
        },
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("FI-M02-CONTROL: a programming error propagates rather than fabricating empty success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bug = new TypeError("fixture coding error");
    await expect(
      resolveKitFeaturedList(
        {},
        {
          db: {} as Db,
          list: async () => {
            throw bug;
          },
        },
      ),
    ).rejects.toBe(bug);
  });
});
