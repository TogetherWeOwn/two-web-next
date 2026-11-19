import axe from "axe-core";
import lighthouse from "lighthouse";
import puppeteer from "puppeteer-core";
import { WCAG_AA_TAGS } from "./a11y-policy.mjs";

export async function routeA11y(page) {
  await page.evaluate(axe.source);
  const { violations, incomplete } = await page.evaluate(async (tags) => {
    const result = await globalThis.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return { violations: result.violations.length, incomplete: result.incomplete.length };
  }, WCAG_AA_TAGS);
  return `a11y: ${violations || incomplete ? "FAIL" : "PASS"} violations=${violations} incomplete=${incomplete}`;
}

export async function routeLighthouse(page, port, url) {
  // Use the existing guarded target and a log-only Lighthouse audit (no filmstrip or report file).
  const unavailable = "lighthouse: unavailable";
  const audit = "total-byte-weight";
  let browser;
  try {
    const browserURL = `http://127.0.0.1:${port}`;
    browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    const [target, ...other] = (await browser.pages()).filter((p) => p.url() === url);
    if (!target || other.length) return unavailable;
    const flags = {
      logLevel: "silent",
      onlyAudits: [audit],
      disableFullPageScreenshot: true,
      disableStorageReset: true,
      screenEmulation: { disabled: true },
      throttlingMethod: "provided",
      maxWaitForLoad: 20_000,
    };
    const { lhr } = await lighthouse(url, flags, undefined, target);
    if (lhr.finalDisplayedUrl !== url || lhr.runtimeError || lhr.runWarnings.length)
      return unavailable;
    const bytes = lhr.audits[audit]?.numericValue;
    const fcp = await page.evaluate(
      (name) => performance.getEntriesByName(name)[0]?.startTime,
      "first-contentful-paint",
    );
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isFinite(fcp)) return unavailable;
    return `lighthouse: report-only total_bytes=${bytes} fcp_ms=${Math.round(fcp)}`;
  } catch {
    return unavailable;
  } finally {
    await browser?.disconnect();
  }
}
