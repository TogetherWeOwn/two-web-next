// Builder-owned hardening around the Host/Join Markdown lines: the cases the
// Test Author acceptance file does not pin. Past-event Join parity with the
// HTML detail, and hostile bytes inside the stored join URL staying inert.
// Offline: pure builders plus a server-rendered HTML diff, no DATABASE_URL.
// Run: npx vitest run test/ai-friendly-md-host-join-hardening.test.ts
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { mdEvent, type MdEvent } from "../src/ai-friendly/md";

const APP_URL = "https://togetherweown.com";
const KEY = "01J0000000000000000000H57X";
const JOIN_URL = "https://meet.example.test/room-9";
const JOIN_TEXT = "Use the public lobby.";
const HOST_NAME = "Riley";

const mdRow = (o: Partial<MdEvent> = {}): MdEvent => ({
  eventKey: KEY,
  title: "Friday night Helldivers",
  game: "Helldivers",
  description: "Bring stims.",
  startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"),
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: null,
  goingCount: 7,
  goingOccupancy: 7,
  status: "published",
  ...o,
});

const publicRow = (o: Partial<PublicEvent> = {}): PublicEvent => ({
  id: 7,
  icsSequence: 4n,
  syncRevision: 1,
  syncedRevision: 0,
  eventKey: KEY,
  title: "Friday night Helldivers",
  description: "Bring stims.",
  game: "Helldivers",
  startsAt: new Date("2099-01-10T20:00:00Z"),
  endsAt: new Date("2099-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "Voice: General",
  capacity: 10,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2099-01-01T00:00:00Z"),
  organizer_name: null,
  join_url: null,
  join_instructions: null,
  goingCount: 3,
  goingOccupancy: 3,
  ...o,
});

const renderHtml = (e: PublicEvent): Promise<string> =>
  jsx(EventPage, {
    e,
    neighbors: { previous: null, next: null },
    related: [],
    appUrl: APP_URL,
    jsonLd: "{}",
  }).toString() as unknown as Promise<string>;

describe("Past detail hides Join on both sides", () => {
  const fields = {
    organizer_name: HOST_NAME,
    join_url: JOIN_URL,
    join_instructions: JOIN_TEXT,
  };

  it("markdown omits the Join line for past events but keeps Host", () => {
    const body = mdEvent(APP_URL, mdRow({ status: "past", ...fields }));
    expect(body).toContain(`- Host: ${HOST_NAME}`);
    expect(body).not.toContain("- Join:");
    expect(body).not.toContain(JOIN_URL);
    expect(body).not.toContain(JOIN_TEXT);
  });

  it("markdown keeps the Join line for published events (control)", () => {
    const body = mdEvent(APP_URL, mdRow({ status: "published", ...fields }));
    expect(body).toContain("- Join:");
    expect(body).toContain(JOIN_URL);
  });

  it("HTML hides the joining section for past events but keeps the host", async () => {
    const html = await renderHtml(publicRow({ status: "past", ...fields }));
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain(JOIN_URL);
    const live = await renderHtml(publicRow({ status: "published", ...fields }));
    expect(live).toContain('data-testid="event-join-details"');
  });
});

describe("Hostile bytes inside the stored join URL stay inert", () => {
  it("escapes markup in both copies of the URL", () => {
    const evil = "https://meet.example.test/<script>alert(1)</script>";
    const body = mdEvent(APP_URL, mdRow({ join_url: evil, join_instructions: null }));
    // Exact pin: every `<` in both the label and the destination copy carries
    // its `\` escape, so no tag, closer, or autolink node can open. A bare
    // `not.toContain("<script>")` cannot say this: the escaped `\<script>`
    // contains that substring.
    const escaped = "https://meet.example.test/\\<script>alert(1)\\</script>";
    expect(body.split("\n").find((l) => l.startsWith("- Join:"))).toBe(
      `- Join: \\[${escaped}\\](${escaped})`,
    );
  });

  it("folds newlines so the URL cannot inject a block", () => {
    const body = mdEvent(
      APP_URL,
      mdRow({ join_url: "https://meet.example.test/room\n# Evil heading" }),
    );
    expect(body.match(/^- Join: /gm)).toHaveLength(1);
    expect(body).not.toMatch(/^# Evil/m);
  });
});
