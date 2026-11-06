import { describe, expect, it } from "vitest";
import type { DiscordTransient } from "../src/islands/contracts";
import {
  DESCRIPTION_LIMIT,
  EVENT_KEY,
  FULL_DESCRIPTION,
  cardHtml,
  cardRanges,
  scanEvent,
} from "./calendar-card-scan.fixtures";
import { renderCalendar } from "./helpers/calendar-multiday-acceptance";

// Acceptance-owned: consume unchanged with the behavior implementation.
// Breaks caught: clock-only cross-day ends, lost end instants, unbounded prose,
// UTF-16 truncation, hidden participation, and divergent Hono/Kit card output.
// No new product helper/import is required for these tests to collect on base.
function cardIn(html: string, key = EVENT_KEY): string {
  const card = html.match(
    new RegExp(`<article\\b[^>]*data-event-key="${key}"[^>]*>[\\s\\S]*?</article>`),
  );
  expect(card, "fixture must reach the real list-card renderer").not.toBeNull();
  return card![0];
}

function endRun(card: string): string {
  const run = card.match(/<time\b[^>]*>[\s\S]*?<\/time>([\s\S]*?)<\/p>/);
  expect(run, "start schedule exists before checking the end").not.toBeNull();
  return run![1]!;
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} list-card scanning acceptance`, () => {
    for (const fixture of cardRanges) {
      const event = () =>
        scanEvent({
          startsAt: new Date(fixture.start),
          endsAt: new Date(fixture.end),
          timezone: fixture.zone,
        });

      it(`${fixture.name}: both known instants are machine-readable`, async () => {
        const card = cardIn(await renderCalendar(twin, [event()], { view: "list" }));
        const instants = [...card.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)].map(
          (match) => match[1],
        );
        expect(instants).toEqual([
          new Date(fixture.start).toISOString(),
          new Date(fixture.end).toISOString(),
        ]);
      });

      it(`${fixture.name}: end date follows the host's wall day`, async () => {
        // Viewer/page UTC must not replace a persisted event's host zone.
        const card = cardIn(await renderCalendar(twin, [event()], { view: "list", zone: "UTC" }));
        const end = endRun(card);
        expect(end).toContain(fixture.endClock);
        if (fixture.endDate) expect(end).toMatch(fixture.endDate);
        else {
          // A same-day end stays clock-only, including DST and UTC-day crossings.
          expect(end).not.toMatch(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i);
        }
        if (fixture.endYear) expect(end).toContain(fixture.endYear);
      });
    }

    it.each([null, "", "Bring a game.\nEveryone welcome.", "x".repeat(DESCRIPTION_LIMIT)])(
      "leaves absent/short/exact-threshold descriptions unchanged: %j",
      async (description) => {
        const card = cardIn(
          await renderCalendar(twin, [scanEvent({ description })], { view: "list" }),
        );
        expect(card).not.toMatch(/<details\b/);
        if (description)
          expect(card).toContain(`<p class="schedule-short-text">${description}</p>`);
      },
    );

    it.each(
      ["x".repeat(DESCRIPTION_LIMIT + 1), FULL_DESCRIPTION, "x".repeat(1000)].map(
        (description) => ({
          description,
          length: [...description].length,
        }),
      ),
    )(
      "puts long prose behind a collapsed native disclosure (length $length)",
      async ({ description }) => {
        const card = cardIn(
          await renderCalendar(twin, [scanEvent({ description })], { view: "list" }),
        );
        expect(card).toMatch(/<details\b/);
        expect(card).not.toMatch(/<details\b[^>]*\bopen(?:[\s=>])/);
        const disclosure = card.match(/<details\b[^>]*>([\s\S]*?)<\/details>/)![1]!;
        expect(disclosure).toMatch(/<summary\b[^>]*>[\s\S]+?<\/summary>/);
        expect(disclosure).toContain(description);
        expect(card.split(description)).toHaveLength(2);
        // Structural participation and identity cannot disappear when collapsed.
        expect(disclosure).not.toMatch(/<h3\b|<time\b|data-testid="(?:signin|event-going-count)"/);
        expect(disclosure).not.toContain("Community lounge");
      },
    );

    it("counts emoji as code points at the boundary, not UTF-16 units", async () => {
      const short = cardIn(
        await renderCalendar(twin, [scanEvent({ description: "🧭".repeat(240) })], {
          view: "list",
        }),
      );
      expect(short).not.toMatch(/<details\b/);
      expect(short).toContain("🧭".repeat(240));
      const long = cardIn(
        await renderCalendar(twin, [scanEvent({ description: "🧭".repeat(241) })], {
          view: "list",
        }),
      );
      expect(long).toMatch(/<details\b/);
      expect(long).not.toContain("�");
      expect(long).toContain("🧭".repeat(241));
    });

    it("escapes hostile text in both the excerpt and full description", async () => {
      const attack = '<img data-scan-hostile="yes" src=x onerror="alert(1)">';
      const description = `${attack}${"safe & literal <words> ".repeat(30)}`;
      const card = cardIn(
        await renderCalendar(twin, [scanEvent({ description })], { view: "list" }),
      );
      expect(card).not.toContain("<img data-scan-hostile");
      expect(card).not.toContain("<words>");
      expect(card).toContain("&lt;img");
      expect(card).toContain("safe &amp; literal &lt;words&gt;");
      expect(card).toMatch(/<details\b/);
    });

    it("retains unknown-end Discord rows without inventing an end or local attendance", async () => {
      const row: DiscordTransient = {
        discordId: "123456789012345678",
        status: "scheduled",
        title: "Voice hangout",
        description: "Drop in whenever.",
        location: "Voice",
        startsAt: new Date("2030-06-02T06:30:00Z"),
        endsAt: null,
      };
      const html = await renderCalendar(twin, [row], { view: "list", zone: "America/Los_Angeles" });
      expect(html).toContain('id="event-discord-123456789012345678"');
      expect(html.match(/<time\b[^>]*datetime=/g)).toHaveLength(1);
      expect(html).toContain("23:30");
      expect(html).toContain("RSVP in Discord");
      expect(html).not.toContain('data-testid="event-going-count"');
    });

    it("uses the same threshold for a known-end Discord card", async () => {
      const row: DiscordTransient = {
        discordId: "123456789012345678",
        status: "active",
        title: "Voice hangout",
        description: FULL_DESCRIPTION,
        location: "Voice",
        startsAt: new Date("2030-06-01T23:30:00Z"),
        endsAt: new Date("2030-06-02T01:30:00Z"),
      };
      const card = cardIn(
        await renderCalendar(twin, [row], { view: "list", zone: "UTC" }),
        "discord-123456789012345678",
      );
      expect(card).toMatch(/<details\b/);
      expect(card.match(/<time\b[^>]*datetime=/g)).toHaveLength(2);
      expect(endRun(card)).toMatch(/(?:2\s+Jun|Jun\w*\s+2\b|2030-06-02)/);
      expect(card).toContain("RSVP in Discord");
    });
  });
}

it.each([false, true])(
  "disclosure leaves existing attendance and sign-in policy intact (member=%s)",
  (member) => {
    const card = cardHtml(scanEvent(), member);
    expect(card).toContain('data-testid="event-going-count"');
    expect(card).toContain("3 of 8 going");
    expect(card.includes('data-testid="signin"')).toBe(!member);
    expect(card).toContain(`id="event-${EVENT_KEY}"`);
  },
);
