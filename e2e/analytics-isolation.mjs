import assert from "node:assert/strict";
import { parse, serialize } from "parse5";

export const BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js";
const COLLECTOR_PATH = "/cdn-cgi/rum";

function isBeaconScript(url) {
  const beaconPath = /^\/beacon\.min\.js(?:\/[a-z0-9]+)?$/i;
  return url.origin === "https://static.cloudflareinsights.com" && beaconPath.test(url.pathname);
}

export function inspectAnalyticsHtml(html, documentUrl, prepareReplay = false) {
  const counts = { scripts: 0, beacons: 0, otherTracking: 0 };
  const document = parse(html);
  function visit(node) {
    const attributes = new Map(node.attrs?.map(({ name, value }) => [name, value]));
    const source = attributes.get("src") ?? attributes.get("href");
    const url = source ? URL.parse(source, documentUrl) : null;
    if (node.tagName === "script") counts.scripts++;
    if (node.tagName === "script" && url && isBeaconScript(url)) {
      counts.beacons++;
      // The original integrity hash pins the vendor bytes. Replay uses fake bytes.
      if (prepareReplay) node.attrs = node.attrs.filter(({ name }) => name !== "integrity");
    } else if (
      attributes.has("data-cf-beacon") ||
      (url &&
        (/(^|\.)cloudflareinsights\.com$/.test(url.hostname) ||
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

export function assertScriptInventory(counts, scripts, beacons = scripts) {
  assert.equal(counts.scripts, scripts, "Script elements");
  assert.equal(counts.beacons, beacons, "Beacon elements");
  assert.equal(counts.otherTracking, 0, "Other tracking markup");
}

const fakeBeacon = `
  const root = document.documentElement;
  root.dataset.fakeBeaconExecutions = String(Number(root.dataset.fakeBeaconExecutions || 0) + 1);
  fetch(${JSON.stringify(COLLECTOR_PATH)}, { method: 'POST', keepalive: true }).then((response) => {
    if (response.status === 204) root.dataset.fakeCollectorAnswered = 'yes';
  });
`;

export async function observeAnalytics(
  browser,
  { url, html, javaScriptEnabled = true, allowed = false },
) {
  const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
  const counts = { loads: 0, collections: 0, blocked: 0, errors: 0 };
  const target = new URL(url);
  try {
    const replay = allowed ? inspectAnalyticsHtml(html, url, true).html : html;
    await context.routeWebSocket("**/*", (socket) => {
      counts.blocked++;
      return socket.close();
    });
    await context.route("**/*", (route) => {
      const request = route.request();
      const requested = new URL(request.url());
      const method = request.method();
      const type = request.resourceType();
      if (method === "GET" && type === "document" && requested.href === target.href) {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: replay });
      }
      if (allowed && method === "GET" && type === "script" && isBeaconScript(requested)) {
        counts.loads++;
        return route.fulfill({
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
          body: fakeBeacon,
        });
      }
      const collector = requested.href === target.origin + COLLECTOR_PATH;
      if (allowed && method === "POST" && collector) {
        counts.collections++;
        return route.fulfill({ status: 204 });
      }
      if (
        method === "GET" &&
        requested.origin === target.origin &&
        !requested.pathname.toLowerCase().startsWith("/cdn-cgi/") &&
        ["stylesheet", "image", "font"].includes(type)
      ) {
        return route.fulfill({ status: 204 });
      }
      counts.blocked++;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", () => counts.errors++);
    await page.goto(url, { timeout: 10_000 });
    if (allowed) {
      const receipt = page.locator('html[data-fake-collector-answered="yes"]');
      await receipt.waitFor({ state: "attached", timeout: 5_000 });
    }
    if (target.pathname === "/privacy") {
      const headings = [
        [1, "Privacy policy"],
        [2, "Who we are, and what this covers"],
        [2, "Cookies and tracking"],
      ];
      for (const [level, name] of headings) {
        await page.getByRole("heading", { level, name, exact: true }).waitFor({ timeout: 5_000 });
      }
    }
    const root = page.locator("html");
    return {
      ...counts,
      ...inspectAnalyticsHtml(await page.content(), url).counts,
      executions: Number(await root.getAttribute("data-fake-beacon-executions")),
      initializations: Number(await root.getAttribute("data-analytics-initializations")),
    };
  } finally {
    await context.close();
  }
}

export function assertAnalyticsObservation(observed, expected, expectedScripts = expected) {
  assertScriptInventory(observed, expectedScripts, expected);
  for (const key of ["loads", "executions", "collections"])
    assert.equal(observed[key], expected, key);
  assert.equal(observed.blocked, 0, "Blocked browser requests");
  assert.equal(observed.errors, 0, "Browser script errors");
}
