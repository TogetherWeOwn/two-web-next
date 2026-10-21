// route-inventory: GET /events/past
// Builder-owned companion to test/discovery-search-scope-past-card-acceptance.test.ts
// (Test Author owned; never edited here). Pins the missing-location contract on
// the stripped TIME PARAGRAPH itself: the acceptance suite asserts the trailing
// separator against whole-card text that ends with the attendance span, so a
// dangling separator inside the time line survives it green on both twins.
// These tests fail if either twin renders an unconditional separator outside
// the location guard, or drops the venue separator entirely.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import {
  ARCHIVE_NOW,
  archiveReadFixture,
  archiveRow,
  archiveTwins,
  compileArchiveKit,
  type ArchiveTwin,
} from "./helpers/past-archive-search-acceptance";

const VENUE_KEY = "scope-past-venue";
const BARE_KEY = "scope-past-bare";
const PAST_TZ = "Europe/London";
const PAST_LOCATION = "The Brass Room";
const BARE_TZ = "America/New_York";

function venueRows() {
  return [
    archiveRow(201, {
      eventKey: VENUE_KEY,
      title: "Scope night with venue",
      timezone: PAST_TZ,
      location: PAST_LOCATION,
    }),
    archiveRow(202, {
      eventKey: BARE_KEY,
      title: "Scope night bare room",
      timezone: BARE_TZ,
      location: null,
    }),
  ];
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The <li> card block for one event key (same root on both twins).
function cardBlock(html: string, key: string): string {
  const anchor = html.indexOf(`data-event-key="${key}"`);
  expect(anchor, `card for ${key} is rendered`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<li", anchor), html.indexOf("</li>", anchor));
}

// First paragraph of the card: the time line on both twins.
function timeParagraph(card: string): string {
  const match = card.match(/<p>([\s\S]*?)<\/p>/);
  expect(match, "card carries a time paragraph").not.toBeNull();
  return match![1]!;
}

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
}, 60_000);
afterAll(() => kit?.dispose());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pastHtml(twin: ArchiveTwin): Promise<string> {
  const source = archiveReadFixture();
  source.replaceRows(venueRows());
  const url = "https://archive.example.test/events/past";
  const response =
    twin === "Hono"
      ? await app.request(new Request(url), {}, source.env)
      : await (async () => {
          const { dispatchPastArchiveRequest } = await import("../src/kit-past-events");
          return dispatchPastArchiveRequest(new Request(url), source.env, () =>
            kit.request(new Request(url), source.env),
          );
        })();
  expect(response.status).toBe(200);
  return response.text();
}

describe("past-card separator pinned on the time paragraph", () => {
  it.each(archiveTwins)(
    "bare time line ends with the zone and carries no separator on %s",
    async (twin: ArchiveTwin) => {
      const time = stripTags(timeParagraph(cardBlock(await pastHtml(twin), BARE_KEY)));
      expect(time).toContain(BARE_TZ);
      expect(time.endsWith(BARE_TZ), "no trailing separator after the zone").toBe(true);
      expect(time, "bare line carries no middot at all").not.toContain("·");
      expect(time).not.toMatch(/·\s*·/);
      expect(time).not.toMatch(/·\s*$/);
    },
  );

  it.each(archiveTwins)(
    "venue time line keeps one separator between zone and location on %s",
    async (twin: ArchiveTwin) => {
      const time = stripTags(timeParagraph(cardBlock(await pastHtml(twin), VENUE_KEY)));
      expect(time).toContain(PAST_TZ);
      expect(time).toContain(PAST_LOCATION);
      expect(time).toContain("·");
      expect(time.match(/·/g)).toHaveLength(1);
      expect(time.indexOf(PAST_TZ)).toBeLessThan(time.indexOf("·"));
      expect(time.indexOf("·")).toBeLessThan(time.indexOf(PAST_LOCATION));
    },
  );
});
