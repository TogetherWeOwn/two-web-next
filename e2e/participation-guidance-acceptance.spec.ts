// Hermetic browser-smoke acceptance. No opt-in, server, DB or remote traffic.
// Acceptance-owned: real Hono/Kit output and shipped public island bytes.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCalendar } from "../test/helpers/calendar-multiday-acceptance";
import {
  CUE,
  DETAIL_PATH,
  EVENT_KEY,
  HELP,
  NOTES,
  ORIGIN,
  detailStates,
  renderDetail,
  scanEvent,
  type DetailState,
  type Twin,
} from "../test/helpers/participation-guidance";

const root = fileURLToPath(new URL("../", import.meta.url));
const writePath = `/events/${EVENT_KEY}/rsvp`;
async function mount(
  context: BrowserContext,
  twin: Twin,
  state: DetailState,
  result?: { status: number; body?: string; abort?: boolean },
) {
  const writes: { method: string; body: string | null }[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === writePath && ["PUT", "DELETE"].includes(request.method())) {
      writes.push({ method: request.method(), body: request.postData() });
      if (!result || result.abort) return route.abort("failed");
      return route.fulfill({
        status: result.status,
        contentType: "application/json",
        body: result.body ?? "",
      });
    }
    if (request.method() !== "GET") return route.abort();
    if (url.pathname === "/events")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: await renderCalendar(twin, [scanEvent({ accessibilityNotes: NOTES })], {
          view: "list",
          month: "2030-06",
        }),
      });
    if (url.pathname === DETAIL_PATH)
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: (await renderDetail(twin, state)).html,
      });
    if (url.pathname === "/faq")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><title>Fixture destination</title><h1>FAQ</h1><h2 id="faq-events">Events</h2></html>',
      });
    const asset = resolve(root, "public", url.pathname.slice(1));
    const contentType = url.pathname.endsWith(".js")
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : url.pathname.endsWith(".woff2")
            ? "font/woff2"
            : undefined;
    if (
      contentType &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      statSync(asset).isFile()
    )
      return route.fulfill({ contentType, body: readFileSync(asset) });
    return route.fulfill({ status: 404, body: "No synthetic fixture" });
  });
  return writes;
}
async function capture(page: Page, name: string) {
  const directory = process.env.PARTICIPATION_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function helpBesideReservation(page: Page) {
  const help = page.getByRole("link", { name: HELP, exact: true });
  expect(await help.count(), "contextual RSVP help must survive the current state").toBe(1);
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute("href", "/faq#faq-events");
  expect(
    await help.evaluate((node) => (node as HTMLAnchorElement).tabIndex),
  ).toBeGreaterThanOrEqual(0);
  // A global footer link is not contextual help. Allow either inside the
  // widget or an adjacent sibling, without prescribing a new DOM/testid API.
  expect(
    await help.evaluate((node) => {
      const widget = document.querySelector('[data-island="rsvp-button"]');
      if (!widget) return false;
      return [widget, widget.parentElement].some(
        (container) =>
          container?.contains(node) && !["MAIN", "BODY", "HTML"].includes(container.tagName),
      );
    }),
  ).toBe(true);
  return help;
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width}: CONTROL baseline normal/full/paused controls and narrow layout`, async ({
      browser,
    }) => {
      for (const name of ["member", "full", "paused new response"]) {
        const state = detailStates.find((s) => s.name === name)!;
        const context = await browser.newContext({
          viewport,
          javaScriptEnabled: false,
          serviceWorkers: "block",
        });
        try {
          const writes = await mount(context, twin, state);
          const page = await context.newPage();
          await page.goto(`${ORIGIN}${DETAIL_PATH}`);
          for (const id of state.present) await expect(page.getByTestId(id)).toBeVisible();
          for (const id of state.absent) await expect(page.getByTestId(id)).toHaveCount(0);
          expect(writes).toHaveLength(0);
          await capture(page, `${twin}-${viewport.width}-${name.replaceAll(" ", "-")}`);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        } finally {
          await context.close();
        }
      }
    });

    test(`${twin} ${viewport.width}: native cue reaches real notes and help works by keyboard without submitting`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport,
        javaScriptEnabled: false,
        serviceWorkers: "block",
      });
      try {
        const writes = await mount(context, twin, detailStates[0]!);
        const page = await context.newPage();
        await page.goto(`${ORIGIN}/events?view=list&month=2030-06`);
        const card = page.locator(`#event-${EVENT_KEY}`);
        await expect(card).toBeVisible();
        await capture(page, `${twin}-${viewport.width}-schedule`);
        const cue = card.getByRole("link", { name: CUE, exact: true });
        expect(await cue.count(), "schedule must expose existing organizer planning notes").toBe(1);
        await expect(cue).toBeVisible();
        expect(await card.innerText()).not.toContain("Planning-only marker");
        await card.locator("h3 a").focus();
        for (let tab = 0; tab < 12; tab++) {
          await page.keyboard.press("Tab");
          if (await cue.evaluate((node) => node === document.activeElement)) break;
        }
        await expect(cue).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${ORIGIN}${DETAIL_PATH}#event-accessibility-heading`);
        const heading = page.locator("#event-accessibility-heading");
        await expect(heading).toHaveText("Accessibility");
        await expect(page.getByTestId("event-accessibility")).toContainText(NOTES);
        const help = await helpBesideReservation(page);
        await help.focus();
        await expect(help).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${ORIGIN}/faq#faq-events`);
        expect(writes).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    for (const outcome of [
      {
        name: "going",
        state: "member",
        action: "rsvp-going",
        method: "PUT",
        status: 201,
        data: { status: "going", synced_to_discord_at: null },
        target: "rsvp-confirmed",
      },
      {
        name: "waitlisted",
        state: "full",
        action: "waitlist-join",
        method: "PUT",
        status: 201,
        data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 2 },
        target: "waitlist-position",
      },
      {
        name: "withdrawn",
        state: "saved pending mirror",
        action: "rsvp-withdraw",
        method: "DELETE",
        status: 204,
        data: null,
        target: "rsvp-going",
      },
    ]) {
      test(`${twin} ${viewport.width}: ${outcome.name} island replacement retains native help and makes no extra write`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        try {
          const state = detailStates.find((s) => s.name === outcome.state)!;
          const writes = await mount(context, twin, state, {
            status: outcome.status,
            body: outcome.data ? JSON.stringify({ data: outcome.data }) : "",
          });
          const page = await context.newPage();
          await page.goto(`${ORIGIN}${DETAIL_PATH}`);
          await page.getByTestId(outcome.action).click();
          await expect(page.getByTestId(outcome.target)).toBeVisible();
          expect(writes).toHaveLength(1);
          expect(writes[0]!.method).toBe(outcome.method);
          if (outcome.name === "going")
            await expect(page.getByTestId("rsvp-syncing")).toHaveText("Saved. Syncing to Discord.");
          const help = await helpBesideReservation(page);
          await help.click();
          await expect(page).toHaveURL(`${ORIGIN}/faq#faq-events`);
          expect(writes).toHaveLength(1);
        } finally {
          await context.close();
        }
      });
    }

    for (const malformed of [false, true]) {
      test(`${twin} ${viewport.width}: ${malformed ? "unreadable success" : "lost connection"} keeps refresh-before-retry and contextual help`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        try {
          const writes = await mount(
            context,
            twin,
            detailStates[1]!,
            malformed ? { status: 200, body: "not-json" } : { status: 0, abort: true },
          );
          const page = await context.newPage();
          await page.goto(`${ORIGIN}${DETAIL_PATH}`);
          await page.getByTestId("rsvp-going").click();
          await expect(page.getByTestId("rsvp-unknown")).toContainText(
            "We couldn't confirm your RSVP. Check the event before trying again.",
          );
          const refresh = page.getByTestId("rsvp-refresh");
          await expect(refresh).toHaveText("Refresh the event");
          await expect(refresh).toBeVisible();
          const action = page.getByTestId("rsvp-going");
          if (await action.count()) await expect(action).toBeDisabled();
          expect(writes).toHaveLength(1);
          if (!malformed) await capture(page, `${twin}-${viewport.width}-manual-recovery`);
          const help = await helpBesideReservation(page);
          // Contextual help must not steal recovery focus or re-enable a write.
          await expect(help).not.toBeFocused();
          await expect(refresh).toBeVisible();
          await help.click();
          expect(writes).toHaveLength(1);
        } finally {
          await context.close();
        }
      });
    }
  }
}
