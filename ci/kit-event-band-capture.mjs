// Non-shipping capture of the real Kit route using the existing offline fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homeEvidencePage } from "./kit-home-evidence.mjs";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const [state, destination] = process.argv.slice(2);
const states = [
  "guest-populated",
  "member-populated",
  "guest-empty",
  "member-empty",
  "guest-unavailable",
  "member-unavailable",
  "session-outage",
];
if (!states.includes(state) || !destination)
  throw new Error("Unknown state or missing destination");
const output = resolve(destination);
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = (path) =>
  execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const populated = state.endsWith("-populated");
const fixture = homeEvidencePage(
  state.startsWith("member-") ? "member" : state === "session-outage" ? "sessionOutage" : "guest",
).replace(
  "data.homeCopy =",
  `data.eventsUnavailable = ${state.endsWith("-unavailable")};
data.upcomingEvents = ${
    populated
      ? `[
  { source: "canonical", eventKey: "game-night", title: "A Very Long Game Night Title for Friends Across Many Different Worlds", startsAt: new Date("2026-10-20T19:00:00Z"), timezone: "Europe/London", location: "Online", goingCount: 4, capacity: 12 },
  { source: "discord", discordId: "123456789012345678", title: "Community tabletop evening", startsAt: new Date("2026-10-22T18:00:00Z"), timezone: "UTC", location: "Discord" }
]`
      : "[]"
  };
data.homeCopy =`,
);
const manifest = {
  state,
  tooling: sha("tooling"),
  before: sha("before"),
  after: sha("after"),
  captures: [],
  errors: [],
};
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
try {
  for (const [key, expected] of [
    ["tooling", process.env.TOOLING_SHA],
    ["before", process.env.BEFORE_SHA],
    ["after", process.env.AFTER_SHA],
  ]) {
    assert.equal(manifest[key], expected, `${key} checkout mismatch`);
  }
  for (const tree of ["before", "after"]) {
    try {
      await withKitOfflineBrowser(
        { source: resolve(tree), page: fixture, now: Date.UTC(2026, 9, 20, 12) },
        async ({ page }) => {
          const css = await page.evaluate(async () =>
            Promise.all(
              [...document.querySelectorAll('link[rel="stylesheet"]')].map(async (link) => {
                const response = await fetch(link.href);
                if (!response.ok) throw new Error(`Stylesheet request failed: ${response.status}`);
                return { url: link.href, text: await response.text() };
              }),
            ),
          );
          const stylesheets = css.map(({ url, text }) => ({
            url,
            sha256: hash(text),
            bytes: Buffer.byteLength(text),
          }));
          for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.evaluate(async () => {
              await document.fonts.load('400 16px "Mona Sans"');
              await document.fonts.load('700 48px "Mona Sans"');
              await document.fonts.ready;
            });
            const band = page.locator('section[aria-labelledby="home-events-heading"]');
            assert.equal(await band.count(), 1, `${tree} ${state}: band missing`);
            if (populated) {
              assert.equal(
                await band.locator(".home-event-link").count(),
                2,
                `${tree} ${state}: event rows missing`,
              );
              assert.equal(await band.locator('.home-event-link[href="/e/game-night"]').count(), 1);
              assert.equal(
                await band.locator('.home-event-link[href="https://discord.gg/invite"]').count(),
                1,
              );
              assert.ok(
                (await band.locator(".home-events-group").count()) > 0,
                "event groups missing",
              );
            } else {
              assert.equal(
                await band.getByTestId("home-events-empty").getAttribute("data-state"),
                state.endsWith("-unavailable") ? "unavailable" : "empty",
              );
            }
            const metrics = await page.evaluate(() => {
              const band = document.querySelector('section[aria-labelledby="home-events-heading"]');
              const style = (node) => {
                if (!node) return null;
                const s = getComputedStyle(node);
                const r = node.getBoundingClientRect();
                return {
                  fontFamily: s.fontFamily,
                  fontSize: s.fontSize,
                  fontWeight: s.fontWeight,
                  lineHeight: s.lineHeight,
                  gridTemplateColumns: s.gridTemplateColumns,
                  columnGap: s.columnGap,
                  rowGap: s.rowGap,
                  padding: s.padding,
                  height: r.height,
                };
              };
              const root = getComputedStyle(document.documentElement);
              const tokens = {};
              for (const sheet of document.styleSheets) {
                for (const rule of sheet.cssRules) {
                  if (rule.style)
                    for (const name of rule.style)
                      if (name.startsWith("--")) tokens[name] = root.getPropertyValue(name).trim();
                }
              }
              const rows = [...band.querySelectorAll(".home-event-link")].map((row) => ({
                row: style(row),
                title: style(row.querySelector("h3")),
                time: style(row.querySelector("time")),
                metadata: [...row.querySelectorAll(".event-meta p")].map(style),
              }));
              return {
                width: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                band: style(band),
                rows,
                tokens,
                fontLoaded: document.fonts.check('700 48px "Mona Sans"'),
              };
            });
            assert.ok(
              metrics.scrollWidth <= metrics.width,
              `${tree} ${state}: horizontal overflow`,
            );
            assert.ok(metrics.fontLoaded, `${tree} ${state}: font unavailable`);
            if (populated)
              for (const row of metrics.rows)
                assert.ok(
                  row.title?.fontFamily && row.time?.fontFamily && row.metadata.length,
                  "event styles missing",
                );
            assert.ok(
              stylesheets.length && stylesheets.every((asset) => asset.bytes > 0),
              "compiled stylesheet missing",
            );
            for (const [kind, capture] of [
              [
                "page",
                () => page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }),
              ],
              ["band", () => band.screenshot({ animations: "disabled", caret: "hide" })],
            ]) {
              const bytes = await capture();
              assert.ok(bytes.length > 0, "empty screenshot");
              const name = `${tree}-${state}-${viewport.name}-${kind}.png`;
              await writeFile(join(output, name), bytes);
              manifest.captures.push({
                tree,
                sha: manifest[tree],
                viewport,
                kind,
                name,
                sha256: hash(bytes),
                stylesheets: [...stylesheets],
                metrics,
              });
            }
          }
        },
      );
    } catch (error) {
      manifest.errors.push({ tree, message: error.stack ?? String(error) });
    }
  }
} catch (error) {
  manifest.errors.push({ message: error.stack ?? String(error) });
}
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (manifest.errors.length || manifest.captures.length !== 8) {
  console.error(JSON.stringify(manifest.errors));
  process.exitCode = 1;
}
