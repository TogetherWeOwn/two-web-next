// route-inventory: GET /e/:key
// Independent acceptance: both endpoints belong in SSR HTML, not only in
// JSON-LD, a calendar URL, an island, or an organizer's free-text description.
import { beforeAll, describe, expect, it } from "vitest";
import { eventIcs, googleCalendarUrl } from "../src/events/feeds";
import { scheduleCases } from "./fixtures/event-scheduled-range";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  scheduleOrigin,
  type KitRenderer,
} from "./helpers/event-scheduled-range";

let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});

function text(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function times(html: string) {
  return [...html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)].map((match) => ({
    instant: match[1]!.match(/\bdatetime="([^"]+)"/i)?.[1] ?? "",
    label: text(match[2]!),
    index: match.index,
  }));
}

function endpoint(html: string, iso: string) {
  const matches = times(html).filter((time) => Date.parse(time.instant) === Date.parse(iso));
  expect(matches, `one server-rendered <time datetime> for ${iso}`).toHaveLength(1);
  return matches[0]!;
}

function expectEndpoint(
  label: string,
  expected: (typeof scheduleCases)[number]["start" | "end"],
  iso: string,
  fallback: boolean,
) {
  if (fallback) {
    // Existing invalid-zone fallback is an ISO UTC instant, not local time
    // with the corrupt stored zone printed beside it.
    expect(label).toContain(iso);
  } else {
    expect(label).toMatch(
      new RegExp(`\\b0?${expected.day}\\s+${expected.month}[a-z]*\\s+${expected.year}\\b`, "i"),
    );
    expect(label).toContain(expected.clock);
    expect(label).toContain(expected.offset);
  }
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: complete scheduled range in server-rendered detail`, () => {
    for (const viewer of ["guest", "member"] as const) {
      it.each(scheduleCases)(`${viewer}: exposes the end instant for $name`, async (fixture) => {
        const { status, html } = await renderScheduledPage(
          twin,
          scheduledEvent(fixture),
          viewer,
          kit,
        );
        expect(status).toBe(200);
        const end = endpoint(html, fixture.endsAt);
        const start = endpoint(html, fixture.startsAt);
        expectEndpoint(start.label, fixture.start, fixture.startsAt, fixture.label === "UTC");
        expectEndpoint(end.label, fixture.end, fixture.endsAt, fixture.label === "UTC");
        const visible = text(html);
        expect(visible).toContain(fixture.label);
        expect(visible).not.toContain("Invalid/Timezone");
        expect(visible).toMatch(/\b(?:starts?|begins?)\b/i);
        expect(visible).toMatch(/\bends?\b/i);
        expect(start.index).toBeLessThan(end.index);
        if (viewer === "member") {
          const action = html.indexOf('data-testid="rsvp-going"');
          expect(action, "fixture has a real RSVP action").toBeGreaterThan(0);
          expect(end.index, "end is discoverable before the RSVP decision").toBeLessThan(action);
        }
      });
    }

    it.each(scheduleCases)(
      "positive control: retains the start information for $name",
      async (fixture) => {
        const { status, html } = await renderScheduledPage(
          twin,
          scheduledEvent(fixture),
          "guest",
          kit,
        );
        expect(status).toBe(200);
        const start = endpoint(html, fixture.startsAt);
        expectEndpoint(start.label, fixture.start, fixture.startsAt, fixture.label === "UTC");
        expect(text(html)).toContain(fixture.label);
      },
    );

    it.each(scheduleCases)("guest/member schedule agrees for $name", async (fixture) => {
      const row = scheduledEvent(fixture);
      const guest = await renderScheduledPage(twin, row, "guest", kit);
      const member = await renderScheduledPage(twin, row, "member", kit);
      const schedule = (html: string) =>
        [fixture.startsAt, fixture.endsAt].map((iso) => {
          const time = endpoint(html, iso);
          return { instant: Date.parse(time.instant), label: time.label };
        });
      expect(schedule(guest.html)).toEqual(schedule(member.html));
      expect(guest.html).not.toContain('data-testid="rsvp-going"');
      expect(member.html).toContain('data-testid="rsvp-going"');
    });

    it.each(["guest", "member"] as const)(
      "positive control: draft stays forbidden to %s",
      async (viewer) => {
        const result = await renderScheduledPage(
          twin,
          scheduledEvent(scheduleCases[0], { status: "draft" }),
          viewer,
          kit,
        );
        expect(result.status).toBe(403);
        expect(result.html).not.toContain("Community chess session");
      },
    );

    it("positive control: moderator draft remains readable, closed and noindex", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        scheduledEvent(scheduleCases[0], { status: "draft" }),
        "moderator",
        kit,
      );
      expect(status).toBe(200);
      expect(html).toContain('data-testid="event-draft"');
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(html).not.toContain('data-testid="rsvp-going"');
    });

    it.each(["guest", "member"] as const)(
      "positive control: cancelled remains 410 for %s",
      async (viewer) => {
        const { status, html } = await renderScheduledPage(
          twin,
          scheduledEvent(scheduleCases[0], { status: "cancelled" }),
          viewer,
          kit,
        );
        expect(status).toBe(410);
        expect(html).toContain('data-testid="event-cancelled"');
        expect(text(html)).toContain("Community chess session");
        expect(html).not.toMatch(
          /data-testid="(?:rsvp-going|waitlist-join|event-ics|event-google-calendar)"/,
        );
      },
    );

    it.each([
      { name: "one millisecond before", now: "2026-11-01T06:29:59.999Z", open: true },
      { name: "exactly at", now: "2026-11-01T06:30:00.000Z", open: false },
      { name: "one millisecond after", now: "2026-11-01T06:30:00.001Z", open: false },
    ])(
      "positive control: RSVP $name the UTC end during the repeated hour",
      async ({ now, open }) => {
        const { status, html } = await renderScheduledPage(
          twin,
          scheduledEvent(scheduleCases[5]),
          "member",
          kit,
          new Date(now),
        );
        expect(status).toBe(200);
        expect(html.includes('data-testid="rsvp-going"')).toBe(open);
        expect(html.includes('data-testid="rsvp-closed"')).toBe(!open);
      },
    );

    it("positive control: displaying a future range cannot reopen paused RSVPs", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        scheduledEvent(scheduleCases[0], { rsvpOpen: false }),
        "member",
        kit,
      );
      expect(status).toBe(200);
      expect(html).not.toContain('data-testid="rsvp-going"');
      expect(html).not.toContain('data-testid="waitlist-join"');
    });

    it("positive control: calendar links remain available independently of the visible schedule", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        scheduledEvent(scheduleCases[5]),
        "guest",
        kit,
      );
      expect(status).toBe(200);
      expect(html).toContain('data-testid="event-ics"');
      expect(html).toContain('data-testid="event-google-calendar"');
      expect(html).toContain("20261101T053000Z%2F20261101T063000Z");
    });
  });
}

it("positive control: calendar exports retain distinct UTC endpoints for a repeated host hour", () => {
  const row = scheduledEvent(scheduleCases[5]);
  const ics = eventIcs(row, scheduleOrigin);
  expect(ics).toContain("DTSTART:20261101T053000Z\r\n");
  expect(ics).toContain("DTEND:20261101T063000Z\r\n");
  expect(new URL(googleCalendarUrl(row)).searchParams.get("dates")).toBe(
    "20261101T053000Z/20261101T063000Z",
  );
});
