// Local SSR fixtures only: no server, database, guild, login or remote origin.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e event-scheduled-range.spec.ts --workers=1
// Also discovered by the normal CI *.spec.ts glob. No opt-in or skipped tests.
// Set SCHEDULE_SCREENSHOT_DIR to capture unmasked evidence for the builder to open.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "@playwright/test";
import { scheduleCases } from "../test/fixtures/event-scheduled-range";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  type KitRenderer,
} from "../test/helpers/event-scheduled-range";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");
let kit: KitRenderer;
let sharedCss: string;
let kitCss: { build: (candidates: string[]) => string };

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });
test.beforeAll(async () => {
  kit = await compileScheduleKit();
  sharedCss = ["styles.css", "theme.css", "event-theme.css"]
    .map((path) => readFileSync(join(root, "public", path), "utf8"))
    .join("\n");
  kitCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewer of ["guest", "member"] as const) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      for (const index of [3, 5, 6] as const) {
        const fixture = scheduleCases[index];
        test(`${twin} ${viewer} ${viewport.width}: ${fixture.name} without JavaScript`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          // Aborting all requests also fences stylesheet/font/image URLs; only
          // the actual local stylesheet bytes below enter the fixture document.
          await page.route("**/*", (route) => route.abort());
          const { status, html } = await renderScheduledPage(
            twin,
            scheduledEvent(fixture),
            viewer,
            kit,
          );
          expect(status).toBe(200);
          const candidates = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
            match[1]!.split(/\s+/),
          );
          const css =
            twin === "Kit" ? `${sharedCss}\n${kitCss.build(candidates)}\n${kit.css}` : sharedCss;
          expect(css).not.toContain("</style");
          await page.setContent(html.replace("</head>", `<style>${css}</style></head>`));
          if (process.env.SCHEDULE_SCREENSHOT_DIR) {
            mkdirSync(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({
              path: join(
                process.env.SCHEDULE_SCREENSHOT_DIR,
                `${twin}-${viewer}-${viewport.width}-${index}.png`,
              ),
              fullPage: true,
              animations: "disabled",
            });
          }

          const renderedTimes = page.locator("time[datetime]");
          for (const [name, iso, want] of [
            ["start", fixture.startsAt, fixture.start],
            ["end", fixture.endsAt, fixture.end],
          ] as const) {
            const position = await renderedTimes.evaluateAll(
              (nodes, instant) =>
                nodes.findIndex(
                  (node) => Date.parse(node.getAttribute("datetime") ?? "") === Date.parse(instant),
                ),
              iso,
            );
            expect(
              position,
              `${name} instant is present without JavaScript`,
            ).toBeGreaterThanOrEqual(0);
            const time = renderedTimes.nth(position);
            await expect(time).toBeVisible();
            await expect(time).toContainText(want.clock);
            if (fixture.label === "UTC") {
              await expect(time).toContainText(iso);
            } else {
              await expect(time).toContainText(want.offset);
              await expect(time).toContainText(want.year);
            }
            const box = await time.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
            if (name === "end" && viewer === "member") {
              const action = page.getByTestId("rsvp-going");
              await expect(action).toBeVisible();
              const precedesAction = await time.evaluate((element) => {
                const action = element.ownerDocument.querySelector('[data-testid="rsvp-going"]');
                return (
                  !!action &&
                  !!(element.compareDocumentPosition(action) & element.DOCUMENT_POSITION_FOLLOWING)
                );
              });
              expect(precedesAction, "read the schedule before the RSVP action").toBe(true);
            }
          }
          await expect(page.locator("body")).toContainText(fixture.label);
          await expect(page.locator("body")).not.toContainText("Invalid/Timezone");
        });
      }
    }
  }
}
