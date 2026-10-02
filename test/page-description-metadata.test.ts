import { jsx } from "hono/jsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { Layout } from "../src/pages";

const APP_URL = "https://next.example.test";
const DEFAULT_DESCRIPTION = "Together We Own: a close-knit adult gaming community, founded 1998.";
const EVENT_DESCRIPTION = 'Bring <b>your board</b> & "friends". Don\'t miss it!';
const ESCAPED_DESCRIPTION = "Bring &lt;b&gt;your board&lt;/b&gt; &amp; &quot;friends&quot;. Don&#39;t miss it!";

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1, icsSequence: 1n, eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Chess night", game: "Chess",
    description: EVENT_DESCRIPTION, startsAt: start, endsAt: new Date("2030-01-10T22:00:00Z"), timezone: "UTC",
    location: "Voice channel", capacity: 10, status: "published", rsvpOpen: true, goingCount: 3,
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    agentGrantId: null, proofMarker: null, agentVersion: 1, createdBy: null,
    recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null,
    recurrenceIndex: null, createdAt: start, updatedAt: start, ...overrides,
  };
}

async function eventHead(overrides: Partial<PublicEvent> = {}) {
  const html = await jsx(EventPage, {
    e: event(overrides), neighbors: { previous: null, next: null }, related: [], appUrl: APP_URL, jsonLd: "{}",
  }).toString();
  return head(html);
}

function head(html: string) {
  const match = html.match(/<head>([\s\S]*?)<\/head>/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function expectDescriptions(html: string, description: string) {
  expect(html.match(/<meta name="description"[^>]*>/g)).toEqual([
    `<meta name="description" content="${description}"/>`,
  ]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("metadata renderer tests must remain local"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("page description metadata (hermetic renderers)", () => {
  it("uses the event description once, escaped identically to the existing social tags", async () => {
    const html = await eventHead();
    expectDescriptions(html, ESCAPED_DESCRIPTION);
    expect(html).toContain(`<meta property="og:description" content="${ESCAPED_DESCRIPTION}"/>`);
    expect(html).toContain(`<meta name="twitter:description" content="${ESCAPED_DESCRIPTION}"/>`);
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/e/${event().eventKey}"/>`);
    expect(html).toContain('<meta name="twitter:card" content="summary"/>');
    expect(html).not.toContain('<meta name="robots"');
  });

  it.each([undefined, null, ""])("retains the default when Layout receives %s", async (shareDescription) => {
    const html = head(await jsx(Layout, { title: "Default page", canonical: APP_URL, shareDescription }).toString());
    expectDescriptions(html, DEFAULT_DESCRIPTION);
    expect(html).not.toContain('property="og:description"');
    expect(html).not.toContain('name="twitter:description"');
  });

  it("uses a supplied description even without a canonical/social block", async () => {
    const html = head(await jsx(Layout, { title: "Local page", shareDescription: EVENT_DESCRIPTION }).toString());
    expectDescriptions(html, ESCAPED_DESCRIPTION);
    expect(html).not.toContain('property="og:description"');
    expect(html).not.toContain('name="twitter:description"');
  });

  it.each([null, ""])("preserves the event-specific fallback for description %s", async (description) => {
    const html = await eventHead({ description });
    expectDescriptions(html, "An event at Together We Own.");
    expect(html).toContain('property="og:description" content="An event at Together We Own."');
    expect(html).toContain('name="twitter:description" content="An event at Together We Own."');
  });

  it.each(["draft", "past"] as const)("preserves %s noindex alongside the supplied description", async (status) => {
    const html = await eventHead({ status });
    expectDescriptions(html, ESCAPED_DESCRIPTION);
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="noindex, nofollow"/>',
    ]);
    expect(html).toContain(`property="og:description" content="${ESCAPED_DESCRIPTION}"`);
    expect(html).toContain(`name="twitter:description" content="${ESCAPED_DESCRIPTION}"`);
  });
});
