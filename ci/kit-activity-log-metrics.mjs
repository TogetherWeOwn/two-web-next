import { withDeadline } from "./kit-activity-log-visual.mjs";

export async function routeA11y(page, mark, fixture) {
  const evaluate = (...args) => withDeadline(() => page.evaluate(...args));
  mark("AXE_INJECT");
  await evaluate(fixture?.source ?? (await import("axe-core")).default.source);
  mark("AXE_EVALUATE");
  const WCAG_AA_TAGS = fixture?.tags ?? (await import("./a11y-policy.mjs")).WCAG_AA_TAGS;
  const { violations, incomplete } = await evaluate(async (tags) => {
    const result = await globalThis.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return { violations: result.violations.length, incomplete: result.incomplete.length };
  }, WCAG_AA_TAGS);
  return `a11y: ${violations || incomplete ? "FAIL" : "PASS"} violations=${violations} incomplete=${incomplete}`;
}

export async function routeLighthouse(port, page, url) {
  // Use the existing guarded target and a log-only Lighthouse audit (no filmstrip or report file).
  const { default: lighthouse } = await import("lighthouse");
  const { default: puppeteer } = await import("puppeteer-core");
  const browserURL = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  try {
    const [target, other] = (await browser.pages()).filter((p) => p.url() === url);
    if (!target || other) return null;
    const flags = {
      logLevel: "silent",
      onlyAudits: ["total-byte-weight"],
      disableFullPageScreenshot: true,
      disableStorageReset: true,
      screenEmulation: { disabled: true },
      throttlingMethod: "provided",
      maxWaitForLoad: 20_000,
    };
    const { lhr } = await lighthouse(url, flags, undefined, target);
    if (lhr.finalDisplayedUrl !== url || lhr.runtimeError || lhr.runWarnings.length) return null;
    const bytes = lhr.audits["total-byte-weight"]?.numericValue;
    const fcp = await page.evaluate(
      () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
    );
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isFinite(fcp)) return null;
    return `lighthouse: report-only total_bytes=${bytes} fcp_ms=${Math.round(fcp)}`;
  } finally {
    await browser.disconnect();
  }
}
