import { expect, test as base, type Page, type Response } from "@playwright/test";
import { installReadOnlyGuard, requireWatchOrigin, WATCH_ORIGINS } from "../watch-guard.mjs";

// GET-only guest journeys for the 48h post-flip watch (docs/runbook.md "48h
// post-flip watch", docs/48h-watch-spec.md route classes). Fresh context, no
// session, no cookies, no sign-in, no RSVP, no join, no OAuth or Discord CTA
// click: every journey is one navigation to a public URL. A context-level
// route aborts any non-GET/HEAD request and the test then fails.
// The config pins baseURL from the same variable; asserting here too keeps the
// spec fail-closed if it is ever run under another config.
requireWatchOrigin(process.env.WATCH_ORIGIN);

// The Next Worker stamps this marker on `/up` only (src/index.tsx). It is the
// proof that the origin serves two-web-next rather than the legacy app, so
// `/up` must carry it. Any other journey that carries the header must carry the
// same value; a legacy `two-web` or foreign marker fails the run.
const ORIGIN_MARKER = "two-web-next";

const test = base.extend<{ guard: Awaited<ReturnType<typeof installReadOnlyGuard>> }>({
  guard: [
    async ({ context }, use) => {
      expect(await context.cookies(), "guest journeys start with no cookies").toEqual([]);
      const guard = await installReadOnlyGuard(context);
      await use(guard);
      guard.assertClean();
    },
    { auto: true },
  ],
});

// Console errors, uncaught page errors and failed or error-status subresource
// requests all count as breakage. The main document status is asserted
// separately against each journey's expected status.
function observe(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    problems.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  page.on("response", (response) => {
    const request = response.request();
    if (response.status() >= 400 && !request.isNavigationRequest()) {
      problems.push(`subresource ${response.status()}: ${request.method()} ${request.url()}`);
    }
  });
  return problems;
}

// Navigates once and applies the checks common to every journey: expected
// status, a final URL still on an allowlisted origin, no redirect other than a
// host canonicalization of the same path, and the origin marker rule above.
async function visit(page: Page, path: string, status: number): Promise<Response> {
  const response = await page.goto(path, { waitUntil: "load" });
  if (response === null) throw new Error(`no response for ${path}`);
  expect(response.status(), `${path} status`).toBe(status);

  const finalUrl = new URL(response.url());
  expect(WATCH_ORIGINS, `${path} final origin`).toContain(finalUrl.origin);
  if (response.request().redirectedFrom() !== null) {
    expect(finalUrl.pathname, `${path} redirect keeps the path`).toBe(path);
    test
      .info()
      .annotations.push({ type: "redirect", description: `${path} -> ${finalUrl.origin}` });
  }

  const marker = await response.headerValue("x-two-origin");
  if (path === "/up") expect(marker, "/up X-TWO-Origin").toBe(ORIGIN_MARKER);
  else if (marker !== null) expect(marker, `${path} X-TWO-Origin`).toBe(ORIGIN_MARKER);
  return response;
}

async function expectHtmlPage(page: Page, response: Response) {
  expect(response.headers()["content-type"]).toMatch(/^text\/html\b/);
  await expect(page.locator("main#main")).toBeAttached();
  expect((await page.title()).trim()).not.toBe("");
}

const HTML_PAGES: readonly (readonly [name: string, path: string])[] = [
  ["homepage", "/"],
  ["about", "/about"],
  ["faq", "/faq"],
  ["rules", "/rules"],
  ["privacy", "/privacy"],
  ["join page (GET only)", "/join"],
  ["events list", "/events"],
];

test.describe("watch guest journeys", () => {
  test("readiness identity: /up carries the two-web-next marker", async ({ page }) => {
    const problems = observe(page);
    const response = await visit(page, "/up", 200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(problems).toEqual([]);
  });

  for (const [name, path] of HTML_PAGES) {
    test(`${name} renders as a guest (${path})`, async ({ page }) => {
      const problems = observe(page);
      const response = await visit(page, path, 200);
      await expectHtmlPage(page, response);
      expect(problems).toEqual([]);
    });
  }

  test("one published event discovered from the events list", async ({ page }) => {
    const problems = observe(page);
    await visit(page, "/events", 200);
    // Never a hard-coded key: take the first event link the list renders.
    const hrefs = await page
      .locator("a[href^='/e/']")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    const eventPath = hrefs.find((href) => /^\/e\/[^/?#]+$/.test(href));
    if (eventPath === undefined) {
      // test.skip records the skip and its reason in the report.
      test.skip(true, "no published event is listed on /events; nothing to open");
      return;
    }
    test.info().annotations.push({ type: "event", description: eventPath });
    const response = await visit(page, eventPath, 200);
    await expectHtmlPage(page, response);
    expect(problems).toEqual([]);
  });

  test("robots.txt names the sitemap", async ({ page }) => {
    const problems = observe(page);
    const response = await visit(page, "/robots.txt", 200);
    expect(response.headers()["content-type"]).toMatch(/^text\/plain\b/);
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toMatch(/^Sitemap: https:\/\/\S+\/sitemap_index\.xml$/m);
    expect(problems).toEqual([]);
  });

  test("sitemap_index.xml is a well-formed urlset", async ({ page }) => {
    const problems = observe(page);
    const response = await visit(page, "/sitemap_index.xml", 200);
    expect(response.headers()["content-type"]).toMatch(/^application\/xml\b/);
    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
    expect(problems).toEqual([]);
  });
});
