// ESN browser acceptance: real Hono route and executed Kit resolver/component SSR.
// Fixture-only; no app server, DB, guild or remote request. Normal CI *.spec.ts discovery.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e event-section-navigation.spec.ts --workers=1
// Optional evidence: EVENT_SECTION_SCREENSHOT_DIR=<owned-directory>. Open every capture.
// No generated/baseline UI, policy thresholds or ownership flags are changed here.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  compileScheduleKit,
  renderSectionPage,
  sectionEvent,
  sectionOrigin,
  sectionPath,
  type KitRenderer,
  type SectionViewer,
  type Twin,
} from "../test/helpers/event-section-navigation";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");
let kit: KitRenderer;
let sharedCss: string;
let kitCss: { build: (candidates: string[]) => string };
const sectionIds = [
  "event-description-heading",
  "event-accessibility-heading",
  "event-join-details-heading",
  "event-share-heading",
  "event-attendees-heading",
];

const sectionNames: Record<string, RegExp> = {
  "event-description-heading": /about|description/i,
  "event-accessibility-heading": /accessibility/i,
  "event-join-details-heading": /join/i,
  "event-share-heading": /calendar|date|share/i,
  "event-attendees-heading": /going|attendee|roster/i,
};

test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  kit = await compileScheduleKit();
  sharedCss = ["styles.css", "theme.css", "event-theme.css"]
    .map((path) => readFileSync(join(root, "public", path), "utf8"))
    .join("\n");
  kitCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});

async function openFixture(
  page: Page,
  twin: Twin,
  viewer: SectionViewer = "guest",
  minimal = false,
  fragment = "",
) {
  const row = sectionEvent(
    minimal
      ? { description: null, accessibilityNotes: null, join_url: null, join_instructions: null }
      : {},
  );
  const rendered = await renderSectionPage(twin, row, viewer, kit);
  expect(rendered.status, "fixture must reach detail, not an error page").toBe(200);
  const candidates = [...rendered.html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
    match[1]!.split(/\s+/),
  );
  const css = twin === "Kit" ? `${sharedCss}\n${kitCss.build(candidates)}\n${kit.css}` : sharedCss;
  expect(css).not.toContain("</style");
  const html = rendered.html.replace("</head>", `<style>${css}</style></head>`);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== sectionOrigin) return route.abort();
    if (url.pathname === sectionPath && route.request().isNavigationRequest()) {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    const path = resolve(root, "public", `.${url.pathname}`);
    if (!path.startsWith(`${join(root, "public")}/`)) return route.abort();
    try {
      const contentType = path.endsWith(".js")
        ? "application/javascript"
        : path.endsWith(".woff2")
          ? "font/woff2"
          : path.endsWith(".svg")
            ? "image/svg+xml"
            : "text/css";
      return route.fulfill({ status: 200, contentType, body: readFileSync(path) });
    } catch {
      return route.abort();
    }
  });
  await page.goto(`${sectionOrigin}${sectionPath}${fragment}`);
  await expect(page.getByRole("heading", { level: 1, name: row.title })).toBeVisible();
}

async function capture(page: Page, name: string) {
  const directory = process.env.EVENT_SECTION_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

async function noOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(widths.content, "no horizontal page overflow").toBeLessThanOrEqual(widths.viewport);
}

async function treatment(target: Locator) {
  return target.evaluate((element) =>
    [element, element.closest("section")!].map((node) => {
      const css = getComputedStyle(node);
      // Ignore colour: an outline/border, text decoration or marker must change.
      return {
        outline: `${css.outlineWidth}/${css.outlineStyle}`,
        border: [
          css.borderTopWidth,
          css.borderRightWidth,
          css.borderBottomWidth,
          css.borderLeftWidth,
        ].join("/"),
        decoration: css.textDecorationLine,
        shadowShape: css.boxShadow.replace(/rgba?\([^)]*\)|#[0-9a-f]+/gi, "COLOR"),
        before: getComputedStyle(node, "::before").content,
        after: getComputedStyle(node, "::after").content,
      };
    }),
  );
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test.describe(`${twin} ${viewport.width} no-JS sections`, () => {
      test.use({ javaScriptEnabled: false, viewport });
      for (const state of ["guest", "member", "minimal"] as const) {
        test(`ESN-B01 CONTROL ${state}: real styled fixture remains readable`, async ({ page }) => {
          await openFixture(page, twin, state === "minimal" ? "guest" : state, state === "minimal");
          await capture(page, `${twin}-${viewport.width}-${state}-overview`);
          await noOverflow(page);
          await expect(page.getByTestId("event-copy-link")).toHaveAttribute(
            "data-copy-link",
            `${sectionOrigin}${sectionPath}`,
          );
          if (state === "minimal")
            await expect(
              page.getByRole("navigation", { name: "On this event", exact: true }),
            ).toHaveCount(0);
          if (state === "member")
            await expect(page.getByTestId("event-attendees")).toContainText("section-private-one");
          else await expect(page.getByTestId("event-attendees")).toHaveCount(0);
        });
      }

      test("ESN-B02 RED: keyboard follows every native section link and continues without a trap", async ({
        page,
      }) => {
        await openFixture(page, twin, "member");
        const nav = page.getByRole("navigation", { name: "On this event", exact: true });
        await expect(nav, "missing native section index").toHaveCount(1);
        const links = nav.getByRole("link");
        expect(await links.count()).toBeGreaterThan(1);
        for (let i = 0; i < (await links.count()); i++) {
          const link = links.nth(i);
          await expect(link).toHaveAccessibleName(/\S/);
          const href = await link.getAttribute("href");
          expect(href).toMatch(/^#[^\s#]+$/);
          const id = decodeURIComponent(href!.slice(1));
          expect(sectionIds).toContain(id);
          await expect(link).toHaveAccessibleName(sectionNames[id]!);
          const target = page.locator(`[id="${id}"]`);
          await expect(target).toHaveCount(1);
          await link.focus();
          await link.press("Enter");
          expect(new URL(page.url()).hash).toBe(href);
          await expect(target, "fragment destination receives keyboard focus").toBeFocused();
          const box = await target.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.y, "destination is not hidden behind the header").toBeGreaterThanOrEqual(0);
          expect(box!.y).toBeLessThan(viewport.height);
          await page.keyboard.press("Tab");
          await expect(target).not.toBeFocused();
          const section = target.locator("xpath=ancestor::section[1]");
          const tabBudget =
            (await section
              .locator("a[href], button, input, select, textarea, [tabindex='0']")
              .count()) + 3;
          let escaped = false;
          for (let tab = 0; tab < tabBudget; tab++) {
            escaped = await section.evaluate((node) => !node.contains(document.activeElement));
            if (escaped) break;
            await page.keyboard.press("Tab");
          }
          expect(escaped, "Tab must leave the destination section naturally").toBe(true);
        }
        await noOverflow(page);
      });

      test("ESN-B03 RED: direct section URL is spaced and visibly oriented without colour alone", async ({
        page,
      }) => {
        await openFixture(page, twin);
        for (const id of sectionIds) {
          const target = page.locator(`h2[id="${id}"]`);
          if (!(await target.count())) continue; // Do not complete missing Kit parity.
          await page.goto(`${sectionOrigin}${sectionPath}`);
          const before = await treatment(target);
          // Native direct-fragment navigation, not scrollIntoView or app script.
          await page.goto(`${sectionOrigin}${sectionPath}#${id}`);
          if (id === "event-share-heading")
            await capture(page, `${twin}-${viewport.width}-direct-fragment`);
          await expect.soft(target, id).toBeInViewport();
          const margin = await target.evaluate((node) => {
            const values = [
              getComputedStyle(node).scrollMarginTop,
              getComputedStyle(node.closest("section")!).scrollMarginTop,
              getComputedStyle(document.documentElement).scrollPaddingTop,
            ];
            return Math.max(...values.map((value) => Number.parseFloat(value) || 0));
          });
          expect.soft(margin, `${id}: explicit fragment scroll spacing`).toBeGreaterThan(0);
          expect
            .soft(await treatment(target), `${id}: target orientation cannot be colour-only`)
            .not.toEqual(before);
          await noOverflow(page);
        }
      });

      test("ESN-B04 RED: ordinary section permalinks have section-specific accessible names", async ({
        page,
      }) => {
        await openFixture(page, twin, "member");
        const emitted = [];
        for (const id of sectionIds) {
          const heading = page.locator(`h2[id="${id}"]`);
          if (await heading.count()) emitted.push({ id, heading });
        }
        expect(emitted.length, "nonempty real sections, not a vacuous pass").toBeGreaterThan(1);
        for (const { id, heading } of emitted) {
          const section = heading.locator("xpath=ancestor::section[1]");
          const permalink = section.locator(`a[href$="#${id}"]`);
          await expect(permalink, `native permalink for ${id}`).toHaveCount(1);
          await expect(permalink).toHaveAccessibleName(sectionNames[id]!);
          await expect(permalink).not.toHaveAttribute("data-copy-link", /.*/);
          const destination = await permalink.evaluate((link) => (link as HTMLAnchorElement).href);
          expect(destination).toBe(`${sectionOrigin}${sectionPath}#${id}`);
          await expect(permalink).not.toHaveAttribute("role", "button");
        }
      });
    });
  }

  test(`${twin} ESN-B05 CONTROL: selecting a section never changes the whole-event clipboard URL`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copied: string }).copied = text;
          },
        },
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: { url?: string }) => {
          (window as unknown as { sharedUrl?: string }).sharedUrl = data.url;
        },
      });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    });
    await openFixture(page, twin, "guest", false, "#event-share-heading");
    await page.getByTestId("event-copy-link").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied))
      .toBe(`${sectionOrigin}${sectionPath}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${sectionOrigin}${sectionPath}`,
    );
    // Native share is independently owned and absent on the pinned base. If
    // that affordance is present at consumption, it must still share the event.
    const share = page.getByRole("button", { name: /^share(?: this event| event)?$/i });
    if (await share.count()) {
      await share.click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { sharedUrl?: string }).sharedUrl))
        .toBe(`${sectionOrigin}${sectionPath}`);
    }
  });
}
