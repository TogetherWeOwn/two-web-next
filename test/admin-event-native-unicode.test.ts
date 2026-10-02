import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventFormPage } from "../src/admin/pages";
import type { EventRow } from "../src/admin/store";
import { parseEventForm, ValidationError } from "../src/admin/validation";

const base = {
  title: "Game night",
  game: "Chess",
  location: "Discord",
  timezone: "UTC",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};
const limits = [
  { field: "title", max: 100 },
  { field: "game", max: 100 },
  { field: "location", max: 255 },
] as const;
const patterns = [
  { label: "ASCII", characters: ["x"] },
  { label: "BMP", characters: ["界"] },
  { label: "astral", characters: ["😀"] },
  { label: "mixed BMP/astral", characters: ["界", "😀", "x"] },
];
const row: EventRow = {
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  ...base,
  description: null,
  capacity: null,
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
function text(characters: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => characters[i % characters.length]).join("");
}
function form(mode: "new" | "edit", values = base, errors: Record<string, string> = {}): string {
  return String(EventFormPage({ mode, row, values, errors }));
}
const source = readFileSync(
  new URL("../public/islands/admin-event-text-limits.js", import.meta.url),
  "utf8",
);
const { eventTextLimitError, bindAdminEventTextLimits } = runInNewContext(
  source.replace(/^export /gm, "") + "\n({ eventTextLimitError, bindAdminEventTextLimits });",
  { queueMicrotask },
) as {
  eventTextLimitError: (value: string, field: string, max: number) => string;
  bindAdminEventTextLimits: (root: unknown) => void;
};

// These always-on fixtures prove SSR wiring and parity, not native browser behavior.
describe("admin event code-point contract", () => {
  for (const { field, max } of limits) {
    it.each(patterns)(
      `${field} measures $label code points like the unchanged server`,
      ({ characters }) => {
        const value = text(characters, max);
        expect(eventTextLimitError(value, field, max)).toBe("");
        expect(parseEventForm({ ...base, [field]: value })[field]).toBe(value);
        const message = `Keep the ${field} to ${max} characters.`;
        expect(eventTextLimitError(value + "x", field, max)).toBe(message);
        try {
          parseEventForm({ ...base, [field]: value + "x" });
          throw new Error("Expected server validation to reject N+1 without JS");
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).fields).toEqual({ [field]: message });
        }
        expect(eventTextLimitError(` \t${value}  `, field, max)).toBe("");
      },
    );
  }
  it("counts combining marks and ZWJ as code points, not graphemes", () => {
    for (const title of ["é".repeat(50), "👩‍💻".repeat(33) + "x"]) {
      expect(eventTextLimitError(title, "title", 100)).toBe("");
      expect(eventTextLimitError(title + "x", "title", 100)).toBe(
        "Keep the title to 100 characters.",
      );
    }
  });
  it.each(["new", "edit"] as const)(
    "enhances only the three scoped %s controls and retains native POST",
    (mode) => {
      const html = form(mode);
      expect(html).toContain('<script type="module" src="/islands/admin-event-text-limits.js"');
      expect(html).toContain('<form method="post" action="/admin/events');
      for (const { field, max } of limits) {
        const input = html.match(new RegExp(`<input[^>]*name="${field}"[^>]*>`))![0];
        expect(input).toContain(`data-event-text-limit="${max}"`);
        expect(input).not.toContain("maxlength");
        const rejected = form(mode, base, { [field]: "Server feedback" });
        expect(rejected).toContain(`aria-describedby="f-${field}-error"`);
        expect(rejected).toContain("Server feedback");
      }
      expect(html).toMatch(/name="title"[^>]*required/);
      expect(html.match(/data-event-text-limit=/g)).toHaveLength(3);
      expect(html).toContain('src="/islands/admin-event-editor.js"');
    },
  );
});

function inputFixture(name = "title", max = 100, value = "") {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const resetListeners: (() => void)[] = [];
  const errors: {
    id: string;
    className: string;
    textContent: string;
    hidden: boolean;
    setAttribute: () => void;
  }[] = [];
  const input = {
    name,
    value,
    id: `f-${name}`,
    dataset: { eventTextLimit: String(max) },
    message: "",
    ownerDocument: {
      createElement: () => ({
        id: "",
        className: "",
        textContent: "",
        hidden: false,
        setAttribute: () => {},
      }),
    },
    form: {
      addEventListener: (_type: string, callback: () => void) => resetListeners.push(callback),
    },
    setCustomValidity: (message: string) => {
      input.message = message;
    },
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => {
      attributes.set(key, value);
    },
    removeAttribute: (key: string) => {
      attributes.delete(key);
    },
    addEventListener: (type: string, callback: () => void) => {
      listeners.set(type, callback);
    },
    after: (error: (typeof errors)[number]) => {
      errors.push(error);
    },
  };
  const root = { querySelectorAll: () => [input] };
  return { input, root, attributes, listeners, errors, resetListeners };
}

describe("admin event text limit binder", () => {
  it("validates prefilled drafts, announces field feedback, clears it on correction and binds once", () => {
    const fixture = inputFixture("game", 100, "😀".repeat(101));
    bindAdminEventTextLimits(fixture.root);
    bindAdminEventTextLimits(fixture.root);
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.input.message).toBe("Keep the game to 100 characters.");
    expect(fixture.errors[0]).toMatchObject({ hidden: false, textContent: fixture.input.message });
    expect(fixture.attributes.get("aria-invalid")).toBe("true");
    expect(fixture.attributes.get("aria-describedby")).toBe("f-game-limit-error");
    fixture.input.value = "😀".repeat(100);
    fixture.listeners.get("input")!();
    expect(fixture.input.message).toBe("");
    expect(fixture.errors[0]).toMatchObject({ hidden: true, textContent: "" });
    expect(fixture.attributes.has("aria-invalid")).toBe(false);
  });
  it("preserves server error associations and responds to change/reset", async () => {
    const fixture = inputFixture("location", 255);
    fixture.attributes.set("aria-describedby", "f-location-error");
    fixture.attributes.set("aria-invalid", "true");
    bindAdminEventTextLimits(fixture.root);
    expect(fixture.attributes.get("aria-describedby")).toBe(
      "f-location-error f-location-limit-error",
    );
    fixture.input.value = "x".repeat(256);
    fixture.listeners.get("change")!();
    expect(fixture.input.message).toBe("Keep the location to 255 characters.");
    fixture.resetListeners[0]!();
    fixture.input.value = "Discord";
    await Promise.resolve();
    expect(fixture.input.message).toBe("");
    expect(fixture.attributes.get("aria-invalid")).toBe("true");
  });
  it("is a no-op on pages without annotated controls", () => {
    expect(() => bindAdminEventTextLimits({ querySelectorAll: () => [] })).not.toThrow();
  });
});

// Opt in with ADMIN_EVENT_BROWSER_TESTS=true after installing Playwright Chromium.
// Every document and asset is a synthetic intercepted fixture; no server or DB.
describe.skipIf(process.env.ADMIN_EVENT_BROWSER_TESTS !== "true")(
  "native admin event text limits",
  () => {
    let browser: Browser;
    let page: Page;
    let mode: "new" | "edit" = "new";
    beforeAll(async () => {
      browser = await chromium.launch();
      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      page = await context.newPage();
      await page.route("**/*", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().resourceType() === "document") {
          await route.fulfill({ contentType: "text/html", body: form(mode) });
        } else if (pathname === "/islands/admin-event-text-limits.js") {
          await route.fulfill({ contentType: "text/javascript", body: source });
        } else if (pathname === "/islands/admin-event-editor.js") {
          await route.fulfill({
            contentType: "text/javascript",
            body: readFileSync(
              new URL("../public/islands/admin-event-editor.js", import.meta.url),
              "utf8",
            ),
          });
        } else {
          await route.fulfill({ status: 404, body: "" });
        }
      });
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function load(currentMode: "new" | "edit") {
      mode = currentMode;
      await page.goto("https://next.example.test/admin/events/new");
      await page.waitForFunction(
        "document.querySelector('#f-title').getAttribute('aria-describedby')?.includes('limit-error')",
      );
      // Only capture fixture submission, without fetching or mutating anything.
      await page.evaluate(`(() => {
      window.submissions = [];
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.submissions.push(Object.fromEntries(new FormData(event.target)));
      });
    })()`);
    }
    for (const currentMode of ["new", "edit"] as const) {
      for (const { field, max } of limits) {
        for (const method of ["typing", "paste"] as const) {
          it.each(patterns)(
            `${currentMode}: ${method} N/N+1 $label ${field} code points`,
            async ({ characters }) => {
              await load(currentMode);
              const input = page.locator(`input[name="${field}"]`);
              const value = text(characters, max);
              await input.fill("");
              if (method === "typing") {
                await input.pressSequentially(value);
              } else {
                await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(value)})`);
                await input.focus();
                await input.press("Control+V");
              }
              expect(await input.inputValue()).toBe(value);
              expect(
                await input.evaluate(
                  (input) => (input as unknown as { validity: { valid: boolean } }).validity.valid,
                ),
              ).toBe(true);
              await page.locator('[data-testid="save-event"]').click();
              const submissions =
                await page.evaluate<Record<string, string>[]>("window.submissions");
              expect(submissions).toHaveLength(1);
              expect(submissions[0]![field]).toBe(value);
              expect(parseEventForm(submissions[0]!)[field]).toBe(value);
              // A real user insertion must remain visible, but prevent native submission.
              await input.focus();
              await input.press("End");
              if (method === "typing") await input.pressSequentially("x");
              else {
                await page.evaluate("navigator.clipboard.writeText('x')");
                await input.focus();
                await input.press("End");
                await input.press("Control+V");
              }
              expect(await input.inputValue()).toBe(value + "x");
              const message = `Keep the ${field} to ${max} characters.`;
              expect(
                await input.evaluate(
                  (input) => (input as unknown as { validationMessage: string }).validationMessage,
                ),
              ).toBe(message);
              expect(await page.locator(`#f-${field}-limit-error`).textContent()).toBe(message);
              expect(await input.getAttribute("aria-invalid")).toBe("true");
              await page.locator('[data-testid="save-event"]').click();
              expect(await page.evaluate("window.submissions.length")).toBe(1);
              await input.focus();
              await input.press("End");
              await input.press("Backspace");
              expect(
                await input.evaluate(
                  (input) => (input as unknown as { validity: { valid: boolean } }).validity.valid,
                ),
              ).toBe(true);
              expect(await page.locator(`#f-${field}-limit-error`).isHidden()).toBe(true);
              await page.locator('[data-testid="save-event"]').click();
              expect(await page.evaluate("window.submissions.length")).toBe(2);
            },
          );
        }
      }
    }
  },
);
