// TOG-11225: APP_URL is an unconstrained binding; a configured trailing slash
// must produce the same feed URLs as the bare origin — never a doubled `//`
// pathname. seo.ts already normalizes this edge for canonicals/sitemap/robots;
// these tests pin the same contract on the calendar/RSS builders.
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { eventIcs, eventsIcsCollection, eventsRss, feedUrl, webcalUrl } from "../src/events/feeds";

const BARE = "https://next.example.test";
const SLASHED = "https://next.example.test/";
const KEY = "01J0000000000000000000ABCD";

const row = (o: Partial<typeof events.$inferSelect> = {}) =>
  ({
    id: 1,
    eventKey: KEY,
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    icsSequence: 1782907200n,
    ...o,
  }) as typeof events.$inferSelect;

describe("feed URL base normalization", () => {
  it("bare and trailing-slash APP_URL emit identical ICS bytes (URL + UID)", () => {
    const bare = eventIcs(row(), BARE);
    expect(eventIcs(row(), SLASHED)).toBe(bare);
    expect(bare).toContain(`URL:${BARE}/e/${KEY}`);
    expect(bare).toContain(`UID:${KEY}@next.example.test`);
    expect(bare).not.toContain(`URL:${BARE}//`);
    expect(eventsIcsCollection([row()], SLASHED)).toBe(eventsIcsCollection([row()], BARE));
  });

  it("RSS channel, atom self-link, item link and guid never carry a doubled slash", () => {
    const lastBuild = new Date("2026-07-01T12:00:00Z");
    const bare = eventsRss([row()], BARE, lastBuild);
    const slashed = eventsRss([row()], SLASHED, lastBuild);
    expect(slashed).toBe(bare);
    expect(bare).toContain(`<link>${BARE}/events</link>`);
    expect(bare).toContain(`<atom:link href="${BARE}/events.rss"`);
    expect(bare).toContain(`<link>${BARE}/e/${KEY}</link>`);
    expect(bare).toContain(`<guid isPermaLink="true">${BARE}/e/${KEY}</guid>`);
    expect(bare).not.toContain("//events");
    expect(bare).not.toContain("//e/");
  });

  it("feed and webcal URLs strip the trailing slash before the scheme swap", () => {
    expect(feedUrl(SLASHED)).toBe(feedUrl(BARE));
    expect(feedUrl(SLASHED)).toBe(`${BARE}/events.ics`);
    expect(webcalUrl(SLASHED)).toBe("webcal://next.example.test/events.ics");
    expect(webcalUrl(SLASHED)).toBe(webcalUrl(BARE));
  });

  it("keeps a path-bearing APP_URL intact except for its trailing slash", () => {
    expect(feedUrl("https://next.example.test/app/")).toBe("https://next.example.test/app/events.ics");
    expect(eventIcs(row(), "https://next.example.test/app/")).toContain(`URL:https://next.example.test/app/e/${KEY}`);
  });
});
