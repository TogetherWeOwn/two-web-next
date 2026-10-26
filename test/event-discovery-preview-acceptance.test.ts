// Independent failing-first contract. Builder keeps this file unchanged.
// Run: npx vitest run test/event-discovery-preview-acceptance.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail } from "../src/events/kit-detail";
import { EventPage } from "../src/events/pages-detail";
import type { EventLink, PublicEvent } from "../src/events/reads";
import { adjacentEvent, type DetailTwin } from "./helpers/event-adjacent-preview";
import { renderSeriesDetail } from "./helpers/event-series-context-render";

const NOW = new Date("2026-11-01T18:00:00.000Z");
const event = adjacentEvent(20, {
  title: "Current night",
  game: "Current game, not the destination game",
  startsAt: new Date("2026-11-08T18:00:00.000Z"),
  endsAt: new Date("2026-11-08T20:00:00.000Z"),
});
type Preview = EventLink & Pick<PublicEvent, "game" | "endsAt" | "rsvpOpen">;
function destination(overrides: Partial<Preview> = {}): Preview {
  return {
    id: 10,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    title: "Destination night",
    startsAt: new Date("2026-11-02T18:00:00.000Z"),
    endsAt: new Date("2026-11-02T20:00:00.000Z"),
    timezone: "UTC",
    location: "Destination room",
    game: "Tabletop & tactics",
    rsvpOpen: true,
    ...overrides,
  };
}

// Only persistence is replaced. Both real renderers and Kit's real model
// conversion must propagate each destination's metadata, not the current row's.
async function render(twin: DetailTwin, preview: Preview): Promise<string> {
  const neighbors = { previous: preview, next: preview };
  const series = { hosts: [], ...neighbors };
  const related = [preview];
  const appUrl = "https://example.test";
  if (twin === "Hono") {
    return String(await EventPage({ e: event, neighbors, series, related, appUrl, jsonLd: "{}" }));
  }
  const outcome = await resolveKitEventDetail({
    key: event.eventKey,
    search: "",
    path: `/e/${event.eventKey}`,
    env: { APP_URL: appUrl } as Env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: {
      dbForFn: async () => ({}) as Db,
      getEventFn: async () => event,
      neighborsFn: async () => neighbors,
      seriesFn: async () => series,
      relatedFn: async () => related,
      attendeesFn: async () => [],
      viewerRsvpFn: async () => null,
      waitlistFn: async () => null,
      suggestionsFn: async () => [],
    },
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error(`Expected ok, got ${outcome.kind}`);
  return renderSeriesDetail(outcome.model as unknown as Record<string, unknown>);
}

function anchor(html: string, testid: string): { tag: string; body: string; text: string } {
  const match = html.match(
    new RegExp(`(<a\\b[^>]*data-testid="${testid}"[^>]*>)([\\s\\S]*?)<\\/a>`),
  );
  expect(match, `missing destination link ${testid}`).not.toBeNull();
  const body = match![2]!;
  // Strip comments to a fixpoint: one global pass can leave a re-formed
  // comment behind, which CodeQL flags as incomplete sanitization.
  let stripped = body;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, "");
  } while (previous !== stripped);
  return {
    tag: match![1]!,
    body,
    text: stripped
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

const rails = [
  { testid: "event-series-previous", label: "Previous in series: Destination night", rel: "prev" },
  { testid: "event-series-next", label: "Next in series: Destination night", rel: "next" },
  { testid: "event-previous", label: "Previous event: Destination night", rel: "prev" },
  { testid: "event-next", label: "Next event: Destination night", rel: "next" },
  { testid: "event-related-link", label: "Destination night", rel: null },
];

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} event-detail discovery preview acceptance`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    describe.each(rails)("$testid", ({ testid, label, rel }) => {
      it("RED: shows the destination game rather than the current event's game", async () => {
        const link = anchor(await render(twin, destination()), testid);
        expect(link.text).toContain("Tabletop &amp; tactics");
        expect(link.text).not.toContain("Current game");
      });

      it.each([null, ""])(
        "CONTROL: omits an unset game (%s) without an empty slot",
        async (game) => {
          const link = anchor(await render(twin, destination({ game })), testid);
          const text = link.text.replace(/[←→]/g, "").replace(/\s+/g, " ").trim();
          expect(text).toBe(`${label} Monday, 2 November 2026 at 18:00 GMT+00:00 Destination room`);
          expect(link.body).not.toMatch(/<(?:span|p)\b[^>]*>\s*<\/(?:span|p)>/);
        },
      );

      it("RED: marks paused destinations without advertising seats or fullness", async () => {
        const link = anchor(await render(twin, destination({ rsvpOpen: false })), testid);
        expect(link.text).toContain("RSVPs paused");
        expect(link.text).not.toMatch(/\b(?:Full|\d+ seats? left|No seat limit|\d+ going)\b/);
      });

      it("CONTROL: leaves open upcoming destinations unmarked", async () => {
        const link = anchor(await render(twin, destination()), testid);
        expect(link.text).not.toMatch(/RSVPs paused|Ended|Past event/i);
        expect(link.text).not.toMatch(/\b(?:Full|\d+ seats? left|No seat limit|\d+ going)\b/);
      });

      it.each([
        { name: "already ended", end: "2026-11-01T17:59:59.999Z" },
        { name: "ends exactly now", end: "2026-11-01T18:00:00.000Z" },
      ])("RED: marks a destination that $name", async ({ end }) => {
        const link = anchor(
          await render(
            twin,
            destination({
              startsAt: new Date("2026-11-01T16:00:00.000Z"),
              endsAt: new Date(end),
            }),
          ),
          testid,
        );
        expect(link.text).toMatch(/\b(?:Ended|Past event)\b/i);
      });

      it("CONTROL: a started but ongoing destination is not ended", async () => {
        const link = anchor(
          await render(twin, destination({ startsAt: new Date("2026-11-01T17:00:00.000Z") })),
          testid,
        );
        expect(link.text).not.toMatch(/\b(?:Ended|Past event)\b/i);
      });

      it("CONTROL: preserves destination title, host-zone time, location and href", async () => {
        const link = anchor(
          await render(twin, destination({ timezone: "America/New_York" })),
          testid,
        );
        expect(link.tag).toContain('href="/e/01ARZ3NDEKTSV4RRFFQ69G5FAA"');
        if (rel) expect(link.tag).toContain(`rel="${rel}"`);
        expect(link.text).toContain(label);
        expect(link.body).toContain('datetime="2026-11-02T18:00:00.000Z"');
        expect(link.text).toContain("Monday, 2 November 2026 at 13:00 GMT-05:00");
        expect(link.text).toContain("Destination room");
        expect(link.text).not.toContain("Current event lobby");
      });

      it("CONTROL: does not invent a missing location", async () => {
        const link = anchor(
          await render(twin, destination({ game: null, location: null })),
          testid,
        );
        expect(link.text.replace(/[←→]/g, "").replace(/\s+/g, " ").trim()).toBe(
          `${label} Monday, 2 November 2026 at 18:00 GMT+00:00`,
        );
        expect(link.body).not.toContain("event-related-location");
      });

      it("RED: renders a hostile game as text, never as markup", async () => {
        const link = anchor(
          await render(twin, destination({ game: '<img src=x onerror="alert(1)"> & friends' })),
          testid,
        );
        expect(link.text).toContain("&lt;img");
        expect(link.text).toContain("&amp; friends");
        expect(link.body).not.toMatch(/<(?:img|script)\b/i);
      });
    });
  });
}
