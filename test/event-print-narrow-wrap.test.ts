// Narrow print must not overflow the page: the print-only canonical and
// join-destination lines are long unbroken URLs, so without wrapping the
// document scrolls sideways (observed 477px at a 390px viewport).
// Run: npm run build --prefix web && EVENT_PRINT_BROWSER_TESTS=true npx vitest run test/event-print-narrow-wrap.test.ts
// check/node22 never install Chromium, so the a11y job runs this suite with
// its executed-count verifier; a skipped run there fails the gate.
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openPrintFixture,
  printRow,
  renderPrintFixture,
  type Twin,
} from "./helpers/event-print-fixture";

describe.skipIf(process.env.EVENT_PRINT_BROWSER_TESTS !== "true")(
  "event print narrow wrap browser acceptance",
  () => {
    let browser: Browser;
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    describe.each(["Hono", "Kit"] as Twin[])("%s narrow print wraps", (twin) => {
      it("print document never exceeds the 390px viewport", async () => {
        const fixture = await renderPrintFixture(twin, printRow(), "guest");
        expect(fixture.status).toBe(200);
        const opened = await openPrintFixture(browser, fixture, 390, false);
        try {
          await opened.page.emulateMedia({ media: "print" });
          const scrollWidth = await opened.page.evaluate("document.documentElement.scrollWidth");
          expect(scrollWidth).toBeLessThanOrEqual(391);
        } finally {
          await opened.context.close();
        }
      });
    });
  },
);
