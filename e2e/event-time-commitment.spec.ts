// Local fixture acceptance, automatically discovered by browser-smoke.
// NODE_OPTIONS=--import=tsx npx playwright test --config=e2e event-time-commitment.spec.ts --workers=1
// EVENT_TIME_SCREENSHOT_DIR captures the real baseline/implementation at both widths.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clockCases,
  clockRows,
  durationCases,
  durationEvent,
} from "../test/fixtures/event-time-commitment";
import { renderCalendar, type CalendarTwin } from "../test/helpers/calendar-multiday-acceptance";
import {
  compileScheduleKit,
  renderScheduledPage,
  type KitRenderer,
} from "../test/helpers/event-scheduled-range";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://calendar.example.test";
const sharedCss = ["styles.css", "theme.css", "event-theme.css"]
  .map((name) => readFileSync(join(root, "public", name), "utf8"))
  .join("\n");
let kit: KitRenderer;
let kitCss: { build: (candidates: string[]) => string };
test.beforeAll(async () => {
  kit = await compileScheduleKit();
  const webRequire = createRequire(join(root, "web/package.json"));
  kitCss = await webRequire("@tailwindcss/node").compile(
    readFileSync(join(root, "web/src/app.css"), "utf8"),
    { base: join(root, "web/src"), onDependency: () => {} },
  );
});

async function capture(page: Page, name: string) {
  const directory = process.env.EVENT_TIME_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

function localAsset(pathname: string) {
  const asset = resolve(root, "public", pathname.slice(1));
  const contentType = pathname.endsWith(".js")
    ? "text/javascript"
    : pathname.endsWith(".css")
      ? "text/css"
      : pathname.endsWith(".woff2")
        ? "font/woff2"
        : pathname.endsWith(".svg")
          ? "image/svg+xml"
          : pathname.endsWith(".png")
            ? "image/png"
            : undefined;
  return contentType &&
    asset.startsWith(join(root, "public/")) &&
    existsSync(asset) &&
    statSync(asset).isFile()
    ? { contentType, body: readFileSync(asset) }
    : null;
}

async function mountCalendar(context: BrowserContext, twin: CalendarTwin) {
  const documents: string[] = [];
  const fragments: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") return route.abort();
    const asset = localAsset(url.pathname);
    if (asset) return route.fulfill(asset);
    if (url.pathname !== "/events") return route.fulfill({ status: 404, body: "No fixture" });
    const path = url.pathname + url.search;
    if (request.headers()["x-two-island"] === "events-calendar") fragments.push(path);
    else documents.push(path);
    return route.fulfill({
      contentType: "text/html; charset=UTF-8",
      body: await renderCalendar(twin, clockRows(), {
        month: "2030-06",
        zone: "Asia/Tokyo",
        view: url.searchParams.get("view") === "calendar" ? "calendar" : "list",
        loginReturnTo: path,
      }),
    });
  });
  return { documents, fragments };
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width}: Duration is readable before RSVP without JavaScript`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: "block",
        viewport,
        timezoneId: "Pacific/Auckland",
      });
      try {
        const page = await context.newPage();
        // Serve only the fixture and real local assets, never a remote request.
        const fixture = durationCases[0]!;
        const { status, html } = await renderScheduledPage(
          twin,
          durationEvent(fixture),
          "member",
          kit,
        );
        expect(status).toBe(200);
        const candidates = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
          match[1]!.split(/\s+/),
        );
        const css =
          twin === "Kit" ? `${sharedCss}\n${kitCss.build(candidates)}\n${kit.css}` : sharedCss;
        expect(css).not.toContain("</style");
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== "https://schedule.example.test" || request.method() !== "GET")
            return route.abort();
          const asset = localAsset(url.pathname);
          if (asset) return route.fulfill(asset);
          if (url.pathname !== "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV") return route.abort();
          return route.fulfill({
            contentType: "text/html; charset=UTF-8",
            body: html.replace("</head>", `<style>${css}</style></head>`),
          });
        });
        await page.goto("https://schedule.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV");
        await capture(page, `${twin}-${viewport.width}-detail-no-js`);
        await expect(page.locator('time[datetime="2030-06-01T18:00:00.000Z"]')).toBeVisible();
        await expect(page.locator('time[datetime="2030-06-01T19:30:00.000Z"]')).toBeVisible();
        const term = page.locator("dt").filter({ hasText: /^Duration$/ });
        expect(
          await term.count(),
          "Duration must be server-rendered metadata, not island-only output",
        ).toBe(1);
        await expect(term).toBeVisible();
        const definition = term.locator("xpath=following-sibling::dd[1]");
        await expect(definition).toBeVisible();
        await expect(definition).toHaveText(fixture.want);
        const box = (await definition.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(
          await definition.evaluate((node) => {
            const action = document.querySelector('[data-testid="rsvp-going"]');
            return (
              !!action &&
              !!(node.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)
            );
          }),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    for (const javaScriptEnabled of [false, true]) {
      test(`${twin} ${viewport.width} JS=${javaScriptEnabled}: named host clocks survive native/fragment rendering`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          serviceWorkers: "block",
          viewport,
          timezoneId: "Pacific/Auckland",
        });
        try {
          const requests = await mountCalendar(context, twin);
          const page = await context.newPage();
          await page.goto(
            `${origin}/events?view=${javaScriptEnabled ? "list" : "calendar"}&month=2030-06`,
          );
          if (javaScriptEnabled) {
            await page.getByTestId("events-view-calendar").focus();
            await page.keyboard.press("Enter");
          }
          await expect(page.getByTestId("events-calendar-grid")).toBeVisible();
          expect(requests.documents).toHaveLength(1);
          expect(requests.fragments).toHaveLength(javaScriptEnabled ? 1 : 0);
          const actual = await page.locator("td[data-date] a[data-cal-jump]").evaluateAll((links) =>
            links.map((link) => ({
              text: link.textContent?.replace(/\s+/g, " ").trim(),
              name: link.getAttribute("aria-label"),
              href: link.getAttribute("href"),
            })),
          );
          if (javaScriptEnabled) {
            const native = await context.newPage();
            await native.goto(`${origin}/events?view=calendar&month=2030-06`);
            const expected = await native
              .locator("td[data-date] a[data-cal-jump]")
              .evaluateAll((links) =>
                links.map((link) => ({
                  text: link.textContent?.replace(/\s+/g, " ").trim(),
                  name: link.getAttribute("aria-label"),
                  href: link.getAttribute("href"),
                })),
              );
            expect(actual).toEqual(expected);
            await native.close();
          }
          // Keep the existing horizontal mobile grid; expose the occupied
          // cells before capturing, rather than photographing empty weekdays.
          await page
            .locator('td[data-date="2030-06-01"] a[data-cal-jump]')
            .first()
            .scrollIntoViewIfNeeded();
          await capture(page, `${twin}-${viewport.width}-grid-js-${javaScriptEnabled}`);
          for (const fixture of clockCases) {
            const link = page.locator(
              `td[data-date="2030-06-01"] a[data-cal-jump][href*="${fixture.eventKey}"]`,
            );
            await expect(link).toBeVisible();
            const visible = (await link.innerText()).replace(/\s+/g, " ").trim();
            expect(visible).toContain(`${fixture.clock} ${fixture.effective}`);
            await expect(link).toHaveAccessibleName(
              new RegExp(`${fixture.clock} ${fixture.effective.replaceAll("/", "\\/")}`),
            );
            expect(await link.getAttribute("aria-label")).toContain(visible.replace(/…$/, ""));
            expect(await link.getAttribute("aria-label")).toContain(fixture.title);
            if (fixture.name === "New York") {
              await expect(link).toHaveText(
                "14:00 America/New_York WARHAMMERWORLDTOUR… 6 seats left",
              );
            }
            const layout = await link.evaluate((node) => {
              const cell = node.closest("td")!;
              const bounds = (element: Element) => {
                const { left, right, top, bottom } = element.getBoundingClientRect();
                return { left, right, top, bottom };
              };
              // Anchor boxes can fit while their text paints over the next day.
              // Measure every rendered text run, including the cancellation badge.
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
              const runs = [];
              for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                if (!text.textContent?.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                // Each run must also fit any ancestor that could clip it.
                const clips = [];
                for (
                  let ancestor = text.parentElement;
                  ancestor;
                  ancestor = ancestor.parentElement
                ) {
                  const style = getComputedStyle(ancestor);
                  if (style.overflowX !== "visible" || style.overflowY !== "visible") {
                    clips.push(bounds(ancestor));
                  }
                  if (ancestor === cell) break;
                }
                runs.push({
                  text: text.textContent,
                  visible: text.parentElement!.checkVisibility({
                    checkOpacity: true,
                    checkVisibilityCSS: true,
                  }),
                  clips,
                  rects: Array.from(range.getClientRects(), ({ left, right, top, bottom }) => ({
                    left,
                    right,
                    top,
                    bottom,
                  })),
                });
              }
              return {
                whiteSpace: getComputedStyle(node).whiteSpace,
                textOverflow: getComputedStyle(node).textOverflow,
                ...bounds(node),
                cell: bounds(cell),
                runs,
              };
            });
            expect(layout.whiteSpace).not.toBe("nowrap");
            expect(layout.textOverflow).not.toBe("ellipsis");
            expect(layout.left).toBeGreaterThanOrEqual(0);
            expect(layout.right).toBeLessThanOrEqual(viewport.width);
            expect(layout.runs.length).toBeGreaterThan(0);
            for (const run of layout.runs) {
              expect(run.visible, `${fixture.name}: ${run.text} must not be hidden`).toBe(true);
              expect(run.rects.length).toBeGreaterThan(0);
              for (const rect of run.rects) {
                expect(rect.right - rect.left).toBeGreaterThan(0);
                expect(rect.bottom - rect.top).toBeGreaterThan(0);
                for (const [boxName, box] of [
                  ["day cell", layout.cell],
                  ["link", layout],
                  ...run.clips.map((clip) => ["clipping ancestor", clip] as const),
                ] as const) {
                  const { left, right, top, bottom } = box;
                  const message = `${fixture.name}: text ${JSON.stringify(rect)} must fit ${boxName} ${JSON.stringify({ left, right, top, bottom })}`;
                  expect(rect.left, message).toBeGreaterThanOrEqual(left);
                  expect(rect.right, message).toBeLessThanOrEqual(right);
                  expect(rect.top, message).toBeGreaterThanOrEqual(top);
                  expect(rect.bottom, message).toBeLessThanOrEqual(bottom);
                }
              }
            }
          }
        } finally {
          await context.close();
        }
      });
    }
  }
}
