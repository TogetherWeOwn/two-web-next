// Synthetic SSR component coverage, not real-route or gallery evidence.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createKitSsrRenderer } from "../test/helpers/kit-ssr-render";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { css: { code: string } | null };
};
const origin = "https://filters.example.test";

function componentCss(file: string): string {
  const path = join(root, file);
  // Same filename and options as the SSR build, so scoped class hashes match.
  const { css } = compile(readFileSync(path, "utf8"), {
    generate: "client",
    dev: false,
    filename: path,
  });
  return css?.code ?? "";
}

function tokenCss(): string {
  const theme = readFileSync(join(root, "web/src/ember-theme.css"), "utf8");
  const root_ = /@theme\s*\{([^}]*)\}/.exec(theme)?.[1];
  const base = /\.base-theme\s*\{([^}]*)\}/.exec(theme)?.[1];
  if (!root_ || !base) throw new Error("ember-theme.css token blocks not found");
  return `:root{${root_}}.base-theme{${base}}`;
}

let page_ = "";

test.beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-filter-links.svelte");
  try {
    const { head, body } = splitDocument(renderer.renderPage({}));
    const css = [
      tokenCss(),
      "body{margin:8px;background:var(--g0);color:var(--t1);font-family:var(--font-ui)}",
      componentCss("web/src/lib/Chip.svelte"),
      componentCss("web/src/lib/SegmentedControl.svelte"),
    ].join("\n");
    page_ = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Filter links</title>${head}<style>${css}</style></head><body><main class="base-theme">${body}</main></body></html>`;
  } finally {
    renderer.cleanup();
  }
});

function splitDocument(html: string) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  return { head, body };
}

async function mount(context: BrowserContext) {
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") return route.abort("blockedbyclient");
    if (url.pathname === "/fixture") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page_ });
    }
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Destination</title><h1 id="dest">${url.pathname}${url.search.replace(/&/g, "&amp;")}</h1>`,
    });
  });
}

async function open(page: Page) {
  const response = await page.goto(`${origin}/fixture`);
  expect(response?.status()).toBe(200);
}

const style = (page: Page, selector: string, props: string[]) =>
  page.locator(selector).evaluate((el, names) => {
    const css = (globalThis as any).getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, css.getPropertyValue(name)]));
  }, props);

test.describe("filter links: semantics and zero counts", () => {
  test("marks the current page and selected chip and keeps zero counts", async ({
    page,
    context,
  }) => {
    await mount(context);
    await open(page);

    const nav = page.getByRole("navigation", { name: "Event views" });
    await expect(nav).toBeVisible();
    const upcoming = nav.getByRole("link", { name: /Upcoming/ });
    await expect(upcoming).toHaveAttribute("aria-current", "page");
    await expect(upcoming).toHaveAttribute("href", "/events");
    await expect(upcoming.locator(".count")).toHaveText("0");
    await expect(upcoming.locator(".count")).toBeVisible();
    const past = nav.getByRole("link", { name: /Past/ });
    await expect(past).not.toHaveAttribute("aria-current", /.*/);
    await expect(past.locator(".count")).toHaveText("2");

    const all = page.getByRole("link", { name: /All games/ });
    await expect(all).toHaveAttribute("aria-current", "true");
    await expect(all.locator(".count")).toHaveText("0");
    const other = page.getByRole("link", { name: "Other games", exact: true });
    await expect(other).not.toHaveAttribute("aria-current", /.*/);
    await expect(other.locator(".count")).toHaveCount(0);

    const selectedBg = await style(page, 'a[aria-current="true"]', ["background-color"]);
    const plainBg = await style(page, 'a[href="/events?game=other"]', ["background-color"]);
    expect(selectedBg["background-color"]).not.toBe(plainBg["background-color"]);
    const currentBg = await style(page, 'a[aria-current="page"]', ["background-color"]);
    const siblingBg = await style(page, 'a[href="/events/past"]', ["background-color"]);
    expect(currentBg["background-color"]).not.toBe(siblingBg["background-color"]);
  });
});

test.describe("filter links: native navigation and keyboard", () => {
  test("click follows the href as a normal navigation", async ({ page, context }) => {
    await mount(context);
    await open(page);
    await page.getByRole("link", { name: /Past/ }).click();
    await expect(page).toHaveURL(`${origin}/events/past`);
    await expect(page.locator("#dest")).toHaveText("/events/past");
    await page.goBack();
    await page.getByRole("link", { name: "Other games", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/events?game=other`);
  });

  test("Tab reaches every link in order, shows focus, and Enter navigates", async ({
    page,
    context,
  }) => {
    await mount(context);
    await open(page);
    const hrefs = ["/events", "/events/past", "/events?game=all", "/events?game=other"];
    for (const href of hrefs) {
      await page.keyboard.press("Tab");
      const focused = page.locator(`a[href="${href}"]`);
      await expect(focused).toBeFocused();
      const focus = await style(page, `a[href="${href}"]`, [
        "outline-width",
        "outline-style",
        "outline-offset",
      ]);
      expect(focus["outline-style"]).not.toBe("none");
      expect(focus["outline-width"]).toBe("2px");
      expect(focus["outline-offset"]).toBe("3px");
    }
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator('a[href="/events?game=all"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/events?game=all`);
    await expect(page.locator("#dest")).toHaveText("/events?game=all");
  });
});

test.describe("filter links: no JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("render and navigate with scripting disabled", async ({ page, context }) => {
    await mount(context);
    await open(page);
    await expect(page.locator("script")).toHaveCount(0);
    await expect(page.getByRole("link")).toHaveCount(4);
    await expect(page.locator('a[aria-current="page"] .count')).toHaveText("0");
    await page.keyboard.press("Tab");
    await expect(page.locator('a[href="/events"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/events`);
    await expect(page.locator("#dest")).toHaveText("/events");
  });
});

test.describe("filter links: responsive", () => {
  for (const [name, size] of [
    ["mobile 390x844", { width: 390, height: 844 }],
    ["narrow 320x640", { width: 320, height: 640 }],
  ] as const) {
    test(`${name} fits the viewport and fills the control`, async ({ page, context }) => {
      await page.setViewportSize(size);
      await mount(context);
      await open(page);
      const layout = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const nav = doc.querySelector("nav").getBoundingClientRect();
        const links = [...doc.querySelectorAll("nav a")].map((a: any) => a.getBoundingClientRect());
        return {
          overflow: doc.documentElement.scrollWidth > (globalThis as any).innerWidth,
          navWidth: nav.width,
          navRight: nav.right,
          linkHeights: links.map((r: any) => r.height),
          linkWidthSpread: Math.abs(links[0].width - links[1].width),
        };
      });
      expect(layout.overflow).toBe(false);
      expect(layout.navWidth).toBeGreaterThanOrEqual(size.width - 16 - 1);
      expect(layout.navRight).toBeLessThanOrEqual(size.width);
      for (const height of layout.linkHeights) expect(height).toBeGreaterThanOrEqual(36);
      expect(layout.linkWidthSpread).toBeLessThan(24);
    });
  }

  test("desktop 1280x800 keeps the control compact", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mount(context);
    await open(page);
    const width = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThan(400);
  });
});

test.describe("filter links: forced colors", () => {
  test.use({ forcedColors: "active" });

  test("keeps borders and the current marker without relying on fills", async ({
    page,
    context,
  }) => {
    await mount(context);
    await open(page);
    expect(
      await page.evaluate(() => (globalThis as any).matchMedia("(forced-colors: active)").matches),
    ).toBe(true);

    const plain = await style(page, 'a[href="/events?game=other"]', [
      "border-top-width",
      "border-top-style",
    ]);
    expect(plain["border-top-style"]).toBe("solid");
    expect(plain["border-top-width"]).toBe("1px");

    const selected = await style(page, 'a[aria-current="true"]', [
      "border-top-width",
      "border-top-style",
    ]);
    expect(selected["border-top-style"]).toBe("solid");
    expect(selected["border-top-width"]).toBe("2px");

    const current = await style(page, 'a[aria-current="page"]', ["outline-width", "outline-style"]);
    expect(current["outline-style"]).toBe("solid");
    expect(current["outline-width"]).toBe("1px");
    const sibling = await style(page, 'a[href="/events/past"]', ["outline-style"]);
    expect(sibling["outline-style"]).toBe("none");

    // Keyboard focus stays visible under forced colors.
    await page.keyboard.press("Tab");
    await expect(page.locator('a[href="/events"]')).toBeFocused();
    const focus = await style(page, 'a[href="/events"]', ["outline-style", "outline-width"]);
    expect(focus["outline-style"]).not.toBe("none");
    expect(focus["outline-width"]).toBe("2px");
  });
});
