import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { viewportPngs } from "./kit-activity-log-png.mjs";

export const origin = "http://127.0.0.1:8788";
export const path = "/admin/activity-log";
// Reserve 30 seconds of the shell watchdog for startup slop and final teardown.
export const browserWorkMs = 120_000;
export class BrowserDeadline extends Error {}
export class AssertionFailure extends Error {}
export async function withDeadline(work, ms = 5_000) {
  if (ms <= 0) throw new BrowserDeadline();
  const expires = performance.now() + ms;
  const deadline = Promise.withResolvers();
  const timer = setTimeout(() => deadline.reject(new BrowserDeadline()), ms);
  try {
    const result = await Promise.race([work(), deadline.promise]);
    if (performance.now() >= expires) throw new BrowserDeadline();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
const subject = "zz-no-activity";
const urlFor = (empty) => `${origin}${path}${empty ? `?subject=${subject}` : ""}`;
const shell = "Skip to content TWO admin Events · Featured · Join attempts · Activity log · Site";
const intro =
  "Activity log Read-only. Who changed what, when (UTC). Views that name a member are access-logged; imported causer IDs are labeled legacy.";
const form = "Subject Causer Filter Scroll horizontally to see all columns on smaller screens.";
const rows = Array.from({ length: 50 }, (_, index) => {
  const n = 120 - index;
  const time = new Date(Date.UTC(2098, 0, 1, 0, n)).toISOString().slice(11, 19);
  const who = ["900000000000009311", "900000000000009312", "7 (legacy ID)", "—"][n % 4];
  return `${who}|kal-${String(n).padStart(3, "0")}|2098-01-01 ${time} UTC|Synthetic k${n} (updated)`;
});
export function expectedContent(empty) {
  const cells = empty ? ["No activity matches these filters."] : rows;
  const table = cells.join(" ").replaceAll("|", " ");
  const actions = empty ? "Clear filters Page 1" : "Page 1 Next";
  const text = `${shell} ${intro} ${form} Who What When (UTC) Subject ${table} ${actions} Together We Own · moderators only`;
  return [text, cells, [empty ? subject : "", ""], `${path}?page=${empty ? 1 : 2}`];
}

const kitDocument = (status, headers) =>
  status === 200 &&
  headers["x-two-renderer"] === "kit" &&
  headers["cache-control"] === "private, no-store";
export function validateView(content, state, empty, keyboard) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(content, expectedContent(empty))) throw new AssertionFailure("visual content drift");
  if (!same(state, [true, keyboard, keyboard])) throw new AssertionFailure("visual state drift");
}
// The asset allowlist also requires the response bytes to match the pinned local build.
const asset =
  /^\/(?:styles\.css|admin-rsvp-review\.css|site\.webmanifest|favicon\.(?:ico|svg)|icons\/(?:icon-(?:192|512)|maskable-512|apple-touch-icon)\.png|fonts\/(?:mona-sans-latin-(?:var|wght)|fragment-mono-latin-400|instrument-serif-latin-400-italic)\.woff2|islands\/auth-status\.js|_app\/immutable\/(?:assets|entry|nodes|chunks)\/[\w.-]+\.(?:css|js))$/;
async function serve(route, url) {
  const req = route.request();
  const file = req.url().startsWith(origin) ? req.url().slice(origin.length) : "";
  const document = req.isNavigationRequest();
  if (req.method() !== "GET" || !(document ? req.url() === url : asset.test(file))) return false;
  const res = await route.fetch({ maxRedirects: 0, timeout: 5_000 }).catch(() => null);
  if (!res) return null;
  try {
    const valid = document
      ? kitDocument(res.status(), res.headers())
      : res.status() === 200 &&
        (await readFile(`web/.svelte-kit/cloudflare${file}`)).equals(await res.body());
    if (valid) await route.fulfill({ response: res });
    return valid;
  } finally {
    await res.dispose();
  }
}

async function inspect(page, empty, keyboard) {
  const [content, state] = await page.getByTestId("activity-log-table-scroll").evaluate((el) => {
    const text = (node) => node.innerText.replace(/\s+/g, " ").trim();
    const all = (selector, mapper) => Array.from(document.querySelectorAll(selector), mapper);
    const cell = (node) => (node.checkVisibility({ checkOpacity: true }) ? text(node) : "[hidden]");
    const rows = all("table tbody tr", (row) => Array.from(row.cells, cell).join("|"));
    const fields = all(
      "form input",
      (node) => node.matches("input[type=search]:is(#subject,#causer)") && node.value,
    );
    const link = document.querySelector("[rel=next], [data-testid=activity-log-recovery] a");
    const unexpected = document.querySelector(
      "img, svg, canvas, iframe, object, embed, video, select, textarea",
    );
    const shape = document.title === "Activity log — TWO admin" && el.tabIndex === 0 && !unexpected;
    const outline = parseFloat(getComputedStyle(el).outlineWidth);
    const top = el.getBoundingClientRect().top;
    const focus = el.matches(":focus-visible") && outline > 0 && top >= 0 && top < innerHeight;
    return [
      [text(document.body), rows, fields, link?.getAttribute("href")],
      [shape, focus, el.scrollLeft > 0],
    ];
  });
  validateView(content, state, empty, keyboard);
}

async function guardedPage(browser, mintModerator, [width, height], url, guard) {
  const { render, reportOnly, TimeoutError, mark } = guard;
  const context = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: "block",
    javaScriptEnabled: false,
  });
  let violation = false;
  let unavailable = false;
  let stopped = false;
  let result;
  const pending = new Set();
  const settle = async () => {
    while (pending.size) await Promise.all(pending);
  };
  try {
    await context.addCookies([await mintModerator()]);
    await context.route("**/*", async (route) => {
      if (stopped) return route.abort().catch(() => undefined);
      const check = serve(route, url).catch(() => false);
      pending.add(check);
      const verified = await check;
      violation ||= verified === false;
      unavailable ||= verified === null;
      pending.delete(check);
      if (!verified) await route.abort().catch(() => undefined);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const markViolation = () => {
      violation = true;
    };
    page.on("pageerror", markViolation);
    if (!reportOnly) page.on("console", markViolation);
    const { response, error } = await page.goto(url).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    // Settle the route guard before attributing any navigation failure.
    await settle();
    const valid = response?.url() === url && kitDocument(response.status(), response.headers());
    if (error && !violation && (!unavailable || (!reportOnly && error instanceof TimeoutError)))
      throw error;
    if (!(response ? valid : unavailable)) throw new AssertionFailure("visual provenance drift");
    if (!violation && !unavailable) result = await render(page);
  } finally {
    // Stop requests before the final verdict or unwinding to outer browser teardown.
    stopped = true;
  }
  await withDeadline(settle);
  if (violation || (unavailable && !reportOnly))
    throw new AssertionFailure("unexpected visual diagnostic");
  mark("TEARDOWN");
  await withDeadline(() => context.close());
  if (violation) throw new AssertionFailure("unexpected visual diagnostic");
  return unavailable ? null : result;
}
async function boundedMeasurement(measure, ms) {
  const budget = Math.min(ms, browserWorkMs - 12_000 - performance.now());
  if (budget <= 0) return null;
  const timer = new AbortController();
  const task = Promise.resolve()
    .then(measure)
    .catch(() => null);
  const deadline = delay(budget, null, { signal: timer.signal });
  return Promise.race([task, deadline]).finally(() => timer.abort());
}
export async function collectVisuals(browser, mint, dir, options) {
  const { audit, measure, mark, TimeoutError = BrowserDeadline, ms = 25_000 } = options;
  const views = { ...viewportPngs, lighthouse: viewportPngs["populated-desktop.png"] };
  for (const [name, size] of Object.entries(views)) {
    const reportOnly = name === "lighthouse";
    const empty = name.startsWith("empty-");
    const keyboard = name === "keyboard-mobile.png";
    const url = urlFor(empty);
    const stage = reportOnly ? "LIGHTHOUSE" : "CAPTURE";
    if (reportOnly && (ms <= 0 || performance.now() >= browserWorkMs - 30_000)) return null;
    mark(stage);
    const render = async (page) => {
      mark("FONTS");
      const ready = await withDeadline(() =>
        page.evaluate(() => document.fonts.ready.then(() => true)),
      ).catch((error) => {
        if (reportOnly && error instanceof BrowserDeadline) return false;
        throw error;
      });
      mark(stage);
      await inspect(page, empty, false);
      if (reportOnly) return ready ? boundedMeasurement(() => measure(page, url), ms) : null;
      if (keyboard) {
        for (let n = 0; n < 11; n++) await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
        await inspect(page, empty, true);
      }
      await page.screenshot({ path: join(dir, name), animations: "disabled" });
      if (name.endsWith("desktop.png")) await audit(page, name);
      await inspect(page, empty, keyboard);
    };
    const guard = { render, reportOnly, TimeoutError, mark };
    const result = await guardedPage(browser, mint, size, url, guard);
    if (reportOnly) return result;
  }
}
