// route-inventory: GET /e/:key
// Independent literal labels catch year-only text and forced-UTC formatting;
// renderer parity alone cannot catch a bug in their shared formatter.
import { beforeAll, describe, expect, it } from "vitest";
import { scheduleCases } from "./fixtures/event-scheduled-range";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  type KitRenderer,
} from "./helpers/event-scheduled-range";

let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} updated-stamp visible label`, () => {
    it.each([
      ["UTC", "Tuesday, 20 November 2029 at 15:30 GMT+00:00"],
      ["Pacific/Auckland", "Wednesday, 21 November 2029 at 04:30 GMT+13:00"],
      ["not/a-zone", "2029-11-20T15:30:00.000Z"],
    ])("renders the full edit date in %s, not just its year", async (timezone, expected) => {
      const row = scheduledEvent(scheduleCases[0], {
        startsAt: new Date("2030-06-10T20:00:00.000Z"),
        endsAt: new Date("2030-06-10T22:00:00.000Z"),
        timezone,
        createdAt: new Date("2028-05-01T12:00:00.000Z"),
        updatedAt: new Date("2029-11-20T15:30:00.000Z"),
      });
      const { status, html } = await renderScheduledPage(twin, row, "guest", kit);
      expect(status).toBe(200);
      const stamps = [...html.matchAll(/data-testid="event-updated"[^>]*>[\s\S]*?<\/div>/g)];
      expect(stamps).toHaveLength(1);
      const stamp = stamps[0]![0];
      expect(stamp).toContain("Updated ");
      expect(stamp).toContain(`<time datetime="2029-11-20T15:30:00.000Z">${expected}</time>`);
    });
  });
}
