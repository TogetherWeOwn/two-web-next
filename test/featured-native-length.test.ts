// Featured headline/image-description native length. SSR-only by
// default; no DB, no staging endpoint. Native HTML maxlength counts UTF-16
// units, so maxlength=255 truncates 128 supplementary characters (256 units)
// before the server's 255-code-point validator runs. Omitting it lets valid
// 255-code-point values through native typing/paste and lets over-limit
// input reach the server's established errors instead of being truncated.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { registerSavedContentBrowser } from "./helpers/featured-saved-content-browser";

const base = {
  title: "Game night",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};
const fields = [
  { input: "title", output: "title", error: "Keep the headline to 255 characters." },
  { input: "image_alt", output: "imageAlt", error: "Keep the alt text to 255 characters." },
] as const;
const characters = [
  { label: "ASCII", pattern: ["x"] },
  { label: "BMP", pattern: ["界"] },
  { label: "astral", pattern: ["😀"] },
  { label: "mixed astral/BMP/ASCII", pattern: ["😀", "界", "x"] },
];

function text(pattern: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => pattern[i % pattern.length]).join("");
}

const row: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Friday games",
  body: "Bring a friend.",
  url: "https://example.test/games",
  imageUrl: "https://cdn.discordapp.com/photo.jpg",
  imageAlt: "Friends playing together",
  isPublished: true,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: "moderator",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function form(
  mode: "new" | "edit",
  values: Record<string, unknown> = base,
  errors: Record<string, string> = {},
): string {
  return String(
    FeaturedFormPage({
      mode,
      ...(mode === "edit" ? { row } : {}),
      values,
      errors,
      now: new Date(0),
      appUrl: "https://next.example.test",
    }),
  );
}

function inputTag(html: string, name: string): string {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  expect(tag, `expected input[name="${name}"]`).toBeDefined();
  return tag!;
}

function serverErrors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected featured validation to fail");
}

// SSR fixtures prove wiring: no native truncation gate, native POST intact,
// valid boundary values render whole, over-limit drafts are preserved with
// the server's existing errors and accessible associations.
describe("featured native length (SSR fixtures)", () => {
  it.each(["new", "edit"] as const)(
    "omits maxlength on %s headline and image description",
    (mode) => {
      const html = form(mode);
      expect(html).not.toMatch(/\bmaxlength\s*=/i);
      for (const { input } of fields) {
        expect(inputTag(html, input)).not.toMatch(/\bmaxlength\s*=/i);
      }
    },
  );

  it.each(["new", "edit"] as const)("keeps %s native POST and required headline", (mode) => {
    const html = form(mode);
    const expectedAction = mode === "new" ? "/admin/featured" : `/admin/featured/${row.id}`;
    expect(html).toContain(`<form method="post" action="${expectedAction}"`);
    expect(inputTag(html, "title")).toMatch(/\brequired\b/);
    expect(html).toContain('src="/islands/admin-event-editor.js"');
    expect(html).toContain('data-testid="save-featured"');
  });

  it.each(["new", "edit"] as const)("keeps %s accessible associations on field errors", (mode) => {
    const errors = {
      title: "Keep the headline to 255 characters.",
      image_alt: "Keep the alt text to 255 characters.",
    };
    const html = form(mode, base, errors);
    for (const { input } of fields) {
      const tag = inputTag(html, input);
      expect(tag).toContain('aria-invalid="true"');
      expect(tag).toContain(`f-${input.replace(/_/g, "-")}-error`);
      expect(html).toContain(errors[input as keyof typeof errors]);
    }
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    for (const token of tokens) {
      expect(ids, token).toContain(token);
    }
  });

  for (const { input, output } of fields) {
    describe(`${input} SSR boundaries`, () => {
      it.each(characters)("retains complete valid 255 $label code points", ({ pattern }) => {
        for (const mode of ["new", "edit"] as const) {
          const value = text(pattern, 255);
          const html = form(mode, { ...base, [input]: value });
          expect(inputTag(html, input)).toContain(`value="${value}"`);
          // The authoritative server still admits the same value.
          expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
        }
      });

      it.each(characters)(
        "preserves submitted 256 $label draft with the existing server error",
        ({ pattern }) => {
          const value = text(pattern, 256);
          const expected = serverErrors({ ...base, [input]: value });
          for (const mode of ["new", "edit"] as const) {
            const html = form(mode, { ...base, [input]: value }, expected);
            expect(inputTag(html, input)).toContain(`value="${value}"`);
            expect(html).toContain(expected[input]!);
            expect(inputTag(html, input)).toContain('aria-invalid="true"');
          }
        },
      );

      it("retains 128 supplementary characters (256 UTF-16 units)", () => {
        const value = "😀".repeat(128);
        expect([...value]).toHaveLength(128);
        expect(value.length).toBe(256);
        for (const mode of ["new", "edit"] as const) {
          const html = form(mode, { ...base, [input]: value });
          expect(inputTag(html, input)).toContain(`value="${value}"`);
          expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
        }
      });
    });
  }
});

// Opt in with FEATURED_NATIVE_BROWSER_TESTS=true after installing Playwright
// Chromium. Every document and asset is a synthetic intercepted fixture; no
// server or DB.
describe.skipIf(process.env.FEATURED_NATIVE_BROWSER_TESTS !== "true")(
  "native featured headline and image description",
  () => {
    let browser: Browser;
    let page: Page;
    let mode: "new" | "edit" = "new";
    const editorSource = readFileSync(
      new URL("../public/islands/admin-event-editor.js", import.meta.url),
      "utf8",
    );
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
        } else if (pathname === "/islands/admin-event-editor.js") {
          await route.fulfill({ contentType: "text/javascript", body: editorSource });
        } else {
          await route.fulfill({ status: 404, body: "" });
        }
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    registerSavedContentBrowser(() => browser);

    async function load(currentMode: "new" | "edit") {
      mode = currentMode;
      await page.goto("https://next.example.test/admin/featured/new");
      await page.locator('input[name="title"]').waitFor();
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
      for (const { input, output, error } of fields) {
        for (const method of ["typing", "paste"] as const) {
          it.each(characters)(
            `${currentMode}: ${method} N/N+1 $label ${input} code points`,
            async ({ pattern }) => {
              await load(currentMode);
              const locator = page.locator(`input[name="${input}"]`);
              const value = text(pattern, 255);
              await locator.fill("");
              if (method === "typing") {
                await locator.pressSequentially(value);
              } else {
                await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(value)})`);
                await locator.focus();
                await locator.press("Control+V");
              }
              // No premature browser truncation: the complete valid value stays.
              expect(await locator.inputValue()).toBe(value);
              await page.locator('[data-testid="save-featured"]').click();
              const submissions =
                await page.evaluate<Record<string, string>[]>("window.submissions");
              expect(submissions).toHaveLength(1);
              expect(submissions[0]![input]).toBe(value);
              expect(parseFeaturedForm(submissions[0]!)[output]).toBe(value);
              // One code point over: still fully visible, server keeps its error.
              await locator.focus();
              await locator.press("End");
              if (method === "typing") await locator.pressSequentially("x");
              else {
                await page.evaluate("navigator.clipboard.writeText('x')");
                await locator.focus();
                await locator.press("End");
                await locator.press("Control+V");
              }
              expect(await locator.inputValue()).toBe(`${value}x`);
              await page.locator('[data-testid="save-featured"]').click();
              const over = await page.evaluate<Record<string, string>[]>("window.submissions");
              expect(over).toHaveLength(2);
              expect(over[1]![input]).toBe(`${value}x`);
              expect(serverErrors(over[1]!)).toEqual({ [input]: error });
            },
          );
        }
        it(`${currentMode}: typing retains 128 supplementary ${input} characters`, async () => {
          await load(currentMode);
          const locator = page.locator(`input[name="${input}"]`);
          const value = "😀".repeat(128);
          await locator.fill("");
          await locator.pressSequentially(value);
          expect(await locator.inputValue()).toBe(value);
          await page.locator('[data-testid="save-featured"]').click();
          const submissions = await page.evaluate<Record<string, string>[]>("window.submissions");
          expect(submissions).toHaveLength(1);
          expect(submissions[0]![input]).toBe(value);
          expect(parseFeaturedForm(submissions[0]!)[output]).toBe(value);
        });
      }
    }
  },
);
