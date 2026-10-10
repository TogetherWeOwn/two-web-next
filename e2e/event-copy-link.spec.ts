import { test, expect } from "./fixtures";

// Browser pin for the legacy EventClipboardFallbackTest denial path: with the
// Clipboard API denied, the shipped copy-link binder falls back to the
// selectable-text copy carrying the canonical /e/{key} URL, reports the copy,
// and leaks nothing to console. Unit parity lives in
// test/event-copy-link-fallback.test.ts; this spec proves the same binder
// through the browser against wrangler dev + CI Postgres only. It never
// touches staging or production: one local event page, no QA token.
const EVENT_KEY = "01J00000000000000000000001";
const COPIED_TEXT = "Event link copied.";

interface CopyProbe {
  writes: string[];
  execs: string[];
  fieldValue: string | null;
}

// Serialized into the page before its scripts run (no DOM globals here: the
// e2e project has no DOM lib). Denies the Clipboard API the way a permission
// denial surfaces, then pins the fallback deterministically: the execCommand
// call and the selectable field value are recorded, and success is reported
// without depending on headless clipboard permissions.
const DENY_CLIPBOARD = `
  window.__copyProbe = { writes: [], execs: [], fieldValue: null };
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        window.__copyProbe.writes.push(text);
        throw new DOMException("Clipboard permission denied", "NotAllowedError");
      },
    },
    configurable: true,
  });
  document.execCommand = (command) => {
    window.__copyProbe.execs.push(command);
    const field = document.querySelector("textarea.sr-only");
    if (field) window.__copyProbe.fieldValue = field.value;
    return true;
  };
`;

test("clipboard-denied copy falls back to the selectable canonical URL with no console noise", async ({
  page,
}) => {
  const consoleNoise: string[] = [];
  page.on("console", (message) => {
    // Resource-load failures are browser reports, not page logging; the pin
    // is that the binder leaks nothing via console.error/warn.
    if (message.text().startsWith("Failed to load resource")) return;
    if (message.type() === "error" || message.type() === "warning") {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });

  await page.addInitScript(DENY_CLIPBOARD);
  const response = await page.goto(`/e/${EVENT_KEY}`);
  expect(response?.status()).toBe(200);

  const link = page.getByTestId("event-copy-link");
  await expect(link).toBeVisible();
  const canonical = await link.getAttribute("data-copy-link");
  expect(canonical).toBeTruthy();
  expect(canonical).toContain(`/e/${EVENT_KEY}`);

  await link.click();
  const toast = page.getByTestId("event-copy-toast");
  await expect(toast).toHaveText(COPIED_TEXT);

  const probe = (await page.evaluate(
    "window.__copyProbe ?? { writes: [], execs: [], fieldValue: null }",
  )) as unknown as CopyProbe;
  // The Clipboard API was attempted once with the exact page canonical, then
  // the fallback carried that same canonical as selectable text.
  expect(probe.writes).toEqual([canonical]);
  expect(probe.execs).toEqual(["copy"]);
  expect(probe.fieldValue).toBe(canonical);

  expect(consoleNoise, "no console errors or warnings").toEqual([]);
  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
