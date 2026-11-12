// Browser-only diagnostic preflight, outside Lighthouse's timing window.
// This checks one fixture state, not visual or accessibility parity.
export async function validateInlineInBrowser(port, setMode, chromium) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const observations = {};
  try {
    for (const mode of ["control", "inline-stylesheets"]) {
      setMode(mode);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        await context.addInitScript(() => {
          window.__styleViolations = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            if (event.effectiveDirective.startsWith("style-src")) {
              window.__styleViolations.push({
                directive: event.effectiveDirective,
                blocked: event.blockedURI,
              });
            }
          });
        });
        const page = await context.newPage();
        const response = await page.goto(`http://127.0.0.1:${port}/join`, { waitUntil: "load" });
        if (response?.status() !== 200) throw new Error(`${mode}: document did not load`);
        await page.evaluate(() => document.fonts.ready);
        const snapshot = await page.evaluate(() => {
          const heading = document.querySelector("#join-heading");
          if (!heading) throw new Error("missing join heading");
          const sheets = [...document.styleSheets];
          const rules = sheets.reduce((sum, sheet) => sum + sheet.cssRules.length, 0);
          const properties = [
            "display",
            "font-family",
            "font-size",
            "font-weight",
            "line-height",
            "color",
            "background-color",
            "margin-top",
            "margin-bottom",
            "padding-top",
            "padding-bottom",
          ];
          const styles = [document.body, heading].map((element) => {
            const computed = getComputedStyle(element);
            return Object.fromEntries(
              properties.map((property) => [property, computed.getPropertyValue(property)]),
            );
          });
          return {
            sheets: sheets.length,
            rules,
            styles,
            violations: [...window.__styleViolations],
          };
        });
        observations[mode] = snapshot;
        if (
          snapshot.violations.length ||
          snapshot.rules === 0 ||
          snapshot.sheets !== (mode === "control" ? 3 : 1)
        ) {
          throw new Error(`${mode}: missing styles or unexpected CSP violation`);
        }
        // A denied inline canary proves that a missing violation event is not just
        // a disabled CSP. Its custom property must not affect the actual heading.
        await page.evaluate(() => {
          const style = document.createElement("style");
          style.textContent = "#join-heading{--diagnostic-csp-canary:allowed}";
          document.head.append(style);
        });
        await page.waitForFunction(
          () => window.__styleViolations.some((event) => event.blocked === "inline"),
          null,
          { timeout: 5000 },
        );
        const canary = await page.evaluate(() =>
          getComputedStyle(document.querySelector("#join-heading")).getPropertyValue(
            "--diagnostic-csp-canary",
          ),
        );
        if (canary.trim()) throw new Error(`${mode}: CSP did not block inline canary`);
      } finally {
        await context.close();
      }
    }
    const control = observations.control;
    const inline = observations["inline-stylesheets"];
    if (
      control.rules !== inline.rules ||
      JSON.stringify(control.styles) !== JSON.stringify(inline.styles)
    ) {
      throw new Error("inline fixture CSS rules or sampled computed styles differ from control");
    }
    return observations;
  } finally {
    try {
      await browser.close();
    } finally {
      setMode("control");
    }
  }
}
