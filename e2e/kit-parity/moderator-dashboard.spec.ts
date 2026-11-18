import { PARITY_VIEWPORTS, parityTargets } from "../kit-parity";
import { moderatorTest as test, withModeratorFixture } from "./moderator-fixture";

// Comparison captures, not visual baselines or replacements for existing axe gates.
for (const { name } of parityTargets()) {
  for (const viewport of PARITY_VIEWPORTS) {
    test(`${name} moderator dashboard at ${viewport.size.width}×${viewport.size.height}`, async ({
      browser,
    }) => {
      await withModeratorFixture(browser, name, viewport.size, async ({ navigate, capture }) => {
        await navigate("/admin", 200, "Moderation");
        await capture("dashboard");
      });
    });
  }
}
