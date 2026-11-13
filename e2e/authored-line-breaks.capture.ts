// Opt-in screenshot evidence, not a gate and not part of the parity ledger. It runs
// against the real Hono and Kit workers that playwright.kit-parity.config.ts starts,
// on the disposable seeded Postgres, with deterministic fixture rows it inserts and
// deletes by exact event key (seeded and other rows are never touched).
//
//   AUTHORED_BREAKS_PHASE=before|after AUTHORED_BREAKS_DIR=<dir> \
//   DATABASE_URL=<disposable test database> \
//     npx playwright test --config=playwright.authored-breaks-capture.config.ts
//
// "before" captures without asserting the shared line-break class or its computed
// style, so it can run against a build that predates the change. "after" also asserts
// white-space: pre-line on every authored-text node.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";
import { KIT_ORIGIN, parityTargets } from "./kit-parity";

const output = process.env.AUTHORED_BREAKS_DIR;
const phase = process.env.AUTHORED_BREAKS_PHASE;
if (!output) throw new Error("Authored line-break capture requires AUTHORED_BREAKS_DIR");
if (phase !== "before" && phase !== "after")
  throw new Error("AUTHORED_BREAKS_PHASE must be 'before' or 'after'");

const LINES = "Bring a game.\n<b>Doors</b> at 7.\n\nEveryone welcome.";
const FILLER = "Bring a game and meet the community. ".repeat(23);
// Keys end in "BRK00NN" so they cannot match the archive page-turn sweep pattern.
const KEYS = {
  long: "01K0000000000000000BRK0001",
  short: "01K0000000000000000BRK0002",
  past: "01K0000000000000000BRK0003",
};
const LONG_TITLE = "Authored breaks long event";
const SHORT_TITLE = "Authored breaks short event";
const PAST_TITLE = "Authored breaks archive event";
// Bypass cookies keep the anonymous isolate caches from serving or storing fixture HTML.
const BYPASS = "e2e-parity-bypass=1; e2e-archive-bypass=1";
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

async function withDb<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  requireGithubRunner();
  const sql = postgres(requireTestDatabase(process.env.DATABASE_URL) as string, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

const removeFixtures = (sql: ReturnType<typeof postgres>) =>
  sql`delete from events where event_key in ${sql(Object.values(KEYS))}`;

test.beforeAll(async () => {
  await withDb(async (sql) => {
    await removeFixtures(sql);
    const insert = (key: string, title: string, description: string, start: string, end: string) =>
      sql`insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
        values (${key}, ${title}, ${description}, ${start}, ${end}, 'UTC', 'published', 10, true)`;
    await insert(
      KEYS.long,
      LONG_TITLE,
      `${LINES}\n${FILLER}`,
      "2099-08-02T18:00:00Z",
      "2099-08-02T20:00:00Z",
    );
    await insert(KEYS.short, SHORT_TITLE, LINES, "2099-08-03T18:00:00Z", "2099-08-03T20:00:00Z");
    await insert(KEYS.past, PAST_TITLE, LINES, "2023-03-04T18:00:00Z", "2023-03-04T20:00:00Z");
  });
});

test.afterAll(async () => {
  await withDb(removeFixtures);
});

for (const target of parityTargets()) {
  for (const viewport of viewports) {
    const size = `${viewport.width}x${viewport.height}`;
    // A fresh browser context per test: no shared cookies, storage or cache.
    const open = async (browser: import("@playwright/test").Browser) => {
      const context = await browser.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        serviceWorkers: "block",
        timezoneId: "UTC",
        viewport,
        extraHTTPHeaders: { cookie: BYPASS },
      });
      // Only the two parity loopbacks may be reached.
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === "https://localhost:8787" || url.origin === KIT_ORIGIN
          ? route.continue()
          : route.abort("blockedbyclient");
      });
      return context;
    };
    const shot = (name: string) => join(output, `${phase}-${target.name}-${name}-${size}.png`);
    const fits = (page: import("@playwright/test").Page) =>
      page.evaluate("document.documentElement.scrollWidth <= window.innerWidth");

    test(`${target.name} ${size}: schedule collapsed and expanded`, async ({ browser }) => {
      mkdirSync(output, { recursive: true });
      const context = await open(browser);
      try {
        const page = await context.newPage();
        const response = await page.goto("/events?view=list&month=2099-08&q=Authored+breaks");
        expect(response?.status()).toBe(200);
        await expect(page.getByText(LONG_TITLE).first()).toBeVisible();
        await expect(page.getByText(SHORT_TITLE).first()).toBeVisible();
        // Literal, escaped markup: shown as text, never parsed into an element.
        await expect(page.getByText("<b>Doors</b>").first()).toBeVisible();
        await expect(page.locator("b", { hasText: "Doors" })).toHaveCount(0);
        if (phase === "after") {
          const nodes = page.locator(".schedule-text");
          expect(await nodes.count()).toBeGreaterThan(0);
          for (const node of await nodes.all())
            await expect(node).toHaveCSS("white-space", "pre-line");
        }
        await page.screenshot({
          path: shot("schedule-collapsed"),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        expect(await fits(page)).toBe(true);

        const details = page.locator(`[data-event-key="${KEYS.long}"] details`).first();
        await details.locator("summary").first().click();
        await expect(details).toHaveAttribute("open", "");
        if (phase === "after")
          for (const node of await details.locator(".schedule-text").all())
            await expect(node).toHaveCSS("white-space", "pre-line");
        await page.screenshot({
          path: shot("schedule-expanded"),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        expect(await fits(page)).toBe(true);
      } finally {
        await context.close();
      }
    });

    test(`${target.name} ${size}: archive search`, async ({ browser }) => {
      mkdirSync(output, { recursive: true });
      const context = await open(browser);
      try {
        const page = await context.newPage();
        const response = await page.goto("/events/past?q=Doors");
        expect(response?.status()).toBe(200);
        await expect(page.getByText(PAST_TITLE).first()).toBeVisible();
        await expect(page.getByText("<b>Doors</b>").first()).toBeVisible();
        await expect(page.locator("b", { hasText: "Doors" })).toHaveCount(0);
        await expect(page.locator("mark")).toHaveText(["Doors"]);
        if (phase === "after")
          await expect(page.locator(".archive-passage", { hasText: "Doors" }).first()).toHaveCSS(
            "white-space",
            "pre-line",
          );
        await page.screenshot({
          path: shot("archive-search"),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        expect(await fits(page)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
}
