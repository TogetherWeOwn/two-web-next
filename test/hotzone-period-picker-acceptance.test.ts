// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance-owned RED handoff. Builder must not edit these tests.
// Missing forms, stale/ambient clocks, local-time shortcuts, cross-signal form
// actions, redundant reset state, or accepting invalid periods must fail here.
// Render the real routes and compiled Kit pages; never grep their source.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  committedPeriods,
  periodNow,
  periodPaths,
  refusedPeriods,
  utcPeriodBoundaries,
} from "./fixtures/hotzone-period-picker";
import {
  compilePeriodKit,
  periodControl,
  renderPeriodRequest,
  shortcut,
  type PeriodKit,
} from "./helpers/hotzone-period-picker";

let kit: PeriodKit;
beforeAll(async () => {
  kit = await compilePeriodKit();
});
afterAll(() => kit?.dispose());

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} native period selection`, () => {
    for (const path of periodPaths) {
      it.each(committedPeriods)(
        `${path}$query exposes the committed $value in a GET form`,
        async ({ query, value }) => {
          const result = await renderPeriodRequest(twin, `${path}${query}`, kit, periodNow);
          expect(result.status).toBe(200);
          const { form, control, label, help } = periodControl(result.html);
          expect((form.method || "get").toLowerCase()).toBe("get");
          expect(new URL(form.action, `https://period.example.test${path}`).href).toBe(
            `https://period.example.test${path}`,
          );
          expect(control.name).toBe("season");
          expect(control.value.toLowerCase()).toBe(value);
          expect(label).toMatch(/period|season/i);
          expect(control.disabled).toBe(false);
          expect(help).toMatch(/\ball\b/i);
          expect(help).toMatch(/year|YYYY/);
          expect(help).toMatch(/month|YYYY-MM/);
          expect(help).toMatch(/quarter|YYYY-Q/);
          expect(form.html).toMatch(/<button\b|<input\b[^>]*type=["']submit["']/i);
          // The picker must be read-only and native, not a CSRF-protected POST.
          expect(form.html).not.toMatch(/name=["'](?:_method|_token|csrf)["']/i);
        },
      );

      it.each(utcPeriodBoundaries)(
        `${path} derives UTC shortcuts at $instant`,
        async ({ instant, month, quarter }) => {
          // The request clock is deliberately nowhere near the ambient run date.
          const result = await renderPeriodRequest(
            twin,
            `${path}?season=2025`,
            kit,
            new Date(instant),
          );
          expect(result.status).toBe(200);
          const monthLink = shortcut(result.html, "This month");
          const quarterLink = shortcut(result.html, "This quarter");
          const allLink = shortcut(result.html, "All available data");
          expect(monthLink.href).toBe(`${path}?season=${month}`);
          expect(quarterLink.href).toBe(`${path}?season=${quarter}`);
          expect(allLink.href).toBe(path);
          expect(result.html.replace(/<[^>]*>/g, " ")).toMatch(/\bUTC\b/);
        },
      );

      it("keeps All available data and canonical metadata free of redundant season=all", async () => {
        for (const query of ["", "?season=all"]) {
          const result = await renderPeriodRequest(twin, `${path}${query}`, kit, periodNow);
          expect(result.status).toBe(200);
          expect(shortcut(result.html, "All available data").href).toBe(path);
          const canonical = result.html.match(
            /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i,
          )?.[1];
          expect(canonical).toBe(`https://period.example.test${path}`);
        }
      });

      it.each(refusedPeriods)(
        `${path} still refuses season=%j without an aggregate fallback`,
        async (value) => {
          const result = await renderPeriodRequest(
            twin,
            `${path}?season=${encodeURIComponent(value)}`,
            kit,
            periodNow,
          );
          expect(result.status).toBe(400);
          expect(result.dbTouches).toBe(0);
          expect(result.html).not.toContain('name="season" value="all"');
        },
      );
    }

    it("retains seed-estimate and privacy/retention context beside the controls", async () => {
      for (const path of periodPaths) {
        const result = await renderPeriodRequest(twin, `${path}?season=2025-02`, kit, periodNow);
        expect(result.status).toBe(200);
        if (path === "/hotzones" || path === "/hotzones/joins") {
          expect(result.html).toMatch(/retention|retain|retained|90.day/i);
        }
        expect(result.html).toMatch(/opt.out|privacy/i);
        if (path !== "/hotzones/joins") expect(result.html).toMatch(/estimat/i);
        expect(result.html).not.toMatch(/discord_id|member-secret-fixture/);
      }
    });
  });
}
