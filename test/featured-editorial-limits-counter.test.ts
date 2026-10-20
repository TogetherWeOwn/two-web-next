// Builder-owned pins for the featured editorial-limits counter wiring. The Test
// Author owns the acceptance suites; this file pins what Paperclip Review
// found under-tested without touching those files: the rendered
// data-featured-limit/units wiring matches the server budgets exactly (so a
// lowered limit cannot hide), and the mounted minified island counts textarea
// breaks as submitted CRLF and carries no over state at exactly the limit,
// asserted on the counter node alone. Hono mount only: both renderers share
// the same shipped island bytes, and the acceptance suite already mounts both.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const budgets = {
  title: { limit: 255, units: "code-points" },
  body: { limit: 1000, units: "code-points" },
  image_alt: { limit: 255, units: "code-points" },
  url: { limit: 255, units: "utf16" },
  image_url: { limit: 255, units: "utf16" },
} as const;

const row: FeaturedRow = {
  id: 7,
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

const savedValues: Record<string, string> = {
  title: "Game night",
  body: "Bring friends.",
  image_alt: "Friends playing",
  url: "https://example.test/games",
  image_url: "https://cdn.discordapp.com/photo.png",
  position: "2",
  starts_at: "",
  ends_at: "",
  is_published: "on",
};

function errorsFor(values: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(values);
    return {};
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.fields;
  }
}

function form(
  mode: "new" | "edit",
  values: Record<string, unknown> = {},
  errors: Record<string, string> = {},
): string {
  return String(
    FeaturedFormPage({
      mode,
      row,
      values,
      errors,
      now: new Date(0),
      appUrl: "https://example.test",
    }),
  );
}

function controlTag(html: string, field: string): string {
  const tag = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(`name="${field}"`));
  expect(tag, `${field} remains an editable control`).toBeDefined();
  return tag!;
}

describe("featured editorial-limits counter attributes", () => {
  for (const mode of ["new", "edit"] as const) {
    it(`${mode}: controls carry the server budgets as counter wiring`, () => {
      const html = form(mode, mode === "new" ? {} : savedValues);
      for (const [field, budget] of Object.entries(budgets)) {
        const tag = controlTag(html, field);
        expect(tag).toContain(`data-featured-limit="${budget.limit}"`);
        expect(tag).toContain(`data-featured-units="${budget.units}"`);
      }
    });

    it(`${mode}: rejected renders keep the same counter wiring alongside field errors`, () => {
      const over = {
        ...savedValues,
        title: "x".repeat(256),
        body: "x".repeat(1001),
        image_alt: "y".repeat(256),
        url: `https://example.test/${"z".repeat(240)}`,
        image_url: `https://cdn.discordapp.com/${"z".repeat(230)}`,
      };
      const errors = errorsFor(over);
      expect(Object.keys(errors)).toEqual(
        expect.arrayContaining(["title", "body", "image_alt", "url", "image_url"]),
      );
      const html = form(mode, over, errors);
      for (const [field, budget] of Object.entries(budgets)) {
        const tag = controlTag(html, field);
        expect(tag).toContain(`data-featured-limit="${budget.limit}"`);
        expect(tag).toContain(`data-featured-units="${budget.units}"`);
        expect(tag).toContain('aria-invalid="true"');
      }
    });
  }
});

// Opt in with FEATURED_NATIVE_BROWSER_TESTS=true after installing Playwright
// Chromium. Real Hono document, real shipped island bytes, intercepted POST;
// no server or DB.
describe.skipIf(process.env.FEATURED_NATIVE_BROWSER_TESTS !== "true")(
  "featured editorial-limits counter in Chromium",
  () => {
    const origin = "https://counter.example.test";
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(() => browser?.close());

    async function withPage(
      run: (h: { page: Page; posts: Array<{ values: Record<string, string> }> }) => Promise<void>,
    ) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const posts: Array<{ values: Record<string, string> }> = [];
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== origin) return route.abort("blockedbyclient");
          if (request.method() === "POST" && url.pathname === "/admin/featured") {
            const values = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
            posts.push({ values });
            const errors = errorsFor(values);
            return route.fulfill({
              status: Object.keys(errors).length ? 422 : 200,
              contentType: "text/html; charset=utf-8",
              body: form("new", values, errors),
            });
          }
          if (url.pathname.startsWith("/islands/")) {
            const asset = resolve(root, "public", url.pathname.slice(1));
            if (asset.startsWith(join(root, "public/")) && existsSync(asset)) {
              return route.fulfill({ contentType: "text/javascript", body: readFileSync(asset) });
            }
            return route.fulfill({ status: 404, body: "" });
          }
          if (request.resourceType() === "document") {
            return route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: form("new"),
            });
          }
          return route.fulfill({ status: 404, body: "" });
        });
        await page.goto(`${origin}/admin/featured/new`);
        await page.locator("#f-body-count").waitFor();
        await run({ page, posts });
        expect(pageErrors, "real island bytes mount without runtime errors").toEqual([]);
      } finally {
        await context.close();
      }
    }

    it("body line breaks count as submitted CRLF in the mounted counter", async () => {
      await withPage(async ({ page }) => {
        const body = page.locator('[name="body"]');
        const counter = page.locator("#f-body-count");
        // 997 + one break + 1: 999 in .value, 1000 as submitted — in budget.
        await body.fill(`${"x".repeat(997)}\nx`);
        expect(await counter.textContent()).toContain("1000 of 1000");
        expect(await counter.textContent()).not.toMatch(/over|exceed|too long|too many/i);
        // 998 + one break + 1: 1000 in .value, 1001 as submitted — over.
        await body.fill(`${"x".repeat(998)}\nx`);
        expect(await counter.textContent()).toContain("1001 of 1000");
        expect(await counter.textContent()).toMatch(/1 over the limit/);
      });
    });

    it("at-limit counters carry no over state on their own nodes", async () => {
      await withPage(async ({ page }) => {
        await page.locator('[name="title"]').fill("x".repeat(255));
        const titleCounter = await page.locator("#f-title-count").textContent();
        expect(titleCounter).toContain("255 of 255");
        expect(titleCounter).not.toMatch(/over|exceed|too long|too many/i);
        await page.locator('[name="body"]').fill("x".repeat(1000));
        const bodyCounter = await page.locator("#f-body-count").textContent();
        expect(bodyCounter).toContain("1000 of 1000");
        expect(bodyCounter).not.toMatch(/over|exceed|too long|too many/i);
      });
    });

    it("the CRLF-tipped body warns before submit and arrives as CRLF", async () => {
      await withPage(async ({ page, posts }) => {
        await page.locator('[name="title"]').fill("Game night");
        await page.locator('[name="body"]').fill(`${"x".repeat(998)}\nx`);
        // The counter warns before Save: no save-time surprise.
        expect(await page.locator("#f-body-count").textContent()).toMatch(
          /1001 of 1000.*over the limit/s,
        );
        const response = page.waitForNavigation();
        await page.getByTestId("save-featured").click();
        expect((await response)?.status()).toBe(422);
        expect(posts).toHaveLength(1);
        const postedBody = posts[0]!.values.body ?? "";
        expect(postedBody).toContain("\r\n");
        expect([...postedBody]).toHaveLength(1001);
        // The rejected document keeps the field error and the over-budget counter.
        expect(await page.locator('[data-testid="error-body"]').textContent()).toContain(
          "Keep the body to 1000 characters.",
        );
        expect(await page.locator("#f-body-count").textContent()).toMatch(/over the limit/);
      });
    });
  },
);
