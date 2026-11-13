// Positive control for the gallery CSP monitor. Run in Chromium before trusting
// empty receipts; the intercepted probe documents never reach the network.
import { monitorGalleryPage } from "./kit-gallery-monitor.mjs";

async function waitForDirective(snapshot, directive) {
  const deadline = Date.now() + 5000;
  do {
    const events = (await snapshot())["security-policy-violations"].events;
    if (
      events.some(
        (event) =>
          typeof event.violatedDirective === "string" &&
          event.violatedDirective.startsWith(directive),
      )
    )
      return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`CSP probe did not observe ${directive} within 5 seconds`);
}

export async function probeGalleryCspMonitor(browser) {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      await context.route("http://gallery-csp-probe.invalid/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const body =
          pathname === "/style"
            ? "<!doctype html><style>body { color: red }</style><p>style probe</p>"
            : "<!doctype html><img src='/blocked.png' alt='image probe'>";
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" },
          body,
        });
      });
      const page = await context.newPage();
      const snapshot = await monitorGalleryPage(page);
      await page.goto("http://gallery-csp-probe.invalid/style", { waitUntil: "load" });
      await waitForDirective(snapshot, "style-src");
      await page.goto("http://gallery-csp-probe.invalid/image", { waitUntil: "load" });
      const events = await waitForDirective(snapshot, "img-src");
      if (!events.some((event) => event.violatedDirective?.startsWith("style-src"))) {
        throw new Error("CSP probe lost the first violation after navigation");
      }
    } catch (error) {
      throw new Error(
        `CSP probe failed with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`,
        { cause: error },
      );
    } finally {
      await context.close();
    }
  }
}
