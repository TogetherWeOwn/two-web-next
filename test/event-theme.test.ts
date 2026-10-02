import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventGonePage, EventPage, PastEventsPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import type { Session } from "../src/env";
import { Layout } from "../src/pages";

const start = new Date("2030-01-10T20:00:00Z");
const e: PublicEvent = {
  id: 1,
  icsSequence: 1n,
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: "Chess night",
  game: "Chess",
  description: "Bring a friend & a board.",
  startsAt: start,
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "Voice lobby",
  capacity: 10,
  status: "published",
  rsvpOpen: true,
  goingCount: 3,
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
  createdAt: start,
  updatedAt: start,
  syncRevision: 1,
  syncedRevision: 0,
};
const props = {
  e,
  neighbors: { previous: null, next: null },
  related: [],
  appUrl: "https://next.example.test",
  jsonLd: '{"@type":"Event"}',
};
const session: Session = {
  id: "fixture",
  username: "Player <script>",
  avatar: null,
  member: true,
  moderator: false,
};
const render = (overrides = {}) => EventPage({ ...props, ...overrides })!.toString();

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("theme tests must remain offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("event detail theme", () => {
  it("reuses base assets and scopes the match overview to detail pages", () => {
    const html = render();
    expect(html).toContain('<body class="base-theme event-theme">');
    expect(html).toContain('href="/theme.css"');
    expect(html).toContain('href="/event-theme.css"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    expect(html).toContain('class="event-hero"');
    expect(html).toContain('<dl class="event-meta" aria-label="Event details">');
    expect(html).toContain('href="/events" aria-current="location"');
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(Layout({ title: "Fixture" })!.toString()).not.toContain("/theme.css");
    for (const leaf of [
      Layout({ title: "Fixture" }),
      PastEventsPage({ rows: [], page: 1, hasMore: false, totalPages: 1, appUrl: props.appUrl }),
    ]) {
      expect(leaf!.toString()).not.toContain("/event-theme.css");
    }
  });

  it("keeps guest entry points, sharing and island mounts", () => {
    const html = render();
    expect(html).toContain(
      `href="/auth/discord?next=${encodeURIComponent(`/e/${e.eventKey}`)}" data-testid="signin"`,
    );
    expect(html).toContain(`href="/join?next=${encodeURIComponent(`/e/${e.eventKey}`)}"`);
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain('data-island="going-count"');
    expect(html).toContain('data-testid="event-copy-toast" data-copy-toast');
    expect(html).toContain('src="/islands/copy-link.js" defer');
    expect(html).toContain('src="/islands/going-count.js" defer');
    expect(html).toContain(`<script type="application/ld+json">${props.jsonLd}</script>`);
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).toMatch(/<\/dl><div class="event-rsvp"><section data-island="rsvp-button"/);
    expect(html).toContain('src="/islands/rsvp-button.js" defer');
    expect(html).not.toContain("data-action");
  });

  it.each([null, 2])(
    "preserves signed-in and waitlist state while RSVP actions stay member-only (%s)",
    (waitlistPosition) => {
      const html = render({ session, waitlistPosition });
      expect(html).toContain('<form method="post" action="/logout">');
      expect(html).toContain("Player &lt;script&gt;");
      expect(html).toContain(`data-waitlist-position="${waitlistPosition ?? ""}"`);
      expect(html).not.toContain('data-testid="signin"');
      expect(html).not.toContain('data-testid="event-join-pitch"');
      expect(html).toContain('data-island="rsvp-button"');
      expect(html).not.toContain("data-action");
    },
  );

  it("keeps attendee links escaped and decorative initials out of their accessible names", () => {
    const html = render({ session, attendees: [{ id: "member/id", name: "<Player> & friend" }] });
    expect(html).toContain('<ul class="event-attendee-grid">');
    expect(html).toContain('<span class="event-attendee-mark" aria-hidden="true">&lt;</span>');
    expect(html).toContain('<a href="/members/member%2Fid">&lt;Player&gt; &amp; friend</a>');
    expect(html).not.toContain('src="https://');
  });

  it("leaves discovery empty when no real neighbor or related data exists", () => {
    const html = render();
    expect(html).toContain('<div class="event-discovery"></div>');
    expect(html).not.toContain('data-testid="event-pagination"');
    expect(html).not.toContain('data-testid="event-related"');
  });

  it("gives the cancelled state the same chrome without session, sharing or RSVP actions", () => {
    const jsonLd = '{"eventStatus":"https://schema.org/EventCancelled"}';
    const html = EventGonePage({ e: { ...e, status: "cancelled" }, jsonLd })!.toString();
    expect(html).toContain('href="/event-theme.css"');
    expect(html).toContain('class="event-hero event-gone"');
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain("<h1>Chess night</h1>");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain(`<script type="application/ld+json">${jsonLd}</script>`);
    expect(html).toContain('href="/events">See upcoming events');
    expect(html).toContain('<div class="event-rsvp"><section data-island="rsvp-button"');
    expect(html).toContain('data-testid="rsvp-closed">Cancelled');
    for (const absent of [
      'rel="canonical"',
      'property="og:',
      'name="twitter:',
      "/islands/copy-link",
      "/islands/going-count",
      "data-action",
      'data-testid="signin"',
      "/logout",
      "event-attendee-grid",
      "event-join-pitch",
    ]) {
      expect(html).not.toContain(absent);
    }
  });

  it("keeps event CSS compact, external and responsive without new art or dependencies", () => {
    const css = readFileSync(new URL("../public/event-theme.css", import.meta.url), "utf8");
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-height: 44px");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
    expect(css.length).toBeLessThan(6000);
  });
});
