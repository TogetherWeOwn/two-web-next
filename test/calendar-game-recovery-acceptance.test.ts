// route-inventory: GET /events
// Independent acceptance; Builder must not edit this file or its paired browser suite.
// A1.7 Filtered empties name their effective scope, never a community-wide absence.
// A1.8 Broadening GET destinations agree with their accessible labels.
// A1.9 Complete/failed/partial reads and q-only demand semantics stay distinct.
// A1.10 Unknown games, bounded reads, escaping and cache separation are controls.
// A1.1–A1.6 execute real browser recovery in ci/calendar-game-recovery-browser.test.ts.
// Catches collapsing game-only empties into the global branch, leaving game on a
// clear-all destination, or treating game-only interest as text-search demand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { recordSearch } from "../src/events/search-log";
import {
  GAME_ORIGIN,
  GAME_TWINS,
  broadeningLinks,
  decodedText,
  emptyRegion,
  gameRecoveryFixture,
  gameRow,
} from "./helpers/calendar-game-recovery";

vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnonEventCacheForTests();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Acceptance fixtures must not use external HTTP");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const resultLogs = () =>
  vi.mocked(console.info).mock.calls.filter(([name]) => name === "event_search");

for (const twin of GAME_TWINS) {
  describe(`${twin} game-scope SSR acceptance`, () => {
    for (const view of ["list", "calendar"]) {
      for (const q of ["", "absent words"]) {
        it(`A1.7 ${view} q=${JSON.stringify(q)} zero is scoped to Chess, not the whole community`, async () => {
          const f = gameRecoveryFixture({ empty: true });
          const response = await f.render(
            twin,
            `/events?view=${view}&month=2099-05&game=Chess&q=${encodeURIComponent(q)}`,
          );
          expect(response.status).toBe(200);
          const html = await response.text();
          const region = emptyRegion(html);
          expect(region, "a real scoped empty region must render").not.toBe("");
          expect
            .soft(decodedText(region), "the empty outcome itself must name the effective game")
            .toMatch(/Chess/);
          expect
            .soft(decodedText(region))
            .not.toMatch(
              /first (?:ever )?event|no events yet|community has no|never (?:held|run)|No upcoming events\s*[—-]\s*check back/i,
            );
          if (q) expect(decodedText(region)).toContain(q);
          expect(html).not.toContain('data-testid="events-empty-error"');
          expect(f.queries.filter(({ sql }) => /^select\s+distinct/i.test(sql))).toHaveLength(1);
          expect(f.queries.length).toBeLessThanOrEqual(7);
        });

        it(`A1.8 ${view} q=${JSON.stringify(q)} offers a truthful broader GET with matching label`, async () => {
          const f = gameRecoveryFixture({ empty: true });
          const path = `/events?view=${view}&month=2099-05&past=1&game=Chess&q=${encodeURIComponent(q)}`;
          // Nonblank text search uses list view, even when the request asks for calendar.
          const effectiveView = q.trim() ? "list" : view;
          const html = await (await f.render(twin, path)).text();
          const links = broadeningLinks(emptyRegion(html));
          const gameClear = links.filter(
            (link) => !new URL(link.href, GAME_ORIGIN).searchParams.get("game"),
          );
          expect(
            gameClear.length,
            "filtered empty needs an action that really broadens game scope",
          ).toBeGreaterThan(0);
          for (const link of gameClear) {
            const target = new URL(link.href, GAME_ORIGIN);
            expect(target.pathname).toBe("/events");
            expect(target.searchParams.get("view") ?? "list").toBe(effectiveView);
            if (effectiveView === "calendar")
              expect(target.searchParams.get("month")).toBe("2099-05");
            expect(target.searchParams.get("past")).toBe("1");
            expect(target.searchParams.get("page") ?? "1").toBe("1");
            if (
              /all (?:events|filters)|clear (?:all|filters)|remove (?:all )?filters/i.test(
                link.name,
              )
            ) {
              expect(target.searchParams.get("q") ?? "").toBe("");
            } else if (/all games|game filter/i.test(link.name)) {
              expect(target.searchParams.get("q") ?? "").toBe(q);
            } else {
              // A label claiming only to clear search cannot secretly clear a game.
              expect(link.name).not.toMatch(/^clear (?:the )?search$/i);
            }
            const follow = await f.render(twin, target.pathname + target.search);
            expect(follow.status).toBe(200);
            expect(await follow.text()).toMatch(/<option\b[^>]*value=""[^>]*selected/);
          }
        });
      }
    }

    it("A1.9 CONTROL game-only interest creates neither persisted nor diagnostic text-search demand", async () => {
      const f = gameRecoveryFixture({ empty: true });
      const response = await f.render(twin, "/events?game=Chess");
      expect(response.status).toBe(200);
      expect(recordSearch).not.toHaveBeenCalled();
      expect(resultLogs()).toEqual([]);
      expect(f.discordCalls).toHaveLength(1);
    });

    it("A1.9 CONTROL complete combined q+game retains exactly one q demand record", async () => {
      const f = gameRecoveryFixture();
      await f.render(twin, "/events?game=Chess&q=fixture");
      // Demand counts the existing upcoming + past preview, not just visible upcoming cards.
      expect(recordSearch).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "fixture",
        2,
        undefined,
        undefined,
      );
      expect(resultLogs()).toEqual([
        ["event_search", { event: "event_search", query: "fixture", results: 2 }],
      ]);
    });

    it.each([false, true])(
      "A1.9 CONTROL failed source empty=%s is not a complete scoped zero or demand record",
      async (empty) => {
        const f = gameRecoveryFixture({ empty, failed: true });
        const html = await (await f.render(twin, "/events?game=Chess&q=fixture")).text();
        expect(recordSearch).not.toHaveBeenCalled();
        expect(resultLogs()).toEqual([]);
        if (empty) {
          expect(html).toContain('data-testid="events-empty-error"');
          expect(html).not.toContain('data-testid="events-empty-search"');
        } else {
          expect(html).toContain("Chess fixture night");
          expect(html).not.toContain("Go fixture night");
          expect(html).toMatch(/role="(?:status|alert)"[^>]*>[\s\S]*?Discord/);
        }
        expect(f.discordCalls).toHaveLength(1);
      },
    );

    it("A1.10 CONTROL unknown game retains effective All games and global empty behavior", async () => {
      const f = gameRecoveryFixture({ empty: true });
      const html = await (await f.render(twin, "/events?game=Unrecognized")).text();
      expect(html).toMatch(/<option\b[^>]*value=""[^>]*selected/);
      expect(decodedText(emptyRegion(html))).not.toContain("Unrecognized");
      expect(emptyRegion(html)).toContain("No upcoming events");
      expect(recordSearch).not.toHaveBeenCalled();
    });

    it("A1.10 CONTROL island recovery cannot reuse a warmed anonymous filtered zero", async () => {
      const f = gameRecoveryFixture();
      const first = await f.render(twin, "/events?game=Chess");
      expect(await first.text()).toContain("Chess fixture night");
      const before = f.queries.length;
      f.setEmpty();
      const next = await f.render(twin, "/events?game=Chess", true);
      expect(next.status).toBe(200);
      expect(await next.text()).not.toContain('data-testid="event-card"');
      expect(f.queries.length).toBeGreaterThan(before);
      expect(next.headers.get("set-cookie")).toBeNull();
    });

    it("A1.10 CONTROL hostile unknown game cannot produce markup, reflected member data or writes", async () => {
      const f = gameRecoveryFixture({ empty: true });
      const html = await (
        await f.render(
          twin,
          `/events?game=${encodeURIComponent('<img src=x onerror="scopeLeak()">')}`,
        )
      ).text();
      expect(html).not.toContain('<img src=x onerror="scopeLeak()">');
      expect(html).toMatch(/<option\b[^>]*value=""[^>]*selected/);
      expect(f.queries.every(({ sql }) => /^select\b/i.test(sql))).toBe(true);
      expect(recordSearch).not.toHaveBeenCalled();
    });

    it("A1.7 calendar game-scoped miss suppresses the unscoped month sentence", async () => {
      const f = gameRecoveryFixture({ upcomingRows: [gameRow(2, "Go")] });
      const html = await (
        await f.render(twin, "/events?view=calendar&month=2099-05&game=Chess")
      ).text();
      expect(html).toContain('data-testid="events-empty-search"');
      expect(html).not.toContain('data-testid="calendar-month-empty"');
      expect(decodedText(emptyRegion(html))).toContain("Chess");
    });

    it("A1.7 calendar month miss with matches elsewhere keeps the month sentence, not a game miss", async () => {
      const f = gameRecoveryFixture({
        upcomingRows: [gameRow(1, "Chess", false, "2099-05")],
      });
      const html = await (
        await f.render(twin, "/events?view=calendar&month=2099-06&game=Chess")
      ).text();
      expect(html).not.toContain('data-testid="events-empty-search"');
      expect(html).toContain('data-testid="calendar-month-empty"');
    });
  });
}
