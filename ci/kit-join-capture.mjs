// Capture actual Kit page components with synthetic data in the offline fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertJoinEvidence, joinEvidencePage, joinEvidenceStates } from "./kit-join-evidence.mjs";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const [state, destination, shell] = process.argv.slice(2);
if (!joinEvidenceStates.includes(state) || !destination || !["baseline", "ember"].includes(shell)) {
  throw new Error("usage: kit-join-capture.mjs <state> <destination> <baseline|ember>");
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sha, process.env.FINAL_SHA, "source is not the PR head");
const output = resolve(destination);
await mkdir(output, { recursive: true });
const manifest = { state, shell, sha, captures: [] };
await withKitOfflineBrowser({ page: joinEvidencePage(state) }, async ({ page }) => {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => document.fonts.ready);
    await assertJoinEvidence(page, state, shell);
    if (state !== "recovery") {
      const display = await page
        .locator(".ember-join")
        .evaluate((element) => getComputedStyle(element).display);
      assert.equal(
        display,
        viewport.name === "mobile" ? "block" : "grid",
        `${state}: responsive styles must load`,
      );
    }
    if (state !== "recovery" && viewport.name === "mobile") {
      const lede = await page.locator(".join-lede").boundingBox();
      const card = await page.locator(".join-card").boundingBox();
      const steps = await page.locator(".join-steps").boundingBox();
      assert.ok(lede && card && steps, `${state}: mobile sections must be visible`);
      assert.ok(lede.y + lede.height <= card.y, `${state}: card must follow the lede`);
      assert.ok(card.y + card.height <= steps.y, `${state}: steps must follow the card`);
    }
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(metrics.scrollWidth <= metrics.width, `${state}: horizontal overflow`);
    const name = `${state}-${viewport.name}.png`;
    const bytes = await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true });
    await writeFile(join(output, name), bytes);
    manifest.captures.push({
      viewport,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metrics,
    });
  }
});
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
