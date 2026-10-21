import { describe, expect, it } from "vitest";
import {
  CALENDAR_AUTH_ORIGIN as ORIGIN,
  CALENDAR_AUTH_QUERY as QUERY,
  calendarAuthFixture,
} from "./helpers/calendar-auth";

const paths = [
  "/events",
  "/events?view=calendar&month=2030-01",
  "/events?page=2",
  "/events?past=1",
  "/events?q=" + encodeURIComponent(QUERY),
  "/events?next=https%3A%2F%2Fevil.example%2F&source=%2F%2Fevil.example",
];

function authLinks(html: string) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)]
    .map((match) => match[1]!.replace(/&amp;/g, "&"))
    .filter((href) => /^\/(?:auth\/discord|join(?:\/discord)?)\?/.test(href));
}

describe("calendar native authentication destination oracle", () => {
  it.each(paths)(
    "Hono and Kit preserve the same local return and distinct entries for %s",
    async (path) => {
      const rendered: string[][] = [];
      for (const renderer of ["hono", "kit"] as const) {
        const fixture = calendarAuthFixture(renderer);
        for (const fragment of [false, true]) {
          const response = await fixture.request(path, fragment);
          expect(response.status).toBe(200);
          const body = await response.text();
          const links = authLinks(body);
          if (path.includes("view=calendar")) expect(links).toHaveLength(2);
          else expect(links.length).toBeGreaterThan(2);
          const entries = links.map((href) => new URL(href, ORIGIN));
          expect(entries[0]!.pathname).toBe("/auth/discord");
          expect(entries[1]!.pathname).toBe("/join");
          expect(entries.slice(2).every((url) => url.pathname === "/join/discord")).toBe(true);
          for (const url of entries) {
            expect(url.origin).toBe(ORIGIN);
            expect(url.searchParams.getAll("next")).toEqual([path]);
            expect(new URL(url.searchParams.get("next")!, ORIGIN).origin).toBe(ORIGIN);
          }
          rendered.push(links);
        }
      }
      for (const links of rendered) expect(links).toEqual(rendered[0]);
    },
  );
});
