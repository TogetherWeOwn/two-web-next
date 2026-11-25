import { expect, test } from "@playwright/test";
import {
  compilePrivacyHistory,
  renderPrivacyHistory,
} from "../test/helpers/privacy-published-history";
import {
  assertAnalyticsObservation,
  assertScriptInventory,
  BEACON_URL,
  inspectAnalyticsHtml,
  observeAnalytics,
} from "./analytics-isolation.mjs";
import * as staging from "./analytics-target.mjs";

const origin = "https://analytics-synthetic.example.test";
const url = origin + staging.ELIGIBLE_PATH;
const fixturePage = (scripts = "") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Analytics fixture</title><main><h1>Analytics fixture</h1></main>${scripts}</html>`;

const cases = [
  { name: "EU", country: "DE", eu: true, allowed: false },
  { name: "UK", country: "GB", eu: false, allowed: false },
  { name: "unknown (XX)", country: "XX", eu: false, allowed: false },
  { name: "unknown (missing EU classification)", country: "US", allowed: false },
  { name: "unknown (missing country)", eu: false, allowed: false },
  { name: "allowed (US)", country: "US", eu: false, allowed: true },
];

for (const { name, country, eu, allowed } of cases) {
  test(`${name} regional Analytics decision`, async ({ browser }) => {
    // US is the positive control. The fixture has no general country allowlist.
    const beacon = `<script defer src="${BEACON_URL}/v123" crossorigin="anonymous" integrity="sha256-AA==" data-cf-beacon="{}"></script>`;
    const html = fixturePage(country === "US" && eu === false ? beacon : "");
    const expected = Number(allowed);
    assertScriptInventory(inspectAnalyticsHtml(html, url).counts, expected);
    assertAnalyticsObservation(await observeAnalytics(browser, { url, html, allowed }), expected);
  });
}

test("three initialization calls inject only one fake beacon", async ({ browser }) => {
  const html = fixturePage(`<script>
    function initializeAnalytics() {
      const root = document.documentElement;
      root.dataset.analyticsInitializations = String(Number(root.dataset.analyticsInitializations || 0) + 1);
      if (document.querySelector('script[data-cf-beacon]')) return;
      const script = document.createElement('script');
      script.dataset.cfBeacon = '{}';
      script.src = ${JSON.stringify(BEACON_URL)};
      document.head.append(script);
    }
    for (let call = 0; call < 3; call++) initializeAnalytics();
  </script>`);
  assertScriptInventory(inspectAnalyticsHtml(html, url).counts, 1, 0);
  const observed = await observeAnalytics(browser, { url, html, allowed: true });
  expect(observed.initializations).toBe(3);
  assertAnalyticsObservation(observed, 1, 2);
});

test("blocked vendor and same-origin Zaraz requests count as failures", async ({ browser }) => {
  const html = fixturePage(
    `<script src="${BEACON_URL}"></script><script src="/cdn-cgi/zaraz/s.js"></script>`,
  );
  const { counts } = inspectAnalyticsHtml(html, url);
  expect(counts).toEqual({ scripts: 2, beacons: 1, otherTracking: 1 });
  const observed = await observeAnalytics(browser, { url, html });
  expect(observed.blocked).toBe(2);
  expect([observed.loads, observed.executions, observed.collections]).toEqual([0, 0, 0]);
  expect(() => assertAnalyticsObservation(observed, 0)).toThrow();
});

test("both privacy renderers work with JavaScript on and off", async ({ browser }) => {
  const fixture = await compilePrivacyHistory();
  for (const twin of ["Hono", "Kit"] as const) {
    const { status, html, touches } = await renderPrivacyHistory(fixture, twin);
    expect(status).toBe(200);
    expect(touches).toEqual([]);
    const url = `${origin}/privacy`;
    assertScriptInventory(inspectAnalyticsHtml(html, url).counts, 0);
    for (const javaScriptEnabled of [true, false]) {
      const observed = await observeAnalytics(browser, { url, html, javaScriptEnabled });
      assertAnalyticsObservation(observed, 0);
    }
  }
});

test("staging target admission requires an explicit isolated origin and jurisdiction", () => {
  const args = (target: string, expected = "eu") => ["--target", target, "--expect", expected];
  expect(staging.requireAnalyticsTarget(args(origin))).toEqual({ origin, jurisdiction: "eu" });
  expect(() => staging.requireAnalyticsTarget([])).toThrow();
  expect(() => staging.requireAnalyticsTarget(args(origin, "DE"))).toThrow();
  for (const target of [
    "https://togetherweown.com",
    "https://next.togetherweown.com",
    "https://analytics-synthetic.togetherweown.com",
    "https://analytics-synthetic.preview.workers.dev",
    "http://analytics-synthetic.example.test",
    "https://127.0.0.1",
    ...[":443", ".", "/privacy", "?target=other", "#fragment"].map((suffix) => origin + suffix),
    "https://userinfo@analytics-synthetic.example.test",
  ]) {
    expect(() => staging.requireAnalyticsTarget(args(target)), target).toThrow();
  }
});

test("staging rejects redirects, wrong jurisdiction, invalid UTF-8 and excess bytes", async () => {
  const { parseAnalyticsResponse } = staging;
  const headers = {
    "content-type": "text/html",
    "x-two-analytics-fixture": "isolated-v1",
    "x-two-analytics-jurisdiction": "eu",
  };
  const response = (body: Buffer[], statusCode = 200) =>
    Object.assign(body, { headers, statusCode });
  const chunk = Buffer.alloc(524_288, 32);
  const atLimit = await parseAnalyticsResponse(response([chunk, chunk]), "eu");
  expect(atLimit).toHaveLength(1_048_576);
  await expect(parseAnalyticsResponse(response([chunk], 302), "eu")).rejects.toThrow(/direct 200/);
  await expect(parseAnalyticsResponse(response([chunk]), "uk")).rejects.toThrow(/admission/);
  const invalidUtf8 = response([Buffer.from([255])]);
  await expect(parseAnalyticsResponse(invalidUtf8, "eu")).rejects.toThrow(TypeError);
  const oversized = response([chunk, chunk, Buffer.from(" ")]);
  await expect(parseAnalyticsResponse(oversized, "eu")).rejects.toThrow(/size limit/);
});
