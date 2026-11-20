import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { viewportPngs } from "./kit-activity-log-png.mjs";

export const origin = "http://127.0.0.1:8788";
export const path = "/admin/activity-log";
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

export const kitDocument = (status, headers) =>
  status === 200 &&
  headers["x-two-renderer"] === "kit" &&
  headers["cache-control"] === "private, no-store";

export function validateView(content, state, empty, keyboard) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(content, expectedContent(empty))) throw new Error("visual content drift");
  if (!same(state, [true, keyboard, keyboard])) throw new Error("visual state drift");
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
    if (res.status() !== 200) return false;
    if (
      document
        ? !kitDocument(res.status(), res.headers())
        : !(await readFile(`web/.svelte-kit/cloudflare${file}`)).equals(await res.body())
    )
      return false;
    await route.fulfill({ response: res });
    return true;
  } finally {
    await res.dispose();
  }
}

const regionId = "activity-log-table-scroll";
async function inspect(page, empty, keyboard) {
  const [content, state] = await page.getByTestId(regionId).evaluate((el) => {
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

async function guardedPage(browser, session, [width, height], url, render, reportOnly) {
  const viewport = { width, height };
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    javaScriptEnabled: false,
  });
  let violation = false;
  let unavailable = false;
  let result;
  try {
    await context.addCookies([session]);
    await context.route("**/*", async (route) => {
      const verified = await serve(route, url).catch(() => false);
      if (verified) return;
      violation ||= verified === false || !reportOnly;
      unavailable ||= verified === null;
      await route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const markViolation = () => {
      violation = true;
    };
    page.on("pageerror", markViolation);
    if (!reportOnly) page.on("console", markViolation);
    const response = await page.goto(url).catch(() => null);
    if (
      !unavailable &&
      (!response || response.url() !== url || !kitDocument(response.status(), response.headers()))
    )
      throw new Error("visual provenance drift");
    if (!unavailable) result = await render(page);
  } finally {
    await context.close();
  }
  if (violation) throw new Error("unexpected visual diagnostic");
  return unavailable ? null : result;
}

export async function collectVisuals(browser, session, dir, audit, measure) {
  const views = { ...viewportPngs, lighthouse: viewportPngs["populated-desktop.png"] };
  for (const [name, size] of Object.entries(views)) {
    const reportOnly = name === "lighthouse";
    const empty = name.startsWith("empty-");
    const keyboard = name === "keyboard-mobile.png";
    const url = urlFor(empty);
    const render = async (page) => {
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await inspect(page, empty, false);
      if (reportOnly) return measure(page, url).catch(() => null);
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
    const result = await guardedPage(browser, session, size, url, render, reportOnly);
    if (reportOnly) return result;
  }
}
