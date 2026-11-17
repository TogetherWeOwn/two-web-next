// Capture the real home page with the independently reviewed offline fixture.
// Run from the workspace containing tooling, before and after checkouts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [state, destination] = process.argv.slice(2);
if (!state || !destination) throw new Error("usage: kit-home-capture.mjs <state> <destination>");
const tooling = resolve("tooling");
const { homeEvidencePage, homeEvidenceStates, assertHomeEvidence } = await import(
  pathToFileURL(resolve("after/ci/kit-home-evidence.mjs"))
);
const { withKitOfflineBrowser } = await import(
  pathToFileURL(join(tooling, "ci/kit-offline-browser.mjs"))
);
if (!homeEvidenceStates.includes(state)) throw new Error(`Unknown state: ${state}`);

const output = resolve(destination);
await mkdir(output, { recursive: true });
const gitSha = (dir) =>
  execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const manifest = { state, tooling: gitSha(tooling), captures: [], errors: [] };
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

for (const tree of ["before", "after"]) {
  const source = resolve(tree);
  const sha = gitSha(source);
  try {
    if (tree === "after") assert.equal(sha, process.env.FINAL_SHA, "after is not the PR head");
    await withKitOfflineBrowser(
      { source, page: homeEvidencePage(state), now: Date.UTC(2026, 9, 20, 12) },
      async ({ page }) => {
        for (const viewport of viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          const fontLoaded = await page.evaluate(async () => {
            const regular = await document.fonts.load('400 16px "Mona Sans"');
            const bold = await document.fonts.load('700 48px "Mona Sans"');
            await document.fonts.ready;
            return [regular, bold].every(
              (faces) =>
                faces.length > 0 &&
                faces.every((face) => face.status === "loaded" && face.family === "Mona Sans"),
            );
          });
          const name = `${tree}-${state}-${viewport.name}.png`;
          const bytes = await page.screenshot({ animations: "disabled", caret: "hide" });
          await writeFile(join(output, name), bytes);
          const metrics = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            font: getComputedStyle(document.querySelector("#home-heading")).fontFamily,
            fontAvailable: document.fonts.check('700 48px "Mona Sans"'),
          }));
          manifest.captures.push({
            tree,
            sha,
            viewport,
            name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            metrics: { ...metrics, fontLoaded },
          });
          if (tree === "after") {
            await assertHomeEvidence(page, state);
            assert.ok(metrics.scrollWidth <= metrics.width, `${state}: horizontal overflow`);
            assert.equal(metrics.font.split(",")[0].replaceAll('"', "").trim(), "Mona Sans");
            assert.ok(fontLoaded && metrics.fontAvailable, `${state}: heading font did not load`);
          }
        }
      },
    );
  } catch (error) {
    manifest.errors.push(`${tree}: ${error.message}`);
  }
}
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (manifest.errors.length || manifest.captures.length !== 4) {
  console.error(JSON.stringify(manifest.errors));
  process.exitCode = 1;
}
