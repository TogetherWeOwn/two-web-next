import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { registerHotzoneRoutes } from "../src/hotzones/routes";

// Deleting badSeason's cache-control header must fail on every public hotzone path.
describe.each(["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"])(
  "%s bad-season caching",
  (path) => {
    it.each(["not-a-season", "2026-13", "2026-Q5", ""])(
      "keeps the HTML 400 private and uncacheable for season=%j",
      async (season) => {
        const app = new Hono<{ Bindings: Env }>();
        registerHotzoneRoutes(app);
        const response = await app.request(`${path}?season=${encodeURIComponent(season)}`, {}, {
          APP_URL: "https://example.test",
        } as Env);

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-store, private");
      },
    );
  },
);
