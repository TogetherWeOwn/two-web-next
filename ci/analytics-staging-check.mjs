import { chromium } from "playwright";
import * as analytics from "../e2e/analytics-isolation.mjs";
import * as staging from "../e2e/analytics-target.mjs";

let phase = "arguments";
try {
  const target = staging.requireAnalyticsTarget(process.argv.slice(2));
  phase = "isolated HTML retrieval";
  const eligible = await staging.readAnalyticsDocument(target, staging.ELIGIBLE_PATH);
  const privacy = await staging.readAnalyticsDocument(target, staging.PRIVACY_PATH);
  const cases = [
    [staging.ELIGIBLE_PATH, eligible, true, target.jurisdiction === "allowed"],
    [staging.PRIVACY_PATH, privacy, true, false],
    [staging.PRIVACY_PATH, privacy, false, false],
  ];
  phase = "Chromium startup";
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
    for (const [path, html, javaScriptEnabled, allowed] of cases) {
      phase = `HTML and browser checks for ${path} (JavaScript ${javaScriptEnabled ? "on" : "off"})`;
      const url = target.origin + path;
      const { counts } = analytics.inspectAnalyticsHtml(html, url);
      analytics.assertScriptInventory(counts, Number(allowed));
      const replay = { url, html, javaScriptEnabled, allowed };
      const observed = await analytics.observeAnalytics(browser, replay);
      analytics.assertAnalyticsObservation(observed, Number(allowed));
      const report = { jurisdiction: target.jurisdiction, path, javaScriptEnabled, ...observed };
      console.log(JSON.stringify(report));
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(
    phase === "arguments" ? error.message : `Isolated Analytics check failed during ${phase}`,
  );
  process.exitCode = 1;
}
