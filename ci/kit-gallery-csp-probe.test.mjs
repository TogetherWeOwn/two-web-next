import { test } from "node:test";
import { chromium } from "playwright";
import { probeGalleryCspMonitor } from "./kit-gallery-csp-probe.mjs";

test("CSP monitoring detects violations across navigation with and without JavaScript", async () => {
  const browser = await chromium.launch();
  try {
    await probeGalleryCspMonitor(browser);
  } finally {
    await browser.close();
  }
});
