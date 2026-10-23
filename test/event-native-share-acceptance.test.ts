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
        expect(html).toMatch(
          new RegExp(`<a[^>]*href="${SHARE_CANONICAL}"[^>]*data-copy-link="${SHARE_CANONICAL}"`),
        );
      },
    );

    it("CONTROL: no-JS copy and both calendar destinations retain their existing public URLs", async () => {
      const { html, status } = await nativeShareFixture(view);
      expect(status).toBe(200);
      expect(html).toContain(`rel="canonical" href="${SHARE_CANONICAL}"`);
      expect(html).toContain(`data-copy-link="${SHARE_CANONICAL}"`);
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
