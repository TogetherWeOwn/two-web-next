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
  page.getByTestId("events-partial-source").filter({ hasText: MISSING_DISCORD });
const root = (page: Page) => page.getByTestId("events-calendar");
const monthPath = "/events?past=1&view=calendar&month=2099-05";
const recovered = "Discord events are available again.";

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

async function fixture(context: BrowserContext, css = "") {
  const state = { failed: true, row: 1, badFragment: false, readError: false, oldSnapshot: false };
  let tick = 0;
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
      const body = url.pathname === "/schedule-theme.css" ? css : "";
      await route.fulfill({ contentType: "text/css", body });
      return;
    }
    const fragment = request.headers()["x-two-island"] === "events-calendar";
    traffic.push({ path: url.pathname + url.search, island: fragment });
    const q = url.searchParams.get("q") ?? "";
    ++tick;
    let body = await partialHtml(
      partialModel({
        state: {
          view: !q && url.searchParams.get("view") === "calendar" ? "calendar" : "list",
          month: url.searchParams.get("month") ?? "2099-05",
          q,
          past: url.searchParams.get("past") === "1",
          page: Number(url.searchParams.get("page") ?? 1),
        },
        upcoming: state.readError ? [] : [partialEvent(state.row)],
        emptyState: state.readError ? "error" : null,
        discordFailed: state.failed,
        discordSnapshotAt: state.readError ? undefined : state.oldSnapshot ? 1 : tick,
      }),
      PARTIAL_ORIGIN,
      url.pathname + url.search,
      undefined,
      new Date(Date.UTC(2099, 4, 1, 12, 0, 0, tick)),
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
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(
    root(page)
      .getByRole("link", { name: /Local chess night 1/ })
      .first(),
  ).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByTestId("events-search-status")).not.toContainText(recovered);
  await expect(search).toBeFocused();
  expect(await search.evaluate((node, saved) => node === saved, original)).toBe(true);
  expect(f.traffic.map((entry) => entry.island)).toEqual([false, true]);
  expect(f.escaped).toEqual([]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("Tab reaches the named month grid region", async ({ context, page }) => {
    await fixture(context);
    await page.goto(PARTIAL_ORIGIN + monthPath);
    const region = root(page).getByRole("region", {
      name: "Events calendar",
      exact: true,
    });
    await expect(region.getByTestId("events-calendar-grid")).toBeVisible();
    await expect(region).toHaveAttribute("tabindex", "0");
    await root(page).getByTestId("calendar-month-jump-submit").focus();
    await page.keyboard.press("Tab");
    await expect(region).toBeFocused();
  });
});

for (const { view, path } of [
  { view: "list", path: PARTIAL_PATH },
  { view: "calendar", path: monthPath },
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
  const status = page.getByTestId("events-search-status");
  const originalStatus = await status.elementHandle();
  f.state.failed = false;
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(notice(page)).toHaveCount(0);
  await expect(status).toContainText(recovered);
  expect(await status.evaluate((node, saved) => node === saved, originalStatus)).toBe(true);
  await expect(search).toBeFocused();
  expect(await search.evaluate((node, saved) => node === saved, original)).toBe(true);
  f.state.failed = true;
  await page.getByTestId("events-view-list").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "list");
  await expect(notice(page)).toHaveCount(1);
  await expect(
    root(page)
      .getByRole("link", { name: /Local chess night 1/ })
      .first(),
  ).toBeVisible();
  await expect(search).toBeFocused();
  await expect(status).not.toContainText(recovered);
  f.state.failed = false;
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(status).toContainText(recovered);
  await page.getByTestId("events-view-list").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "list");
  await expect(status).not.toContainText(recovered);
  expect(f.traffic.map((entry) => entry.island)).toEqual([false, true, true, true, true]);
  expect(f.escaped).toEqual([]);
});

test("an older snapshot or inconclusive read cannot announce Discord recovery", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  await expect(notice(page)).toHaveCount(1);
  f.state.failed = false;
  const status = page.getByTestId("events-search-status");
  // An overlapping render can have a later request time but the same snapshot generation.
  f.state.oldSnapshot = true;
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
  await expect(root(page)).toHaveAttribute("data-view", "calendar");
  await expect(status).not.toContainText(recovered);
  f.state.oldSnapshot = false;
  f.state.readError = true;
  await page.getByTestId("events-view-list").evaluate((link: HTMLElement) => link.click());
  await expect(page.getByTestId("events-empty-error")).toBeVisible();
  await expect(status).not.toContainText(recovered);
  f.state.readError = false;
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
  await expect(status).toContainText(recovered);
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

test("search announces a newly failed source without moving focus", async ({ page, context }) => {
  const f = await fixture(context);
  f.state.failed = false;
  await page.goto(PARTIAL_ORIGIN + PARTIAL_PATH);
  const search = page.getByTestId("events-search");
  const status = page.getByTestId("events-search-status");
  const originalStatus = await status.elementHandle();
  await search.focus();

  f.state.readError = true;
  f.state.failed = true;
  await search.fill("missing");
  await expect(page.getByTestId("events-empty-error")).toBeVisible();
  await expect(status).toContainText(
    await page.getByTestId("events-empty-error").locator("h2").innerText(),
  );
  await expect(search).toBeFocused();
  expect(await status.evaluate((node, saved) => node === saved, originalStatus)).toBe(true);

  f.state.readError = false;
  await search.fill("chess");
  await expect(notice(page)).toBeVisible();
  await expect(status).toContainText(MISSING_DISCORD);
  await expect(search).toBeFocused();
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
  await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
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
    await page.getByTestId("events-view-calendar").evaluate((link: HTMLElement) => link.click());
    await stale.entered.ready;
    f.state.failed = false;
    f.state.row = 2;
    await page.getByTestId("events-view-list").evaluate((link: HTMLElement) => link.click());
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

const scheduleCss = readFileSync(
  new NodeURL("../public/schedule-theme.css", import.meta.url),
  "utf8",
);

test("a failed month read restores the grid tab stop after resizing during loading", async ({
  page,
  context,
}) => {
  const f = await fixture(context, scheduleCss);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PARTIAL_ORIGIN + monthPath);
  const scroll = page.getByTestId("events-calendar-scroll");
  await expect(scroll).not.toHaveAttribute("tabindex");

  f.state.badFragment = true;
  const pending = f.holdNext();
  await page.getByRole("link", { name: "Next month" }).click();
  await pending.entered.ready;
  await expect(scroll).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  pending.done.release();
  await pending.settled.ready;
  await expect(scroll).toBeVisible();
  await expect(scroll).toHaveAttribute("tabindex", "0");
});

const afterDisplay = (page: Page) =>
  page
    .locator(".schedule-month-frame")
    .evaluate((node) => getComputedStyle(node, "::after").display);

test("partial calendar keeps retry before invite and shows grid scroll cues only when narrow", async ({
  page,
  context,
}) => {
  await fixture(context, scheduleCss);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PARTIAL_ORIGIN + monthPath);

  const actions = notice(page).locator(".schedule-recovery-actions");
  await expect(actions.locator("a")).toHaveCount(2);
  await expect(actions.locator("a").first()).toHaveAccessibleName(RETRY_NAME);
  await expect(actions.locator("a").last()).toHaveAttribute("href", PARTIAL_INVITE);

  const hint = page.locator(".schedule-month-frame .schedule-month-hint");
  const scroll = page.getByTestId("events-calendar-scroll");
  await expect(scroll).toHaveCount(1);
  await expect(hint).toHaveCount(1);

  await expect(hint).toBeHidden();
  expect(await afterDisplay(page)).toBe("none");
  await expect(scroll).not.toHaveAttribute("tabindex");
  await expect(scroll).toHaveAccessibleName("Events calendar");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint).toBeVisible();
  await expect(hint).not.toHaveAttribute("aria-hidden");
  expect(await afterDisplay(page)).toBe("block");
  expect(await scroll.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  await expect(scroll).toHaveAttribute("tabindex", "0");
  await scroll.focus();
  await scroll.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(scroll).not.toHaveAttribute("tabindex");
  await page.getByRole("link", { name: "Next month" }).click();
  await expect(page.getByTestId("calendar-month")).toContainText("June");
  await expect(scroll).not.toHaveAttribute("tabindex");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scroll).toHaveAttribute("tabindex", "0");

  const retry = await actions.locator("a").first().boundingBox();
  const invite = await actions.locator("a").last().boundingBox();
  expect(retry && invite && (invite.y > retry.y || invite.x > retry.x)).toBe(true);
  expect(invite!.x + invite!.width).toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(hint).toBeVisible();
  const narrowInvite = await actions.locator("a").last().boundingBox();
  expect(narrowInvite).not.toBeNull();
  expect(narrowInvite!.x + narrowInvite!.width).toBeLessThanOrEqual(320);

  await page.emulateMedia({ forcedColors: "active" });
  expect(await afterDisplay(page)).toBe("none");
  await expect(hint).toBeVisible();
});
