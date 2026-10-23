import { expect, test } from "@playwright/test";
import {
  TITLE_SUFFIX,
  compileTitleRenderers,
  titleFixture,
  titleMetadata,
  titleVectors,
} from "../test/helpers/discovery-page-title-acceptance.mjs";

// Titles are head-only: no desktop/mobile screenshot requirement. Test the
// actual browser DOM without starting a Worker, database, or network service.
test.use({ javaScriptEnabled: false });
let renderTitle: Awaited<ReturnType<typeof compileTitleRenderers>>;
test.beforeAll(async () => {
  renderTitle = await compileTitleRenderers();
});

for (const twin of ["Hono", "Kit"]) {
  for (const vector of titleVectors) {
    test(`${twin}: ${vector.name}`, async ({ page }) => {
      await page.route("**/*", (route) => route.abort());
      await page.setContent(await renderTitle(twin, vector.kind, titleFixture(vector)), {
        waitUntil: "domcontentloaded",
      });
      const expected = titleMetadata(vector);
      // Keep metadata checks first so a red title cannot hide a metadata regression.
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        expected.canonical,
      );
      if (expected.robots === null)
        await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      else
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          "content",
          expected.robots,
        );
      await expect(page.locator("title")).toHaveCount(1);
      await expect(page.locator("script").filter({ hasText: "x()" })).toHaveCount(0);
      // A raw </title> or double escaping changes the browser's decoded title.
      expect(await page.title()).toBe(`${vector.title}${TITLE_SUFFIX}`);
      expect(
        Array.from((await page.title()).slice(0, -TITLE_SUFFIX.length)).length,
      ).toBeLessThanOrEqual(70);
    });
  }
}
