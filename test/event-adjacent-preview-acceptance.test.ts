// Independent Test-Author contract: Builder must not edit this file or its
// event-adjacent-preview helper/browser/read specs. Keep stable AP identifiers.
// RED means missing destination metadata; CONTROL must pass on the base too.
import { describe, expect, it } from "vitest";
import {
  adjacentEvent,
  adjacentKey,
  previewNeighbors,
  renderAdjacentDetail,
} from "./helpers/event-adjacent-preview";

const rails = ["event", "event-series"] as const;
// Read text between inert SSR tokens; never rewrite markup into new tags.
const text = (html: string): string => {
  let content = "";
  let last = 0;
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<[^>]*>/g)) {
    content += html.slice(last, token.index);
    if (!token[0].startsWith("<!--")) content += " ";
    last = token.index + token[0].length;
  }
  return (content + html.slice(last)).replace(/\s+/g, " ").trim();
};
function link(html: string, testid: string) {
  const found = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].find((m) =>
    m[0].includes(`data-testid="${testid}"`),
  );
  expect(found, `native ${testid} anchor exists`).toBeDefined();
  return found![0];
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} adjacent destination previews`, () => {
    it("AP01 RED: identical titles have distinct server dates and known venues in both rails", async () => {
      const html = await renderAdjacentDetail(twin);
      for (const rail of rails) {
        const previous = link(html, `${rail}-previous`);
        const next = link(html, `${rail}-next`);
        expect(previous).toContain(`href="/e/${adjacentKey(10)}"`);
        expect(next).toContain(`href="/e/${adjacentKey(30)}"`);
        expect(text(previous)).toContain("Friday game night");
        expect(text(next)).toContain("Friday game night");
        expect(text(previous)).toContain("Friday, 7 June 2030 at 15:00 GMT-04:00");
        expect(text(next)).toContain("Friday, 21 June 2030 at 20:00 GMT+01:00");
        expect(text(previous)).toContain("West room");
        expect(text(next)).toContain("East room");
        expect(previous).not.toContain("Current event lobby");
        expect(next).not.toContain("Current event lobby");
      }
    });

    it.each([
      [
        "first fold",
        "2030-11-03T05:30:00.000Z",
        "America/New_York",
        "Sunday, 3 November 2030 at 01:30 GMT-04:00",
      ],
      [
        "second fold",
        "2030-11-03T06:30:00.000Z",
        "America/New_York",
        "Sunday, 3 November 2030 at 01:30 GMT-05:00",
      ],
      [
        "year rollover",
        "2030-12-31T23:30:00.000Z",
        "Asia/Tokyo",
        "Wednesday, 1 January 2031 at 08:30 GMT+09:00",
      ],
      [
        "invalid zone fallback",
        "2030-12-31T23:30:00.000Z",
        "Invalid/Zone",
        "2030-12-31T23:30:00.000Z",
      ],
    ])(
      "AP02 RED: %s uses the destination zone and machine instant on every directional link",
      async (_name, instant, timezone, expected) => {
        const destination = adjacentEvent(40, { startsAt: new Date(instant), timezone });
        const html = await renderAdjacentDetail(twin, {
          neighbors: { previous: destination, next: destination },
        });
        for (const rail of rails) {
          for (const direction of ["previous", "next"]) {
            const anchor = link(html, `${rail}-${direction}`);
            const times = [...anchor.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/g)];
            expect(times, `${rail}-${direction} contains one native time`).toHaveLength(1);
            expect(times[0]![0]).toContain(`datetime="${instant}"`);
            expect(text(times[0]![0])).toBe(expected);
          }
        }
      },
    );

    it("AP03 RED: hostile destination titles and venues render as text, never markup", async () => {
      const destination = adjacentEvent(40, {
        title: 'Night <img src=x onerror="alert(1)"> & friends',
        location: '<svg onload="alert(2)">Venue & Café</svg>',
      });
      const html = await renderAdjacentDetail(twin, {
        neighbors: { previous: destination, next: destination },
      });
      for (const rail of rails) {
        for (const direction of ["previous", "next"]) {
          const anchor = link(html, `${rail}-${direction}`);
          expect(anchor).toContain("Night &lt;img");
          expect(anchor).toContain("&lt;svg");
          expect(anchor).toContain("Venue &amp; Café");
          expect(anchor).not.toMatch(/<(?:img|svg|script)\b/i);
        }
      }
    });

    it("AP04 CONTROL: missing venues are omitted, not replaced by the current venue or a guess", async () => {
      const destination = adjacentEvent(40, { location: null });
      const html = await renderAdjacentDetail(twin, {
        neighbors: { previous: destination, next: destination },
      });
      for (const rail of rails) {
        for (const direction of ["previous", "next"]) {
          const anchor = link(html, `${rail}-${direction}`);
          expect(anchor).not.toMatch(
            /Current event lobby|null|undefined|Online|TBA|Unknown location/,
          );
          expect(anchor).not.toContain('class="event-related-location"');
        }
      }
    });

    it.each(["previous", "next", "both", "neither"] as const)(
      "AP05 CONTROL: %s keeps distinct rails, targets and native direction semantics",
      async (state) => {
        const neighbors = {
          previous: state === "previous" || state === "both" ? previewNeighbors.previous : null,
          next: state === "next" || state === "both" ? previewNeighbors.next : null,
        };
        const html = await renderAdjacentDetail(twin, { neighbors });
        if (state === "neither") {
          expect(html).not.toContain('data-testid="event-pagination"');
          expect(html).not.toContain('data-testid="event-series-nav"');
        } else {
          expect(html).toContain('aria-label="Series events"');
          expect(html).toContain('aria-label="More events"');
        }
        for (const rail of rails) {
          for (const direction of ["previous", "next"] as const) {
            if (!neighbors[direction]) {
              expect(html).not.toContain(`data-testid="${rail}-${direction}"`);
              continue;
            }
            const anchor = link(html, `${rail}-${direction}`);
            expect(anchor).toContain(`rel="${direction === "previous" ? "prev" : "next"}"`);
            expect(anchor).toContain(`href="/e/${neighbors[direction]!.eventKey}"`);
            expect(text(anchor)).toContain(direction === "previous" ? "Previous" : "Next");
            expect(text(anchor)).toContain(rail === "event-series" ? "in series:" : "event:");
          }
        }
      },
    );

    it.each(["previous", "next"] as const)(
      "AP13 RED: %s-only rails still preview the destination",
      async (direction) => {
        const neighbors = {
          previous: direction === "previous" ? previewNeighbors.previous : null,
          next: direction === "next" ? previewNeighbors.next : null,
        };
        const html = await renderAdjacentDetail(twin, { neighbors });
        for (const rail of rails) {
          const anchor = link(html, `${rail}-${direction}`);
          expect(anchor).toContain("<time");
          expect(text(anchor)).toContain(direction === "previous" ? "7 June 2030" : "21 June 2030");
          expect(text(anchor)).toContain(direction === "previous" ? "West room" : "East room");
        }
      },
    );

    it("AP14 CONTROL: series links do not depend on the global rail being available", async () => {
      const html = await renderAdjacentDetail(twin, {
        neighbors: { previous: null, next: null },
        series: { hosts: ["Riley"], ...previewNeighbors },
      });
      expect(html).not.toContain('data-testid="event-pagination"');
      expect(html).toContain('data-testid="event-series-nav"');
      expect(link(html, "event-series-next")).toContain(`href="/e/${adjacentKey(30)}"`);
    });

    it("AP06 CONTROL: standalone keeps the global rail without inventing series context", async () => {
      const html = await renderAdjacentDetail(twin, { series: null });
      expect(html).toContain('data-testid="event-pagination"');
      expect(html).not.toContain('data-testid="event-series-nav"');
      expect(html).not.toContain('data-testid="event-series-hosts"');
    });
  });
}
