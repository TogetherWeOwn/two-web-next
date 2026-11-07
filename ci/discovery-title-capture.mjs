import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { digest, states, viewports } from "./discovery-title-evidence.mjs";

const root = resolve(process.env.CAPTURE_APP_ROOT);
const identity = process.env.CAPTURE_IDENTITY;
const directory = resolve("discovery-title-evidence");
const provenance = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"));
const { compilePeriodKit, periodOrigin, renderPeriodRequest } = await import(
  pathToFileURL(join(root, "test/helpers/hotzone-period-picker.ts")).href
);
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");
let kit;
let sharedCss;
let kitCss;
test.beforeAll(async () => {
  kit = await compilePeriodKit();
  sharedCss = ["styles.css", "theme.css", "schedule-theme.css"]
    .map((p) => readFileSync(join(root, "public", p), "utf8"))
    .join("\n");
  kitCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
  mkdirSync(join(directory, identity), { recursive: true });
  mkdirSync(join(directory, "rows"), { recursive: true });
});
test.afterAll(() => kit?.dispose());

async function capture(page, renderer, stateId, viewport, interaction, httpStatus, previousTitle) {
  await page.evaluate(() => document.fonts.ready);
  const png = `${identity}/${identity}-${renderer}-${stateId}-${viewport}.png`;
  const bytes = await page.screenshot({
    path: join(directory, png),
    fullPage: true,
    animations: "disabled",
    mask: [page.locator("time")],
  });
  const size = viewports[viewport];
  const row = {
    identity,
    sha: provenance[identity],
    renderer,
    stateId,
    viewport: `${size.width}x${size.height}`,
    url: page.url(),
    interaction,
    httpStatus,
    documentTitle: await page.title(),
    h1: (await page.locator("h1").textContent()).trim(),
    png,
    pngSha256: digest(bytes),
    capturedAt: new Date().toISOString(),
    runUrl: provenance.runUrl,
    ...(previousTitle === undefined ? {} : { previousTitle }),
  };
  writeFileSync(
    join(directory, "rows", `${identity}-${renderer}-${stateId}-${viewport}.json`),
    JSON.stringify(row),
  );
  if (identity === "after")
    expect(row.documentTitle).toBe(`${states[stateId][1]} — Together We Own`);
  if (previousTitle !== undefined) expect(row.documentTitle).toBe(previousTitle);
}

async function mark(page) {
  const nonce = randomUUID();
  await page.evaluate((value) => {
    window.__twoEvidenceDoc = value;
  }, nonce);
  return nonce;
}
async function archiveCommit(page, origin, number, nonce) {
  await expect(page).toHaveURL(`${origin}/events/past${number === 2 ? "?page=2" : ""}`);
  await expect(page.locator('[data-island="past-events"]')).toHaveAttribute(
    "data-page",
    String(number),
  );
  await expect(page.locator("[data-archive-pager]")).toContainText(`Page ${number} of 2`);
  await expect(page.locator('[data-island="past-events"]')).not.toHaveAttribute("aria-busy");
  await expect(page.locator("[data-archive-feedback]")).toBeEmpty();
  expect(await page.evaluate(() => window.__twoEvidenceDoc)).toBe(nonce);
}

for (const renderer of ["hono", "kit"]) {
  const origin = renderer === "hono" ? "https://localhost:8787" : "http://127.0.0.1:8788";
  for (const [viewport, size] of Object.entries(viewports)) {
    test(`${identity} ${renderer} ${viewport}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        timezoneId: "UTC",
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2026-04-01T00:00:00Z"));
        for (const stateId of ["S1", "S2", "S3", "S4", "S7", "S8"]) {
          const response = await page.goto(origin + states[stateId][0]);
          expect(response.status()).toBe(["S7", "S8"].includes(stateId) ? 422 : 200);
          if (["S7", "S8"].includes(stateId)) await expect(page.locator("h1")).toHaveText("Events");
          await capture(page, renderer, stateId, viewport, "none", response.status());
        }
        await page.goto(origin + states.S1[0]);
        const calendarNonce = await mark(page);
        await page.locator('a[href*="month=2099-06"]').first().click();
        await expect(page).toHaveURL(origin + states.I1[0]);
        await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-06");
        await expect(page.getByTestId("events-calendar-grid")).toContainText("E2E Calendar June");
        await expect(page.getByTestId("events-calendar")).not.toHaveAttribute("aria-busy");
        expect(await page.evaluate(() => window.__twoEvidenceDoc)).toBe(calendarNonce);
        await capture(page, renderer, "I1", viewport, "click next month", 200);
        await page.goBack();
        await expect(page).toHaveURL(origin + states.I2[0]);
        await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-05");
        await expect(page.getByTestId("events-calendar-grid")).toContainText("E2E Calendar May");
        await expect(page.getByTestId("events-calendar")).not.toHaveAttribute("aria-busy");
        expect(await page.evaluate(() => window.__twoEvidenceDoc)).toBe(calendarNonce);
        await capture(page, renderer, "I2", viewport, "goBack", 200);
        await page.goto(`${origin}/events/past`);
        const archive = page.locator('[data-island="past-events"]');
        await expect(archive).toHaveAttribute("data-page", "1");
        await expect(archive).toHaveAttribute("data-total-pages", "2");
        await expect(page.locator("[data-archive-pager]")).toContainText("Page 1 of 2");
        let nonce = await mark(page);
        await page.getByTestId("past-events-pager-older").click();
        await archiveCommit(page, origin, 2, nonce);
        await capture(page, renderer, "I3", viewport, "click past-events-pager-older", 200);
        nonce = await mark(page);
        await page.goBack();
        await archiveCommit(page, origin, 1, nonce);
        await capture(page, renderer, "I4", viewport, "goBack", 200);
        // Fresh document session, then replay I3 without adding another cell.
        await page.close();
        const failed = await context.newPage();
        await failed.clock.setFixedTime(new Date("2026-04-01T00:00:00Z"));
        await failed.goto(`${origin}/events/past`);
        nonce = await mark(failed);
        await failed.getByTestId("past-events-pager-older").click();
        await archiveCommit(failed, origin, 2, nonce);
        const previousTitle = await failed.title();
        let aborted = 0;
        await failed.route("**/*", (route) => {
          if (
            route.request().resourceType() === "fetch" &&
            new URL(route.request().url()).pathname === "/events/past"
          ) {
            aborted++;
            return route.abort("failed");
          }
          return route.continue();
        });
        nonce = await mark(failed);
        await failed.getByTestId("past-events-pager-newer").click();
        const failedRoot = failed.locator('[data-island="past-events"]');
        await expect(failed.locator("[data-archive-feedback]")).toHaveText(
          await failedRoot.getAttribute("data-load-error"),
        );
        expect(aborted).toBe(1);
        await expect(failedRoot).not.toHaveAttribute("aria-busy");
        await expect(failedRoot).toHaveAttribute("data-page", "2");
        await expect(failed).toHaveURL(origin + states.I5[0]);
        await expect(failed.locator("[data-archive-pager]")).toContainText("Page 2 of 2");
        expect(await failed.evaluate(() => window.__twoEvidenceDoc)).toBe(nonce);
        await capture(
          failed,
          renderer,
          "I5",
          viewport,
          "replay I3; abort fetch /events/past; click past-events-pager-newer",
          200,
          previousTitle,
        );
      } finally {
        await context.close();
      }
      const hot = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        timezoneId: "America/Los_Angeles",
        serviceWorkers: "block",
      });
      try {
        const page = await hot.newPage();
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== periodOrigin) return route.abort();
          if (route.request().isNavigationRequest() && url.pathname.startsWith("/hotzones")) {
            const result = await renderPeriodRequest(
              renderer === "hono" ? "Hono" : "Kit",
              url.pathname + url.search,
              kit,
              new Date("2026-04-01T00:00:00Z"),
            );
            const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
              match[1].split(/\s+/),
            );
            const css =
              renderer === "kit"
                ? `${sharedCss}\n${kitCss.build(candidates)}\n${kit.css}`
                : sharedCss;
            expect(css).not.toContain("</style");
            return route.fulfill({
              status: result.status,
              contentType: "text/html",
              body: result.html.replace("</head>", `<style>${css}</style></head>`),
            });
          }
          const asset = resolve(root, "public", `.${url.pathname}`);
          if (!asset.startsWith(join(root, "public") + "/") || !existsSync(asset))
            return route.abort();
          return route.fulfill({ path: asset });
        });
        for (const stateId of ["S5", "S6"]) {
          const response = await page.goto(periodOrigin + states[stateId][0]);
          expect(response.status()).toBe(200);
          await capture(page, renderer, stateId, viewport, "none", response.status());
        }
      } finally {
        await hot.close();
      }
    });
  }
}
