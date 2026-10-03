import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventPage, EventsCalendarPage, PastEventsPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import type { CalendarState } from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const NOW = new Date("2030-01-10T20:00:00Z");
const ORIGINS = [APP_URL, `${APP_URL}/`, `${APP_URL}///`];

function metadata(html: string) {
  return {
    canonical: [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]),
    og: [...html.matchAll(/<meta property="og:url" content="([^"]+)"/g)].map((m) => m[1]),
  };
}

function expectMetadata(html: string, path: string) {
  const urls = metadata(html);
  expect(urls).toEqual({ canonical: [`${APP_URL}${path}`], og: [`${APP_URL}${path}`] });
  for (const url of [...urls.canonical, ...urls.og]) {
    expect(new URL(url!).origin).toBe(APP_URL);
    expect(new URL(url!).pathname).not.toContain("//");
  }
}

const event: PublicEvent = {
  id: 1,
  icsSequence: 1n,
  syncRevision: 1,
  syncedRevision: 0,
  eventKey: "chess-night",
  title: "Chess night",
  game: "Chess",
  description: null,
  startsAt: NOW,
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  rsvpOpen: true,
  goingCount: 0,
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: NOW,
  updatedAt: NOW,
};

// Render the real page shells directly: no DB, Discord, timers or network.
describe("event-list canonical origins", () => {
  const states: CalendarState[] = [
    { view: "list", month: "2030-01", q: "", past: false },
    { view: "list", month: "2030-01", q: "Chess & friends", past: true },
    { view: "calendar", month: "2030-01", q: "", past: false },
    { view: "calendar", month: "2030-02", q: "Chess & friends", past: true },
  ];

  it.each(states)("keeps $view/$month/q=$q/past=$past canonical at /events", async (state) => {
    const rendered = await Promise.all(
      ORIGINS.map((appUrl) =>
        jsx(EventsCalendarPage, {
          state,
          upcoming: [],
          past: [],
          zone: "UTC",
          now: NOW,
          emptyState: "never",
          discordFailed: false,
          member: false,
          inviteUrl: "https://discord.gg/fixture",
          appUrl,
        }).toString(),
      ),
    );
    for (const html of rendered) {
      expectMetadata(html, "/events");
      expect(html).not.toContain('name="robots"');
    }
    expect(rendered.map(metadata)).toEqual(rendered.map(() => metadata(rendered[0]!)));
  });

  it.each([1, 2, 12])("preserves archive page %i canonical, robots and pager", async (page) => {
    const rendered = await Promise.all(
      ORIGINS.map((appUrl) =>
        jsx(PastEventsPage, {
          rows: [{ ...event, status: "past" }],
          page,
          hasMore: true,
          totalPages: 13,
          appUrl,
        }).toString(),
      ),
    );
    const path = page === 1 ? "/events/past" : `/events/past?page=${page}`;
    for (const html of rendered) {
      expectMetadata(html, path);
      expect(html).toContain('name="robots" content="noindex, follow"');
      expect(html).toContain(`data-page="${page}"`);
      expect(html).toContain(`href="/events/past?page=${page + 1}">Older`);
      if (page > 1) {
        const newer = page === 2 ? "/events/past" : `/events/past?page=${page - 1}`;
        expect(html).toContain(`href="${newer}">Newer`);
      } else {
        expect(html).not.toContain(">Newer</a>");
        expect(html).not.toContain('/events/past?page=1"');
      }
    }
    expect(rendered.map(metadata)).toEqual(rendered.map(() => metadata(rendered[0]!)));
  });

  it.each(["published", "past"] as const)(
    "leaves %s event-detail canonicals unchanged",
    async (status) => {
      const rendered = await Promise.all(
        ORIGINS.map((appUrl) =>
          jsx(EventPage, {
            e: { ...event, status },
            neighbors: { previous: null, next: null },
            related: [],
            appUrl,
            jsonLd: "{}",
          }).toString(),
        ),
      );
      for (const html of rendered) {
        expectMetadata(html, "/e/chess-night");
        expect(html).toContain(`data-copy-link="${APP_URL}/e/chess-night"`);
        if (status === "past") expect(html).toContain('name="robots" content="noindex, nofollow"');
        else expect(html).not.toContain('name="robots"');
      }
      expect(rendered.map(metadata)).toEqual(rendered.map(() => metadata(rendered[0]!)));
    },
  );
});
