// Unconditional Chromium contract: native GET, committed island state and the
// actual Kit endpoint. No server, database, external request or opt-in skip.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  WEEK_ORIGIN,
  WEEK_TWINS,
  probeChoice,
  weekChoice,
  weekFixture,
  weekPath,
  type WeekChoice,
  type WeekStart,
  type WeekTwin,
} from "../test/helpers/calendar-week-start-acceptance";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url).href).replace(/\/+$/, "");
const bundles = ["source", "shipped"] as const;
const sources = {
  source: readFileSync(
    fileURLToPath(new URL("../assets/islands/events-calendar.js", import.meta.url).href),
  ),
  shipped: readFileSync(
    fileURLToPath(new URL("../public/islands/events-calendar.js", import.meta.url).href),
  ),
};
const contexts: BrowserContext[] = [];
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});
afterAll(async () => {
  await browser?.close();
});

function browserHistory(action: string) {
  const history = (
    globalThis as unknown as { history: { length: number; back: () => void; forward: () => void } }
  ).history;
  if (action === "back") history.back();
  if (action === "forward") history.forward();
  return history.length;
}

async function open(
  twin: WeekTwin,
  bundle: (typeof bundles)[number],
  options: {
    path?: string;
    javaScriptEnabled?: boolean;
    viewport?: { width: number; height: number };
  } = {},
) {
  const fixture = weekFixture();
  const base = options.path ?? "/events?view=calendar&month=2027-02&game=Chess&past=1";
  const initialHtml = await (await fixture.render(twin, base)).text();
  const choice = probeChoice(initialHtml);
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    locale: "en-GB",
    timezoneId: "UTC",
  });
  contexts.push(context);
  const reads: { route: Route; path: string }[] = [];
  const documents: string[] = [];
  const forbidden: string[] = [];
  const errors: string[] = [];
  const assetFailures: string[] = [];
  let binderLoads = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== WEEK_ORIGIN) {
      forbidden.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/events") {
      expect(request.method()).toBe("GET");
      const path = url.pathname + url.search;
      if (request.headers()["x-two-island"] === "events-calendar") {
        reads.push({ route, path });
        return;
      }
      documents.push(path);
      const response = await fixture.render(twin, path);
      return route.fulfill({
        status: response.status,
        body: await response.text(),
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/islands/events-calendar.js") {
      binderLoads++;
      return route.fulfill({ body: sources[bundle], contentType: "application/javascript" });
    }
    const path = resolve(publicDir, `.${url.pathname}`);
    if (!path.startsWith(publicDir + "/")) {
      assetFailures.push(url.pathname);
      return route.abort();
    }
    try {
      const body = readFileSync(path);
      const types: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
      };
      return route.fulfill({
        body,
        contentType: types[extname(path)] ?? "application/octet-stream",
      });
    } catch {
      assetFailures.push(url.pathname);
      return route.abort();
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(WEEK_ORIGIN + base);
  await page.getByTestId("events-calendar-grid").waitFor();
  const firstDate = () => page.getByTestId("calendar-day").first().getAttribute("data-date");
  const headings = () => page.getByTestId("events-calendar-grid").locator("th").allTextContents();
  async function requireChoice(): Promise<WeekChoice> {
    const actual = weekChoice(await page.content());
    expect(
      actual,
      "WEEK_BROWSER_CONTROL_MISSING: expose a native Monday/Sunday GET choice",
    ).not.toBeNull();
    return actual!;
  }
  async function selectedWeek() {
    const actual = await requireChoice();
    // Native selection is a DOM property; serializing page.content() need not
    // update the original selected/checked attributes after a history turn.
    const selector = actual.kind === "select" ? "select" : 'input[type="radio"]:checked';
    return page
      .locator(`${selector}[name=${JSON.stringify(actual.name)}]`)
      .first()
      .inputValue();
  }
  async function choose(start: WeekStart) {
    const actual = await requireChoice();
    const control = page.locator(
      `${actual.kind === "select" ? "select" : 'input[type="radio"]'}[name=${JSON.stringify(actual.name)}]`,
    );
    if (actual.kind === "select")
      await control.filter({ visible: true }).selectOption(actual[start]);
    else
      await page
        .locator(
          `input[name=${JSON.stringify(actual.name)}][value=${JSON.stringify(actual[start])}]`,
        )
        .check();
    // Both explicit-submit and change-submit designs are valid. If change has
    // not already claimed the island, use the native form's keyboard submit.
    const busy = await page.getByTestId("events-calendar").getAttribute("aria-busy");
    if (busy !== "true") {
      const form = page.locator("form").filter({ has: control.first() }).first();
      const submitter = form
        .locator('button[type="submit"], button:not([type]), input[type="submit"]')
        .first();
      expect(
        await submitter.count(),
        "WEEK_NATIVE_SUBMIT_MISSING: offer a keyboard-operable GET submit",
      ).toBe(1);
      await submitter.focus();
      await page.keyboard.press("Enter");
    }
  }
  async function reply(index: number, status = 200, malformed = false) {
    await expect.poll(() => reads.length).toBeGreaterThan(index);
    const pending = reads[index]!;
    let body =
      status === 200
        ? await (await fixture.render(twin, pending.path, true)).text()
        : "Fixture unavailable";
    if (malformed) body = body.replace(/data-cal-zone="content"/g, 'data-refused-zone="content"');
    try {
      await pending.route.fulfill({ status, body, contentType: "text/html; charset=utf-8" });
    } catch (error) {
      if (!pending.route.request().failure()) throw error;
    }
  }
  async function settled(first: string) {
    await expect.poll(firstDate).toBe(first);
    await expect
      .poll(() => page.getByTestId("events-calendar").getAttribute("aria-busy"))
      .not.toBe("true");
  }
  function clean() {
    expect(errors).toEqual([]);
    expect(forbidden).toEqual([]);
    expect(assetFailures.filter((path) => /\.(?:css|js|woff2)$/.test(path))).toEqual([]);
    if (options.javaScriptEnabled !== false) expect(binderLoads).toBe(1);
  }
  return {
    page,
    context,
    fixture,
    choice,
    reads,
    documents,
    firstDate,
    headings,
    requireChoice,
    selectedWeek,
    choose,
    reply,
    settled,
    clean,
    base,
  };
}

for (const twin of WEEK_TWINS) {
  describe(`${twin} week-start browser controls`, () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ])
      it(`B00 ${viewport.width}: default and boundary baseline is a real styled native page`, async () => {
        const h = await open(twin, "shipped", { javaScriptEnabled: false, viewport });
        expect(await h.headings()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
        expect(await h.firstDate()).toBe("2027-02-01");
        await h.page.screenshot({
          path: `artifacts/calendar-week-start/${twin.toLowerCase()}-before-${viewport.width}.png`,
          fullPage: true,
        });
        for (const month of ["0001-01", "9999-12"]) {
          await h.page.goto(WEEK_ORIGIN + `/events?view=calendar&month=${month}`);
          await h.page.getByTestId("events-calendar-grid").waitFor();
          expect(await h.page.getByTestId("calendar-day").count()).toBe(35);
          await h.page.screenshot({
            path: `artifacts/calendar-week-start/${twin.toLowerCase()}-before-${month}-${viewport.width}.png`,
            fullPage: true,
          });
        }
        h.clean();
      });

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ])
      it(`B01 ${viewport.width}: no-JS Sunday choice submits the native GET and preserves month/game/past`, async () => {
        const h = await open(twin, "shipped", { javaScriptEnabled: false, viewport });
        const choice = await h.requireChoice();
        await h.choose("sunday");
        await h.settled("2027-01-31");
        const params = new URL(h.page.url()).searchParams;
        expect(params.getAll(choice.name)).toEqual([choice.sunday]);
        expect(params.get("month")).toBe("2027-02");
        expect(params.get("game")).toBe("Chess");
        expect(params.get("past")).toBe("1");
        expect(h.reads).toHaveLength(0);
        expect(h.documents).toHaveLength(2);
        expect(await h.headings()).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
        expect(await h.context.cookies()).toEqual([]);
        await h.page.screenshot({
          path: `artifacts/calendar-week-start/${twin.toLowerCase()}-sunday-${viewport.width}.png`,
          fullPage: true,
        });
        h.clean();
      });

    for (const bundle of bundles)
      describe(bundle, () => {
        it("B02 legacy month fetch/back control calibrates the held-response harness", async () => {
          const h = await open(twin, bundle);
          await h.page.getByRole("link", { name: "Next month", exact: true }).click();
          await h.reply(0);
          await h.settled("2027-03-01");
          await h.page.evaluate(browserHistory, "back");
          await h.reply(1);
          await h.settled("2027-02-01");
          expect(h.documents).toHaveLength(1);
          h.clean();
        });

        it("B03 Sunday selection and Back/Forward commit URL, cells and native choice together", async () => {
          const h = await open(twin, bundle);
          const choice = await h.requireChoice();
          const initialLength = await h.page.evaluate(browserHistory, "length");
          await h.choose("sunday");
          await h.reply(0);
          await h.settled("2027-01-31");
          expect(new URL(h.reads[0]!.path, WEEK_ORIGIN).searchParams.get(choice.name)).toBe(
            choice.sunday,
          );
          await h.page.getByRole("link", { name: "Next month", exact: true }).click();
          await h.reply(1);
          await h.settled("2027-02-28");
          await h.page.evaluate(browserHistory, "back");
          await h.reply(2);
          await h.settled("2027-01-31");
          expect(await h.selectedWeek()).toBe(choice.sunday);
          await h.page.evaluate(browserHistory, "back");
          await h.reply(3);
          await h.settled("2027-02-01");
          expect(await h.selectedWeek()).toBe(choice.monday);
          await h.page.evaluate(browserHistory, "forward");
          await h.reply(4);
          await h.settled("2027-01-31");
          expect(await h.selectedWeek()).toBe(choice.sunday);
          expect(await h.page.evaluate(browserHistory, "length")).toBe(initialLength + 2);
          expect(h.documents).toHaveLength(1);
          h.clean();
        });

        for (const failure of ["503", "malformed"] as const)
          it(`B04 ${failure}: failed layout change retains committed Sunday cells, URL and next-month intent`, async () => {
            const probe = weekFixture();
            const choice = probeChoice(
              await (await probe.render(twin, "/events?view=calendar&month=2027-02")).text(),
            );
            const h = await open(twin, bundle, {
              path: weekPath(
                "/events?view=calendar&month=2027-02&game=Chess&past=1",
                choice,
                "sunday",
              ),
            });
            await h.requireChoice();
            expect(await h.firstDate()).toBe("2027-01-31");
            const original = await h.page.locator('[data-cal-zone="content"]').innerHTML();
            const address = h.page.url();
            await h.choose("monday");
            await h.reply(0, failure === "503" ? 503 : 200, failure === "malformed");
            await expect.poll(() => h.page.getByTestId("events-read-retry").isVisible()).toBe(true);
            expect(h.page.url()).toBe(address);
            expect(await h.page.locator('[data-cal-zone="content"]').innerHTML()).toBe(original);
            const next = await h.page
              .getByRole("link", { name: "Next month", exact: true })
              .getAttribute("href");
            expect(new URL(next!, WEEK_ORIGIN).searchParams.get(choice.name)).toBe(choice.sunday);
            h.clean();
          });

        it("B05 superseded Monday fragment cannot overwrite a newer committed Sunday month", async () => {
          const probe = weekFixture();
          const choice = probeChoice(
            await (await probe.render(twin, "/events?view=calendar&month=2027-02")).text(),
          );
          const h = await open(twin, bundle, {
            path: weekPath("/events?view=calendar&month=2027-02", choice, "sunday"),
          });
          await h.requireChoice();
          await h.choose("monday");
          await expect.poll(() => h.reads.length).toBe(1);
          // Deliver a second, explicit Sunday/month GET intent while the old
          // response is parked. Hidden controls still dispatch native submits.
          await h.page.evaluate(
            ({ name, value }) => {
              type Form = {
                querySelector: (selector: string) => { value: string } | null;
                requestSubmit: () => void;
              };
              const doc = (
                globalThis as unknown as { document: { querySelector: (selector: string) => Form } }
              ).document;
              const form = doc.querySelector('[data-testid="calendar-month-jump"]');
              form.querySelector('[name="month"]')!.value = "2027-03";
              const field = form.querySelector(`[name=${JSON.stringify(name)}]`);
              if (field) field.value = value;
              form.requestSubmit();
            },
            { name: choice.name, value: choice.sunday },
          );
          await h.reply(1);
          await h.settled("2027-02-28");
          await h.reply(0);
          await h.settled("2027-02-28");
          expect(new URL(h.page.url()).searchParams.get(choice.name)).toBe(choice.sunday);
          expect(await h.selectedWeek()).toBe(choice.sunday);
          expect(h.documents).toHaveLength(1);
          h.clean();
        });
      });
  });
}
