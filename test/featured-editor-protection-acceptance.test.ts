import { describe, expect, it } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages/featured-form";
import { featuredEditorDocument } from "./helpers/featured-editor-document";
import { savedForm } from "./helpers/featured-save-document";
import { APP_URL, CHECKED_AT, savedFeatured } from "./helpers/featured-saved-content-cases";
import { renderSavedKit, savedValues } from "./helpers/featured-saved-content-render";

const row = savedFeatured();
const restoredDraft = {
  title: "Unsent headline & a friend's idea",
  body: "Keep this private draft.\nBring chess ♟️, not the saved board games.",
  url: "https://example.test/draft?night=games&guests=2",
  image_url: "https://cdn.discordapp.com/attachments/1/2/draft.webp",
  image_alt: "Our unsent game-night photograph",
  position: "17",
  starts_at: "2034-05-22 18:30:00.123456",
  ends_at: "2034-05-22 21:30:00.654321",
};
const renderers = [
  {
    name: "Hono",
    render: async () =>
      String(
        await FeaturedFormPage({
          mode: "edit",
          row,
          values: savedValues(row),
          errors: {},
          baseline: "saved-entry-baseline",
          now: CHECKED_AT,
          appUrl: APP_URL,
        }),
      ),
  },
  { name: "compiled Kit", render: () => renderSavedKit(row) },
];

// Catches either missing renderer emission, reversed initialization, and removal of
// the history-restored draft/notice block. No input event arms the editor in these tests.
for (const renderer of renderers) {
  describe(`${renderer.name} rendered featured editor protection`, () => {
    it("emits deferred history before the editor and leaves a fresh unchanged form clean", async () => {
      const html = await renderer.render();
      const browser = featuredEditorDocument(html, { state: { routerState: "keep" } });
      expect(browser.editorScripts.map((script) => script.getAttribute("src"))).toEqual([
        "/islands/featured-edit-history.js",
        "/islands/admin-event-editor.js",
      ]);
      for (const script of browser.editorScripts) {
        expect(script.hasAttribute("defer")).toBe(true);
        expect(script.hasAttribute("async")).toBe(false);
      }
      expect(browser.values()).toEqual(savedForm(html).fields);
      expect(browser.editor.hasAttribute("data-event-draft")).toBe(false);
      expect(browser.querySelector('[data-testid="featured-history-restored"]')).toBeNull();
      expect(browser.depart()).toMatchObject({ defaultPrevented: false, returnValue: undefined });
    });

    it.each([
      { navigation: "back_forward", pinned: true },
      { navigation: "reload", pinned: true },
      { navigation: "back_forward", pinned: false },
      { navigation: "reload", pinned: false },
    ] as const)(
      "$navigation protects a restored draft immediately (entry baseline pinned=$pinned)",
      async ({ navigation, pinned }) => {
        const html = await renderer.render();
        const baseline = savedForm(html).hidden.saved_baseline!;
        expect(baseline.length).toBeGreaterThan(0);
        // Equal server/entry baselines isolate order: a late history script cannot
        // accidentally get a dirty result just by changing the snapshot's hidden field.
        const browser = featuredEditorDocument(html, {
          navigation,
          state: pinned ? { twoFeaturedBaseline: baseline } : { legacyRouterState: "keep" },
          restoredValues: restoredDraft,
        });
        expect(browser.depart()).toMatchObject({ defaultPrevented: true, returnValue: "" });
        expect(browser.values()).toMatchObject({
          ...restoredDraft,
          saved_baseline: pinned ? baseline : "",
        });
        expect(browser.editor.hasAttribute("data-event-draft")).toBe(true);
        const notice = browser.querySelector('[data-testid="featured-history-restored"]');
        expect(notice?.getAttribute("role")).toBe("alert");
        expect(notice?.hasAttribute("hidden")).toBe(false);
        expect(notice?.textContent).toMatch(/restored from history/i);
        const review = notice?.querySelector("a");
        expect(review?.textContent).toMatch(/review the current version/i);
        expect(review?.getAttribute("href")).toBe("/admin/featured/41");
        expect(review?.getAttribute("aria-disabled")).not.toBe("true");
        expect(
          browser.querySelector('[data-testid="save-featured"]')?.hasAttribute("disabled"),
        ).toBe(false);
        expect(browser.submit().defaultPrevented).toBe(false);
        expect(browser.editor.getAttribute("aria-busy")).toBe("true");
        expect(browser.depart().defaultPrevented).toBe(false);
        expect(browser.values()).toMatchObject(restoredDraft);
      },
    );
  });
}
