// route-inventory: GET /events
// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance-owned RED handoff: Builder must not edit this suite or its helper.
// Missing/duplicate schedule links, page-wide-only UTC copy, per-grid omissions,
// and shifting the UTC cell coordinates instead of labelling them must fail here.
// Run: npx vitest run test/hotzones-schedule-utc-acceptance.test.ts test/hotzones-grid-oracle.test.ts
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { gameRecoveryFixture } from "./helpers/calendar-game-recovery";
import { compilePeriodKit, type PeriodKit } from "./helpers/hotzone-period-picker";
import {
  gridEvidence,
  joinsFixture,
  requestHotzones,
  scheduleHotzoneLinks,
} from "./helpers/hotzones-schedule-acceptance";

let kit: PeriodKit;
beforeAll(async () => {
  kit = await compilePeriodKit();
});
afterAll(() => kit?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.stubGlobal("fetch", async () => {
    throw new Error("Hotzones acceptance forbids external network requests");
  });
});
afterEach(() => vi.unstubAllGlobals());

const schedulePaths = [
  "/events?view=list&month=2099-05",
  "/events?view=calendar&month=2099-05",
  "/events?view=list&month=2099-05&game=Chess",
];
const gridPaths = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Golden values at the assignment source pin. Do not compute expectations with
// priorGrid: that would silently bless a changed seed, reweight or hour shift.
const priorDigests = {
  voice: "cbda79d7710382fc5d2b01f5a9d0dc124ac83260c6b14cfc944b56a8f3f89047",
  games: "f8ead90dfe359dbf6fa085d53e559d7440a7506b9280032663ff3a4480038f70",
};

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} schedule discovers hot zones`, () => {
    for (const island of [false, true]) {
      it.each(schedulePaths)(
        `%s has exactly one schedule-head link (fragment=${island})`,
        async (path) => {
          const fixture = gameRecoveryFixture();
          const response = await fixture.render(twin, path, island);
          expect(response.status).toBe(200);
          const head = scheduleHotzoneLinks(await response.text());
          expect(head.headCount).toBe(1);
          expect(head.links).toEqual([{ href: "/hotzones", name: "Hot zones" }]);
        },
      );
    }

    it("follows the schedule-head anchor to a successful hotzones page", async () => {
      const response = await gameRecoveryFixture().render(twin, schedulePaths[0]!);
      expect(response.status).toBe(200);
      const { links } = scheduleHotzoneLinks(await response.text());
      expect(links).toHaveLength(1);
      const destination = await requestHotzones(twin, links[0]!.href, kit);
      expect(destination.status).toBe(200);
      expect(gridEvidence(await destination.text())).toHaveLength(3);
    });

    it("already serves the intended destination with real grids", async () => {
      const response = await requestHotzones(twin, "/hotzones", kit);
      expect(response.status).toBe(200);
      expect(gridEvidence(await response.text())).toHaveLength(3);
    });
  });

  describe(`${twin} hotzones hours are truthfully labelled`, () => {
    it.each(gridPaths)(
      "%s labels every grid's visible and accessible hour axis UTC",
      async (path) => {
        const response = await requestHotzones(twin, `${path}?season=2026-02`, kit);
        expect(response.status).toBe(200);
        const grids = gridEvidence(await response.text());
        expect(grids).toHaveLength(path === "/hotzones" ? 3 : 1);
        for (const [index, grid] of grids.entries()) {
          expect
            .soft(grid.visibleAxis, `${path} grid ${index}: visible caption/hour axis`)
            .toMatch(/\bUTC\b/);
          expect
            .soft(grid.accessibleAxis, `${path} grid ${index}: accessible caption/hour axis`)
            .toMatch(/\bUTC\b/);
        }
      },
    );

    it.each(gridPaths)(
      "%s preserves the fixed grid cells in UTC weekday/hour order",
      async (path) => {
        const response = await requestHotzones(twin, `${path}?season=2026-02`, kit);
        expect(response.status).toBe(200);
        const grids = gridEvidence(await response.text());
        const signals = path === "/hotzones" ? ["joins", "voice", "games"] : [path.split("/")[2]!];
        expect(grids).toHaveLength(signals.length);
        for (const [index, signal] of signals.entries()) {
          const grid = grids[index]!;
          expect(grid.days).toEqual(days);
          expect(grid.hours).toEqual(
            Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
          );
          expect(grid.cells).toHaveLength(7);
          for (const row of grid.cells) expect(row).toHaveLength(24);
          if (signal === "joins") {
            expect(grid.cells).toEqual(joinsFixture().cells);
          } else {
            expect(createHash("sha256").update(JSON.stringify(grid.cells)).digest("hex")).toBe(
              priorDigests[signal as "voice" | "games"],
            );
          }
        }
      },
    );
  });
}
