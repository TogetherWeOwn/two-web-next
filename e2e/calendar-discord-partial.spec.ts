import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  MISSING_DISCORD,
  PARTIAL_INVITE,
  PARTIAL_ORIGIN,
  PARTIAL_PATH,
  partialEvent,
  partialHtml,
  partialModel,
  RETRY_NAME,
} from "../test/helpers/calendar-discord-partial";

// Real shared SSR and shipped island, intercepted synthetic HTTP only. No
// worker, database, sign-in, Discord traffic or source/config changes required.
// A notice outside a swap zone, stale response commit or full-page retry-only
// implementation breaks these journeys, even if its first render looks right.
const island = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const notice = (page: Page) =>
  page.locator('[role="status"], [role="alert"]').filter({ hasText: MISSING_DISCORD });
const root = (page: Page) => page.getByTestId("events-calendar");

function expectSameState(href: string, path: string) {
  const actual = new URL(href, PARTIAL_ORIGIN);
  const expected = new URL(path, PARTIAL_ORIGIN);
  expect(actual.origin).toBe(PARTIAL_ORIGIN);
  expect(actual.pathname).toBe("/events");
  expect([...actual.searchParams.entries()].sort()).toEqual(
    [...expected.searchParams.entries()].sort(),
  );
}

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function fixture(context: BrowserContext) {
  const state = { failed: true, row: 1, badFragment: false };
  const held: {
    entered: ReturnType<typeof gate>;
    done: ReturnType<typeof gate>;
    settled: ReturnType<typeof gate>;
  }[] = [];
  const traffic: { path: string; island: boolean }[] = [];
  const escaped: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== PARTIAL_ORIGIN) {
      escaped.push(url.origin);
      await route.abort();
      return;
    }
    if (url.pathname === "/islands/events-calendar.js") {
      await route.fulfill({ contentType: "text/javascript", body: island });
      return;
    }
    if (url.pathname !== "/events") {
      await route.fulfill({ contentType: "text/css", body: "" });
      return;
    }
    const fragment = request.headers()["x-two-island"] === "events-calendar";
    traffic.push({ path: url.pathname + url.search, island: fragment });
    const q = url.searchParams.get("q") ?? "";
    let body = await partialHtml(
      partialModel({
        state: {
          view: !q && url.searchParams.get("view") === "calendar" ? "calendar" : "list",
          month: url.searchParams.get("month") ?? "2099-05",
          q,
          past: url.searchParams.get("past") === "1",
          page: Number(url.searchParams.get("page") ?? 1),
        },
        upcoming: [partialEvent(state.row)],
        discordFailed: state.failed,
      }),
    );
    if (fragment && state.badFragment)
      body = "<html><main>Malformed fixture response</main></html>";
    const pending = fragment ? held.shift() : undefined;
    if (pending) {
      pending.entered.release();
      await pending.done.ready;
    }
    try {
      await route.fulfill({ contentType: "text/html", body });
    } finally {
      pending?.settled.release();
    }
  });
  return {
    state,
    traffic,
    escaped,
    holdNext() {
      const pending = { entered: gate(), done: gate(), settled: gate() };
      held.push(pending);
      return pending;
    },
  };
}

test("complete fixture turns keep the input identity, focus and canonical rows without a source warning", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.failed = false;
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  const search = page.getByTestId("events-search");
  await search.focus();
  const original = await search.elementHandle();
  await page
    .getByTestId("events-view-calendar")
    .evaluate((link: { click(): void }) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(
    root(page)
      .getByRole("link", { name: /Local chess night 1/ })
      .first(),
  ).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(search).toBeFocused();
  expect(await search.evaluate((node, saved) => node === saved, original)).toBe(true);
  expect(f.traffic.map((entry) => entry.island)).toEqual([false, true]);
  expect(f.escaped).toEqual([]);
});

for (const { view, path } of [
  { view: "list", path: PARTIAL_PATH },
  { view: "calendar", path: "/events?past=1&view=calendar&month=2099-05" },
  { view: "search", path: "/events?q=chess&past=1&page=2" },
]) {
  test(`partial ${view} supports a same-state keyboard retry and invite with JavaScript disabled`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const f = await fixture(context);
      const page = await context.newPage();
      await page.goto(PARTIAL_ORIGIN + path);
      await expect(
        root(page)
          .getByRole("link", { name: /Local chess night 1/ })
          .first(),
      ).toBeVisible();
      await expect(
        notice(page),
        "partial schedule needs an accessible missing-source notice",
      ).toHaveCount(1);
      const retry = root(page).getByRole("link", { name: RETRY_NAME });
      await expect(retry).toHaveCount(1);
      const href = await retry.getAttribute("href");
      expectSameState(href!, path);
      await expect(root(page).locator(`a[href="${PARTIAL_INVITE}"]`)).toBeVisible();
      f.state.failed = false;
      await retry.focus();
      await Promise.all([page.waitForEvent("domcontentloaded"), retry.press("Enter")]);
      await expect(notice(page)).toHaveCount(0);
      await expect(
        root(page)
          .getByRole("link", { name: /Local chess night 1/ })
          .first(),
      ).toBeVisible();
      expectSameState(page.url(), path);
      expect(f.traffic.map((entry) => entry.island)).toEqual([false, false]);
      expect(f.escaped).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("fragment failure → recovery → failure removes and restores the notice without replacing the focused input", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  await expect(notice(page)).toHaveCount(1);
  // The warning must actually be within a committed swap region.
  expect(await notice(page).evaluate((node) => Boolean(node.closest("[data-cal-zone]")))).toBe(
    true,
  );
  const search = page.getByTestId("events-search");
  await search.focus();
  const original = await search.elementHandle();
  f.state.failed = false;
  await page
    .getByTestId("events-view-calendar")
    .evaluate((link: { click(): void }) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(notice(page)).toHaveCount(0);
  await expect(search).toBeFocused();
  expect(await search.evaluate((node, saved) => node === saved, original)).toBe(true);
  f.state.failed = true;
  await page.getByTestId("events-view-list").evaluate((link: { click(): void }) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "list");
  await expect(notice(page)).toHaveCount(1);
  await expect(
    root(page)
      .getByRole("link", { name: /Local chess night 1/ })
      .first(),
  ).toBeVisible();
  await expect(search).toBeFocused();
  expect(f.traffic.map((entry) => entry.island)).toEqual([false, true, true]);
  expect(f.escaped).toEqual([]);
});

test("recovery → failure adds the missing-source notice through the shipped fragment binder", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.failed = false;
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  await expect(notice(page)).toHaveCount(0);
  f.state.failed = true;
  await page.getByTestId("events-view-calendar").click();
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(notice(page)).toHaveCount(1);
  await expect(
    root(page)
      .getByRole("link", { name: /Local chess night 1/ })
      .first(),
  ).toBeVisible();
});

test("malformed fragment retains the committed partial rows, warning, controls and keyboard focus", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  await expect(notice(page)).toHaveCount(1);
  const before = await page.locator('[data-cal-zone="content"]').innerHTML();
  const search = page.getByTestId("events-search");
  await search.focus();
  f.state.badFragment = true;
  await page
    .getByTestId("events-view-calendar")
    .evaluate((link: { click(): void }) => link.click());
  await expect(page.locator("[data-cal-feedback]")).not.toHaveText("");
  expect(await page.locator('[data-cal-zone="content"]').innerHTML()).toBe(before);
  await expect(root(page)).toHaveAttribute("data-view", "list");
  await expect(notice(page)).toHaveCount(1);
  await expect(root(page).getByRole("link", { name: RETRY_NAME })).toHaveCount(1);
  await expect(search).toBeFocused();
  expect(new URL(page.url()).search).toBe("?past=1&page=2");
});

test("a superseded failed-source response cannot overwrite a recovered committed schedule", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.failed = false;
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  const search = page.getByTestId("events-search");
  await search.focus();
  f.state.failed = true;
  const stale = f.holdNext();
  try {
    await page
      .getByTestId("events-view-calendar")
      .evaluate((link: { click(): void }) => link.click());
    await stale.entered.ready;
    f.state.failed = false;
    f.state.row = 2;
    await page.getByTestId("events-view-list").evaluate((link: { click(): void }) => link.click());
    await expect(root(page)).toContainText("Local chess night 2");
  } finally {
    stale.done.release();
  }
  await stale.settled.ready;
  await expect(root(page)).not.toHaveAttribute("aria-busy");
  await expect(notice(page)).toHaveCount(0);
  await expect(root(page)).toHaveAttribute("data-view", "list");
  await expect(root(page)).not.toContainText("Local chess night 1");
  await expect(search).toBeFocused();
  expect(f.traffic.map((entry) => entry.island)).toEqual([false, true, true]);
});
