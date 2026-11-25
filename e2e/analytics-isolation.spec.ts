import { expect, test } from "@playwright/test";
import {
  compilePrivacyHistory,
  renderPrivacyHistory,
} from "../test/helpers/privacy-published-history";
import {
  assertAnalyticsObservation,
  BEACON_URL,
  inspectAnalyticsHtml,
  observeAnalytics,
} from "./analytics-isolation.mjs";
import { ELIGIBLE_PATH, requireAnalyticsTarget } from "./analytics-target.mjs";

const origin = "https://analytics-synthetic.example.test";
const url = origin + ELIGIBLE_PATH;
const document = (scripts = "") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Analytics fixture</title><main><h1>Analytics fixture</h1></main>${scripts}</html>`;

const cases = [
  { name: "EU", edge: { country: "DE", isEU: true }, allowed: false },
  { name: "UK", edge: { country: "GB", isEU: false }, allowed: false },
  { name: "unknown (XX)", edge: { country: "XX", isEU: false }, allowed: false },
  { name: "unknown (missing EU classification)", edge: { country: "US" }, allowed: false },
  { name: "unknown (missing country)", edge: { isEU: false }, allowed: false },
  { name: "allowed (US)", edge: { country: "US", isEU: false }, allowed: true },
];

// The fixture models the trusted edge metadata described in the runbook.
// US is the single positive control, so this fixture needs no country list.
function fixtureHtml(edge: { country?: string; isEU?: boolean }) {
  const allow = edge.isEU === false && edge.country === "US";
  return document(
    allow
      ? `<script defer src="${BEACON_URL}/v123" crossorigin="anonymous" integrity="sha256-AA==" data-cf-beacon="{}"></script>`
      : "",
  );
}

for (const { name, edge, allowed } of cases) {
  test(`${name} uses the regional Analytics decision before the browser runs`, async ({
    browser,
  }) => {
    const html = fixtureHtml(edge);
    const expected = Number(allowed);
    expect(inspectAnalyticsHtml(html, url)).toEqual({
      scripts: expected,
      beacons: expected,
      otherTracking: 0,
    });
    assertAnalyticsObservation(
      await observeAnalytics(browser, { url, html, javaScriptEnabled: true, allowed }),
      allowed,
    );
  });
}

test("three initialization calls inject only one fake beacon", async ({ browser }) => {
  const html = document(`<script>
    function initializeAnalytics() {
      const root = document.documentElement;
      root.dataset.analyticsInitializations = String(Number(root.dataset.analyticsInitializations || 0) + 1);
      if (document.querySelector('script[data-cf-beacon]')) return;
      const script = document.createElement('script');
      script.dataset.cfBeacon = '{}';
      script.src = ${JSON.stringify(BEACON_URL)};
      document.head.append(script);
    }
    initializeAnalytics();
    initializeAnalytics();
    initializeAnalytics();
  </script>`);
  expect(inspectAnalyticsHtml(html, url).beacons).toBe(0);
  const observed = await observeAnalytics(browser, {
    url,
    html,
    javaScriptEnabled: true,
    allowed: true,
  });
  expect(observed.initializations).toBe(3);
  assertAnalyticsObservation(observed, true);
});

test("blocked vendor and same-origin Zaraz requests count as failures", async ({ browser }) => {
  const html = document(
    `<script src="${BEACON_URL}"></script><script src="/cdn-cgi/zaraz/s.js"></script>`,
  );
  expect(inspectAnalyticsHtml(html, url)).toEqual({ scripts: 2, beacons: 1, otherTracking: 1 });
  const observed = await observeAnalytics(browser, {
    url,
    html,
    javaScriptEnabled: true,
    allowed: false,
  });
  expect(observed.blocked).toBe(2);
  expect([observed.loads, observed.executions, observed.collections]).toEqual([0, 0, 0]);
  expect(() => assertAnalyticsObservation(observed, false)).toThrow();
});

test("both server-rendered privacy pages display policy headings with JavaScript disabled", async ({
  browser,
}) => {
  const fixture = await compilePrivacyHistory();
  for (const twin of ["Hono", "Kit"] as const) {
    const { status, html, touches } = await renderPrivacyHistory(fixture, twin);
    expect(status).toBe(200);
    expect(touches).toEqual([]);
    const privacyUrl = `${origin}/privacy`;
    expect(inspectAnalyticsHtml(html, privacyUrl)).toEqual({
      scripts: 0,
      beacons: 0,
      otherTracking: 0,
    });
    for (const javaScriptEnabled of [true, false]) {
      const observed = await observeAnalytics(browser, {
        url: privacyUrl,
        html,
        javaScriptEnabled,
        allowed: false,
      });
      expect(observed.scripts).toBe(0);
      assertAnalyticsObservation(observed, false);
    }
  }
});

test("staging target admission requires an explicit isolated origin and jurisdiction", () => {
  const args = (target: string, expected = "eu") => ["--target", target, "--expect", expected];
  expect(requireAnalyticsTarget(args(origin))).toEqual({ origin, jurisdiction: "eu" });
  expect(() => requireAnalyticsTarget([])).toThrow();
  expect(() => requireAnalyticsTarget(args(origin, "DE"))).toThrow();
  for (const target of [
    "https://togetherweown.com",
    "https://next.togetherweown.com",
    "https://analytics-synthetic.togetherweown.com",
    "https://analytics-synthetic.preview.workers.dev",
    "http://analytics-synthetic.example.test",
    "https://127.0.0.1",
    `${origin}:443`,
    `${origin}.`,
    `${origin}/privacy`,
    `${origin}?target=other`,
    `${origin}#fragment`,
    "https://userinfo@analytics-synthetic.example.test",
  ]) {
    expect(() => requireAnalyticsTarget(args(target)), target).toThrow();
  }
});
