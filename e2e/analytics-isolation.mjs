import assert from "node:assert/strict";
import { parse, serialize } from "parse5";

export const BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js";
export const COLLECTOR_PATH = "/cdn-cgi/rum";

function isBeaconScript(url) {
  return (
    url.origin === "https://static.cloudflareinsights.com" &&
    /^\/beacon\.min\.js(?:\/[a-z0-9]+)?$/i.test(url.pathname)
  );
}

function scanHtml(html, documentUrl, prepareReplay = false) {
  const counts = { scripts: 0, beacons: 0, otherTracking: 0 };
  const document = parse(html);
  function visit(node) {
    const attributes = new Map(node.attrs?.map(({ name, value }) => [name, value]));
    const source = attributes.get("src") ?? attributes.get("href");
    const url = source ? URL.parse(source, documentUrl) : null;
    const beacon = url !== null && isBeaconScript(url);
    if (node.tagName === "script") counts.scripts++;
    if (node.tagName === "script" && beacon) {
      counts.beacons++;
      // The original SRI hash pins the vendor bytes. The replay supplies our
      // own script, after the unmodified HTML has been inspected separately.
      if (prepareReplay) node.attrs = node.attrs.filter(({ name }) => name !== "integrity");
    } else if (
      attributes.has("data-cf-beacon") ||
      (url &&
        (url.hostname === "cloudflareinsights.com" ||
          url.hostname.endsWith(".cloudflareinsights.com") ||
          /^\/cdn-cgi\/(?:rum|zaraz)(?:\/|$)/i.test(url.pathname)))
    ) {
      counts.otherTracking++;
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
  return { counts, html: prepareReplay ? serialize(document) : html };
}

export function inspectAnalyticsHtml(html, documentUrl) {
  return scanHtml(html, documentUrl).counts;
}

// Both the script and its POST are fulfilled in Chromium. No route continues
// out of the browser. This is deliberately not the provider's script or receipt.
const fakeBeacon = `
  const root = document.documentElement;
  root.dataset.fakeBeaconExecutions = String(Number(root.dataset.fakeBeaconExecutions || 0) + 1);
  fetch(${JSON.stringify(COLLECTOR_PATH)}, { method: 'POST', keepalive: true }).then((response) => {
    if (response.status === 204) root.dataset.fakeCollectorAnswered = 'yes';
  });
`;

export async function observeAnalytics(browser, { url, html, javaScriptEnabled, allowed }) {
  const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
  const counts = { loads: 0, executions: 0, collections: 0, blocked: 0, errors: 0 };
  const target = new URL(url);
  try {
    const replay = allowed ? scanHtml(html, url, true).html : html;
    await context.routeWebSocket("**/*", async (socket) => {
      counts.blocked++;
      await socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const requested = new URL(request.url());
      const method = request.method();
      const type = request.resourceType();
      if (method === "GET" && type === "document" && requested.href === target.href) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: replay });
      } else if (allowed && method === "GET" && type === "script" && isBeaconScript(requested)) {
        counts.loads++;
        await route.fulfill({
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
          body: fakeBeacon,
        });
      } else if (
        allowed &&
        method === "POST" &&
        requested.href === target.origin + COLLECTOR_PATH
      ) {
        counts.collections++;
        await route.fulfill({ status: 204 });
      } else if (
        method === "GET" &&
        requested.origin === target.origin &&
        !requested.pathname.toLowerCase().startsWith("/cdn-cgi/") &&
        ["stylesheet", "image", "font"].includes(type)
      ) {
        await route.fulfill({ status: 204 });
      } else {
        counts.blocked++;
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    page.on("pageerror", () => counts.errors++);
    await page.goto(url, { timeout: 10_000 });
    if (allowed) {
      await page.waitForFunction(
        () => document.documentElement.dataset.fakeCollectorAnswered === "yes",
        {
          timeout: 5_000,
        },
      );
    }
    const executions = await page.locator("html").getAttribute("data-fake-beacon-executions");
    counts.executions = Number(executions ?? 0);
    const inventory = inspectAnalyticsHtml(await page.content(), url);
    if (target.pathname === "/privacy") {
      await page
        .getByRole("heading", { level: 1, name: "Privacy policy", exact: true })
        .waitFor({ timeout: 5_000 });
      await page
        .getByRole("heading", { level: 2, name: "Who we are, and what this covers", exact: true })
        .waitFor({ timeout: 5_000 });
      await page
        .getByRole("heading", { level: 2, name: "Cookies and tracking", exact: true })
        .waitFor({ timeout: 5_000 });
    }
    return {
      ...counts,
      ...inventory,
      initializations: Number(
        (await page.locator("html").getAttribute("data-analytics-initializations")) ?? 0,
      ),
    };
  } finally {
    await context.close();
  }
}

export function assertAnalyticsObservation(observed, allowed) {
  const expected = allowed ? 1 : 0;
  assert.equal(observed.beacons, expected, "Beacon elements in the browser");
  assert.equal(observed.otherTracking, 0, "Other Analytics or Zaraz markup in the browser");
  assert.equal(observed.loads, expected, "Fake beacon script loads");
  assert.equal(observed.executions, expected, "Fake beacon executions");
  assert.equal(observed.collections, expected, "Fake collector POSTs");
  assert.equal(observed.blocked, 0, "Blocked browser requests");
  assert.equal(observed.errors, 0, "Browser script errors");
}
