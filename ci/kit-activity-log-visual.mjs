import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { viewportPngs } from "./kit-activity-log-png.mjs";

const origin = "http://127.0.0.1:8788";
const path = "/admin/activity-log";
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
  const actions = empty ? "Clear filters Page 1" : "Page 1 Next";
  const table = cells.join(" ").replaceAll("|", " ");
  const text = `${shell} ${intro} ${form} Who What When (UTC) Subject ${table} ${actions} Together We Own · moderators only`;
  return [text, cells, [empty ? subject : "", ""], `${path}?page=${empty ? 1 : 2}`];
}

export function validateView(response, content, state, empty, keyboard) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(response, [urlFor(empty), 200, "kit", "private, no-store"]))
    throw new Error("visual provenance drift");
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
  const res = await route.fetch({ maxRedirects: 0, timeout: 5_000 });
  try {
    if (res.status() !== 200) return false;
    if (!document) {
      const pinned = await readFile(`web/.svelte-kit/cloudflare${file}`);
      if (!pinned.equals(await res.body())) return false;
    }
    await route.fulfill({ response: res });
    return true;
  } finally {
    await res.dispose();
  }
}

const regionId = "activity-log-table-scroll";
async function inspect(page, nav, empty, keyboard) {
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
  validateView(nav, content, state, empty, keyboard);
}

export async function collectVisuals(browser, session, dir, audit) {
  for (const [name, [width, height]] of Object.entries(viewportPngs)) {
    const empty = name.startsWith("empty-");
    const keyboard = name === "keyboard-mobile.png";
    const url = urlFor(empty);
    const context = await browser.newContext({
      viewport: { width, height },
      serviceWorkers: "block",
      javaScriptEnabled: false,
    });
    let unexpected = false;
    try {
      await context.addCookies([session]);
      await context.route("**/*", async (route) => {
        if (await serve(route, url).catch(() => false)) return;
        unexpected = true;
        await route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const drift = () => {
        unexpected = true;
      };
      page.on("pageerror", drift);
      page.on("console", drift);
      let nav;
      page.on("response", (res) => {
        const { "x-two-renderer": renderer, "cache-control": cache } = res.headers();
        if (res.request().isNavigationRequest()) nav = [res.url(), res.status(), renderer, cache];
      });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await inspect(page, nav, empty, false);
      if (keyboard) {
        for (let n = 0; n < 11; n++) await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
      }
      await inspect(page, nav, empty, keyboard);
      await page.screenshot({ path: join(dir, name), animations: "disabled" });
      await audit(page, name, url);
      await inspect(page, nav, empty, keyboard);
    } finally {
      await context.close();
    }
    if (unexpected) throw new Error("unexpected visual diagnostic");
  }
}
