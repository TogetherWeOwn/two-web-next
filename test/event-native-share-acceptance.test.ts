// route-inventory: GET /e/:key
// Test-author owned: consume unchanged; request corrections from the acceptance author.
// Missing native controls fail RED; existing fallbacks and visibility fences are controls.
// Runtime/keyboard counterpart: node --import tsx --test ci/event-native-share-browser.test.mjs
import { describe, expect, it } from "vitest";
import {
  nativeShareButtonMarkup,
  nativeShareFixture,
  PRIVATE_NAME,
  SHARE_CANONICAL,
  SHARE_KEY,
  SHARE_VIEWS,
} from "./fixtures/event-native-share";

describe("native Share SSR recognizer controls", () => {
  it.each([
    '<button type="button" hidden>Share event</button>',
    '<button type="button" hidden aria-label="Share"><svg></svg></button>',
    '<span id="share-name">Share this event</span><button hidden aria-labelledby="share-name"><svg></svg></button>',
    '<span id="verb">Share</span><span id="object">event</span><button hidden aria-labelledby="verb object" aria-label="Other"></button>',
    "<button hidden><!-- decorative --><span>Share</span> event</button>",
  ])("recognizes the accessible Share name in %s", (html) => {
    expect(nativeShareButtonMarkup(html)).toHaveLength(1);
  });

  it.each([
    '<button aria-label="Copy link">Share</button>',
    '<span id="copy-name">Copy link</span><button aria-labelledby="copy-name">Share</button>',
    "<button><!-- Share --><svg></svg></button>",
  ])("does not mistake another accessible name for Share in %s", (html) => {
    expect(nativeShareButtonMarkup(html)).toEqual([]);
  });
});

for (const view of SHARE_VIEWS) {
  describe(`${view} native event sharing server acceptance`, () => {
    it.each(["guest", "member"] as const)(
      "%s receives one initially hidden native button separate from Copy link",
      async (viewer) => {
        // Catches exposing a dead no-JS button, replacing Copy link, or adding only one renderer.
        const { html, status } = await nativeShareFixture(view, { viewer });
        expect(status).toBe(200);
        expect(
          html.includes(PRIVATE_NAME),
          "the member fixture must really carry private chrome/attendees",
        ).toBe(viewer === "member");
        const buttons = nativeShareButtonMarkup(html);
        expect(buttons, "missing progressively enhanced native Share button").toHaveLength(1);
        const opening = buttons[0]!.slice(0, buttons[0]!.indexOf(">") + 1);
        expect(opening).toMatch(/\btype="button"/);
        expect(opening).toMatch(/\shidden(?:[\s=>])/);
        const copy = html.match(/<a\b[^>]*\sdata-copy-link="[^"]*"[^>]*>/)?.[0];
        expect(copy).toContain(`href="${SHARE_CANONICAL}"`);
        expect(copy).toContain(`data-copy-link="${SHARE_CANONICAL}"`);
      },
    );

    it("CONTROL: no-JS copy and both calendar destinations retain their existing public URLs", async () => {
      const { html, status } = await nativeShareFixture(view);
      expect(status).toBe(200);
      expect(html).toContain(`rel="canonical" href="${SHARE_CANONICAL}"`);
      const copy = html.match(/<a\b[^>]*\sdata-copy-link="[^"]*"[^>]*>/)?.[0];
      expect(copy).toContain(`href="${SHARE_CANONICAL}"`);
      expect(copy).toContain(`data-copy-link="${SHARE_CANONICAL}"`);
      expect(html).toContain(`href="/events/${SHARE_KEY}.ics"`);
      expect(html).toContain('data-testid="event-google-calendar"');
      expect(html).toContain("https://calendar.google.com/calendar/render?");
      expect(html).toContain('data-testid="event-copy-toast"');
      expect(html).toContain("/islands/copy-link.js");
    });

    it.each([
      {
        label: "moderator draft",
        options: { viewer: "moderator" as const, status: "draft" },
        status: 200,
      },
      { label: "cancelled event", options: { status: "cancelled" }, status: 410 },
      { label: "missing event", options: { missing: true }, status: 404 },
    ])("CONTROL: $label has no native Share control", async (scenario) => {
      const { html, status } = await nativeShareFixture(view, scenario.options);
      expect(status).toBe(scenario.status);
      if (scenario.options.status === "draft") expect(html).toContain('data-testid="event-draft"');
      expect(nativeShareButtonMarkup(html)).toEqual([]);
    });
  });
}
