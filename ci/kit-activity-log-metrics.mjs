import { withDeadline } from "./kit-activity-log-visual.mjs";

async function loadAxe() {
  const [{ default: axe }, { WCAG_AA_TAGS }] = await Promise.all([
    import("axe-core"),
    import("./a11y-policy.mjs"),
  ]);
  return { source: axe.source, tags: WCAG_AA_TAGS };
}
export async function routeA11y(page, mark, load = loadAxe) {
  mark("AXE_INJECT");
  const { source, tags } = await load();
  await withDeadline(() => page.evaluate(source));
  mark("AXE_EVALUATE");
  const { violations, incomplete } = await withDeadline(() =>
    page.evaluate(async (values) => {
      const result = await globalThis.axe.run(document, { runOnly: { type: "tag", values } });
      return { violations: result.violations.length, incomplete: result.incomplete.length };
    }, tags),
  );
  return `a11y: ${violations || incomplete ? "FAIL" : "PASS"} violations=${violations} incomplete=${incomplete}`;
}

export async function routeLighthouse(port, page, url) {
  // Use the existing guarded target and a log-only Lighthouse audit (no filmstrip or report file).
  const [{ default: lighthouse }, { default: puppeteer }] = await Promise.all([
    import("lighthouse"),
    import("puppeteer-core"),
  ]);
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
