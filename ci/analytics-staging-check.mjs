import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  assertAnalyticsObservation,
  inspectAnalyticsHtml,
  observeAnalytics,
} from "../e2e/analytics-isolation.mjs";
import {
  ELIGIBLE_PATH,
  PRIVACY_PATH,
  readAnalyticsDocument,
  requireAnalyticsTarget,
} from "../e2e/analytics-target.mjs";

let stage = "isolated target admission and HTML retrieval";

async function run(target) {
  const eligible = await readAnalyticsDocument(target, ELIGIBLE_PATH);
  const privacy = await readAnalyticsDocument(target, PRIVACY_PATH);
  const cases = [
    {
      path: ELIGIBLE_PATH,
      html: eligible,
      javaScriptEnabled: true,
      allowed: target.jurisdiction === "allowed",
    },
    { path: PRIVACY_PATH, html: privacy, javaScriptEnabled: true, allowed: false },
    { path: PRIVACY_PATH, html: privacy, javaScriptEnabled: false, allowed: false },
  ];
  for (const { path, html, allowed } of cases) {
    stage = `original HTML inventory for ${path}`;
    const expected = allowed ? 1 : 0;
    assert.deepEqual(
      inspectAnalyticsHtml(html, target.origin + path),
      {
        scripts: expected,
        beacons: expected,
        otherTracking: 0,
      },
      "Unexpected script inventory in the original HTML",
    );
  }
  stage = "starting isolated Chromium";
  const browser = await chromium.launch({
    args: [
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  try {
    for (const { path, html, javaScriptEnabled, allowed } of cases) {
      stage = `browser observations for ${path} (JavaScript ${javaScriptEnabled ? "on" : "off"})`;
      const observed = await observeAnalytics(browser, {
        url: target.origin + path,
        html,
        javaScriptEnabled,
        allowed,
      });
      assertAnalyticsObservation(observed, allowed);
      assert.equal(observed.scripts, allowed ? 1 : 0, "Unexpected script inventory in the browser");
      console.log(
        JSON.stringify({
          jurisdiction: target.jurisdiction,
          path,
          javaScriptEnabled,
          beaconElements: observed.beacons,
          fakeLoads: observed.loads,
          fakeExecutions: observed.executions,
          fakePosts: observed.collections,
          blocked: observed.blocked,
        }),
      );
    }
  } finally {
    await browser.close();
  }
}

let target;
try {
  target = requireAnalyticsTarget(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
if (target) {
  try {
    await run(target);
  } catch {
    // Transport/browser errors can embed the staging URL, HTML or headers.
    console.error(`Isolated Analytics check failed during ${stage}`);
    process.exitCode = 1;
  }
}
