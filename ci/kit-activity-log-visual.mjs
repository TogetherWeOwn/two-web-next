import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { viewportPngs } from "./kit-activity-log-png.mjs";

export const origin = "http://127.0.0.1:8788";
export const path = "/admin/activity-log";
export const browserWorkMs = 120_000; // Leave 30s for startup and teardown.
export class BrowserDeadline extends Error {}
export class AssertionFailure extends Error {}
export async function withDeadline(work, ms = 5_000) {
  if (ms <= 0) throw new BrowserDeadline();
  const expires = performance.now() + ms;
  const { promise, reject } = Promise.withResolvers();
  const timer = setTimeout(reject, ms, new BrowserDeadline());
  const task = Promise.resolve().then(work);
  const result = await Promise.race([task, promise]).finally(() => clearTimeout(timer));
  if (performance.now() >= expires) throw new BrowserDeadline();
  return result;
}
const subject = "zz-no-activity";
const scrollRegion = "activity-log-table-scroll";
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
const assetFile = (href) => (href.startsWith(origin) ? href.slice(origin.length) : "");
const allowedRequest = (req, url) =>
  req.method() === "GET" &&
  (req.isNavigationRequest() ? req.url() === url : asset.test(assetFile(req.url())));
async function serve(route, allowed, stopped, offline, deny) {
  const req = route.request();
  if (!allowed(req)) return deny();
  if (stopped()) return;
  const file = assetFile(req.url());
  const document = req.isNavigationRequest();
  const res = await route.fetch({ maxRedirects: 0, timeout: 5_000 });
  try {
    const matches = async () =>
      (await res.body()).equals(await readFile(`web/.svelte-kit/cloudflare${file}`));
    const valid = document
      ? kitDocument(res.status(), res.headers())
      : res.status() === 200 && (await matches().catch(() => false));
    if (!valid) deny();
    if (stopped()) return;
    if (valid) await route.fulfill({ response: res });
    return valid;
  } finally {
    // Disposal cannot delay or replace a policy verdict.
    void res.dispose().catch(offline);
  }
}

async function inspect(page, empty, keyboard) {
  const [content, state] = await page.getByTestId(scrollRegion).evaluate((el) => {
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

export async function prepareDesktopAudit(page, step = () => {}) {
  // Call on the blank page. Use the same CDP session for both transitions:
  // a second session cannot clear Playwright's context-wide scripting override.
  step("SCRIPT_SESSION");
  const session = await withDeadline(() => page.context().newCDPSession(page));
  const disable = (value) =>
    withDeadline(() => session.send("Emulation.setScriptExecutionDisabled", { value }));
  step("SCRIPT_DISABLE");
  await disable(true);
  return async (audit) => {
    // The page was loaded and captured with scripting disabled. Add a policy
    // without replacing the original CSP before enabling axe's timers.
    step("AUDIT_POLICY");
    await withDeadline(() =>
      page.evaluate(() => {
        const policy = document.createElement("meta");
        policy.httpEquiv = "Content-Security-Policy";
        policy.content = "script-src 'none'; worker-src 'none'";
        document.head.prepend(policy);
      }),
    );
    step("AUDIT_ENABLE");
    const verdict = disable(false).then(audit);
    // Keep the override attached until context close, including after the audit.
    return verdict
      .then(() => step("AUDIT_RESTORE"))
      .finally(() => disable(true))
      .finally(() => verdict);
  };
}

async function guardedPage(browser, mintModerator, [width, height], url, render, options) {
  const { step, signal, TimeoutError, reportOnly, desktopAudit } = options;
  step("CONTEXT_NEW");
  const context = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: "block",
    javaScriptEnabled: desktopAudit, // Desktop audit uses a page override before navigation.
  });
  let stopped = false;
  let auditedDocument = false;
  const allowed = (req) =>
    allowedRequest(req, url) && !(auditedDocument && req.isNavigationRequest());
  const closed = () => stopped || signal.aborted;
  let unavailable = false;
  let result;
  const pending = new Set();
  const settle = async () => {
    while (pending.size) await Promise.all(pending);
  };
  const { promise, reject } = Promise.withResolvers();
  const markViolation = () => reject(new AssertionFailure("unexpected visual diagnostic"));
  const guard = (work) => Promise.race([promise, work]);
  const offline = (error) => (unavailable ||= error);
  try {
    step("COOKIE");
    await context.addCookies([await mintModerator()]);
    // Playwright stops calling route handlers during close but still emits request events.
    context.on("request", (req) => {
      if (closed() && !allowed(req)) markViolation();
    });
    step("ROUTE");
    await context.route("**/*", async (route) => {
      const check = serve(route, allowed, closed, offline, markViolation).catch((error) => {
        // Record a required document timeout before abort makes goto fail generically.
        if (!reportOnly && error instanceof TimeoutError && route.request().isNavigationRequest())
          reject(error);
        offline(error);
      });
      pending.add(check);
      const verified = await check;
      pending.delete(check);
      if (!verified) await route.abort().catch(() => undefined);
    });
    step("PAGE");
    const page = await guard(context.newPage());
    page.setDefaultTimeout(5_000);
    page.on("pageerror", markViolation);
    page.on("framenavigated", () => {
      if (auditedDocument) markViolation();
    });
    if (!reportOnly) page.on("console", markViolation);
    const runAudit = desktopAudit ? await guard(prepareDesktopAudit(page, step)) : null;
    // Keep the committed document even if optional Lighthouse loading times out.
    step("NAVIGATE");
    const goto = page.goto(url, { waitUntil: reportOnly ? "commit" : "load" });
    const [navigation] = await guard(Promise.allSettled([goto]));
    const response = navigation.status === "fulfilled" ? navigation.value : null;
    if (reportOnly && response) {
      step("LOAD");
      await guard(page.waitForLoadState("load").catch(offline));
    }
    step("ROUTES_PENDING");
    await guard(withDeadline(settle));
    if (navigation.status === "rejected" && !(reportOnly && unavailable)) throw navigation.reason;
    const valid = response?.url() === url && kitDocument(response.status(), response.headers());
    if (!(response ? valid : unavailable)) throw new AssertionFailure("visual provenance drift");
    if (unavailable && !reportOnly) throw unavailable;
    const audit =
      runAudit &&
      ((check) => {
        auditedDocument = true;
        return runAudit(check);
      });
    if (response) result = await guard(render(page, unavailable, audit));
  } finally {
    stopped = true;
  }
  step("ROUTES_PENDING", "TEARDOWN");
  await guard(withDeadline(settle));
  step("CONTEXT_CLOSE", "TEARDOWN");
  await guard(withDeadline(() => context.close()));
  if (unavailable && !reportOnly) throw unavailable;
  return unavailable ? null : result;
}
async function boundedMeasurement(measure, ms) {
  // Reserve time for verdicts and teardown within the cumulative browser budget.
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
  const { audit, measure, mark, ms = 25_000 } = options;
  const views = { ...viewportPngs, lighthouse: viewportPngs["populated-desktop.png"] };
  for (const [name, size] of Object.entries(views)) {
    const reportOnly = name === "lighthouse";
    const empty = name.startsWith("empty-");
    const keyboard = name === "keyboard-mobile.png";
    const url = urlFor(empty);
    const stage = reportOnly ? "LIGHTHOUSE" : "CAPTURE";
    const viewport = reportOnly
      ? "POPULATED_DESKTOP"
      : name.slice(0, -4).replace("-", "_").toUpperCase();
    const step = (operation, current = stage) => mark(current, viewport, operation);
    const desktopAudit = name.endsWith("desktop.png");
    const render = async (page, unavailable, runAudit) => {
      step("WAIT", "FONTS");
      const fonts = () => page.evaluate(() => document.fonts.ready.then(() => true));
      const ready = await withDeadline(fonts).catch((error) => {
        if (!reportOnly || !(error instanceof BrowserDeadline)) throw error;
      });
      step("INSPECT");
      await inspect(page, empty, false);
      if (reportOnly) {
        step("MEASURE");
        return ready && !unavailable ? boundedMeasurement(() => measure(page, url), ms) : null;
      }
      if (keyboard) {
        step("KEYBOARD_TAB");
        for (let n = 0; n < 11; n++) await page.keyboard.press("Tab");
        step("KEYBOARD_ARROW");
        await page.keyboard.press("ArrowRight");
        step("KEYBOARD_SCROLL");
        // The locator retries from the driver. Page waitForFunction needs page animation frames.
        await page
          .getByTestId(scrollRegion)
          .waitForFunction((el) => document.activeElement === el && el.scrollLeft > 0);
        step("KEYBOARD_INSPECT");
        await inspect(page, empty, true);
      }
      step("SCREENSHOT");
      await page.screenshot({ path: join(dir, name), animations: "disabled" });
      if (desktopAudit) await runAudit(() => audit(page, name, (stage) => step("RUN", stage)));
      step("VERIFY");
      await inspect(page, empty, keyboard);
    };
    const result = await guardedPage(browser, mint, size, url, render, {
      ...options,
      reportOnly,
      desktopAudit,
      step,
    });
    if (reportOnly) return result;
  }
}
