// route-inventory: GET /faq, GET /faq.md
// Runs in the existing browser-smoke e2e lane, not browser-free Vitest jobs.
// Independent, failing-first, TEST-ONLY handoff. Builder must not edit this file.
// Real Hono routes, real Kit SSR/load and unconditional Chromium, no remote I/O.
// RED: missing topic index, answer IDs/permalinks, native keyboard/hash journey.
// CONTROL: old hashes/copy, public caching, Markdown, escaping and no scripts.
// ID spelling/data representation is deliberately not prescribed. IDs must be
// explicit shared data, survive copy edits/reordering, and resolve in both twins.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { Env } from "../src/env";
import { FAQS, faqPageData } from "../src/faq-content";
import app from "../test/app";

const origin = "https://example.test";
const env = {
  APP_URL: origin,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(
  join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
    "faq-answer-",
  ),
);
const original = structuredClone(FAQS);
const legacyTopics = [
  ["faq-getting-in", "Getting in"],
  ["faq-first-week", "Your first week"],
  ["faq-ranks", "Ranks and rewards"],
  ["faq-events", "Events"],
  ["faq-onboarding", "Game picker"],
  ["faq-tickets", "Support tickets"],
  ["faq-profile", "Your site profile"],
  ["faq-privacy", "Privacy and conduct"],
] as const;
const hostileQuestion = 'Rank availability <img src=x onerror="alert(1)"> — 雪 & "quotes"?';
const longAnswer =
  "No rank snapshot is available. " + "Ask a moderator; do not infer a rank. ".repeat(80);
const originalFetch = globalThis.fetch;
let browser: Browser;
let context: BrowserContext;
let renderKit: (data: ReturnType<typeof faqPageData>) => string;
let loadKit: (event: unknown) => Promise<Record<string, unknown>>;
let kitModules: string[];

test.beforeAll(async () => {
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler");
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "faq.mjs");
  // Same real-component SSR seam as kit-faq-parity.test.ts. Also execute the
  // real server load, rather than grepping its source for a cache/no-read claim.
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/faq/+page.svelte"))};
import { load } from ${JSON.stringify(join(root, "web/src/routes/faq/+page.server.ts"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(root, "src/leaf-critical-css.ts"))};
export const loadPage = load;
export const renderPage = data => {
  const r = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + r.head + '</head><body>' + r.body + '</body></html>';
};
`,
  );
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    absWorkingDir: root,
    metafile: true,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "faq-acceptance-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export const env = { APP_URL: ${JSON.stringify(origin)} };`,
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  const kit = await import(pathToFileURL(outfile).href);
  renderKit = kit.renderPage;
  loadKit = kit.loadPage;
  kitModules = Object.keys(result.metafile!.inputs);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  globalThis.fetch = async () => {
    throw new Error("FAQ acceptance forbids external fetch");
  };
});

test.afterEach(async () => {
  await context?.close();
  FAQS.splice(0, FAQS.length, ...structuredClone(original));
});
test.afterAll(async () => {
  globalThis.fetch = originalFetch;
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

// Replace values, never schema keys or ID fields: supports an added tuple ID or
// named item metadata without forcing the Builder to choose a representation.
function replaceCopy(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceCopy(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCopy(item, replacements)]),
    );
  }
  return value;
}

async function html(twin: "Hono" | "Kit") {
  if (twin === "Kit") return renderKit(faqPageData(origin));
  const response = await app.request("/faq", {}, env);
  expect(response.status).toBe(200);
  return response.text();
}

async function fixture(twin: "Hono" | "Kit", width = 1280, hash = "") {
  await context?.close();
  context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    viewport: { width, height: width === 390 ? 844 : 800 },
  });
  const page = await context.newPage();
  const document = await html(twin);
  // Actual SSR plus actual shipped styles; interception is fixture transport,
  // not a stand-in page or a test-only focus/target style.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/faq" && route.request().isNavigationRequest()) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document });
    }
    if (/^\/[a-z-]+\.css$/.test(url.pathname)) {
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync(join(root, "public", url.pathname.slice(1)), "utf8"),
      });
    }
    return route.abort();
  });
  await page.goto(`${origin}/faq${hash}`);
  return page;
}

function topicNav(page: Page) {
  return page.getByRole("navigation").filter({ has: page.locator('a[href="#faq-getting-in"]') });
}

async function answers(page: Page) {
  const rows: { question: string; id: string; href: string; name: string }[] = [];
  const headings = page.locator('[data-testid="faq-list"] h3');
  expect(await headings.count(), "all 18 existing answers remain").toBe(18);
  for (const heading of await headings.all()) {
    const card = heading.locator("..");
    const link = card.locator('a[href*="#"]');
    expect(await link.count(), "one descriptive permalink per answer").toBe(1);
    const href = (await link.getAttribute("href"))!;
    const destination = new URL(href, page.url());
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe("/faq");
    const id = decodeURIComponent(destination.hash.slice(1));
    expect(id, "nonempty stable answer fragment").toMatch(/^[a-z][a-z0-9-]+$/);
    const target = page.locator(`[id="${id}"]`);
    expect(await target.count(), "permalink resolves uniquely in this document").toBe(1);
    expect(
      await target.evaluate(
        (node, h) => node === h || node.contains(h),
        await heading.elementHandle(),
      ),
      "target identifies this answer, not its whole topic",
    ).toBe(true);
    expect(await target.locator("h3").count()).toBeLessThanOrEqual(1);
    // Accessible name may be visible copy or aria-label. The role snapshot
    // checks computed naming, including aria-labelledby, without prescribing it.
    const name = await link.ariaSnapshot();
    const text = (await heading.textContent())!;
    expect(name, "not an ambiguous #/link/share symbol").toMatch(/[A-Za-z]{3}/);
    rows.push({ question: text, id, href, name });
  }
  expect(new Set(rows.map((row) => row.id)).size, "answers never share an ID").toBe(18);
  return rows;
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(target).toBeFocused();
}

for (const twin of ["Hono", "Kit"] as const) {
  test.describe(`${twin} FAQ answer navigation`, () => {
    test("CONTROL: preserves legacy topic hashes, answer order/content and Markdown discovery", async () => {
      const page = await fixture(twin);
      expect(
        await page
          .locator('[data-testid="faq-list"] h2')
          .evaluateAll((nodes) => nodes.map((node) => [node.id, node.textContent])),
      ).toEqual(legacyTopics.map((row) => [...row]));
      const questions = original.flatMap((group) => group.items.map(([q]) => q));
      const headings = await page.locator('[data-testid="faq-list"] h3').allTextContents();
      expect(headings).toHaveLength(questions.length);
      for (let i = 0; i < questions.length; i++) expect(headings[i]).toContain(questions[i]);
      for (const group of original)
        for (const [q, a, link] of group.items) {
          const card = page
            .locator('[data-testid="faq-list"] h3')
            .filter({ hasText: q })
            .locator("..");
          expect(await card.locator("p").textContent()).toContain(a);
          if (link)
            await expect(card.getByRole("link", { name: link.label, exact: true })).toHaveAttribute(
              "href",
              link.href,
            );
        }
      expect(
        await page.locator('link[rel="alternate"][type="text/markdown"]').getAttribute("href"),
      ).toBe("/faq.md");
      expect(await page.locator("script").count()).toBe(0);
      await expect(page.getByTestId("faq-join")).toHaveAttribute("href", "/join");
    });

    test("CONTROL: an unknown bookmark still renders the full readable FAQ without scripts", async () => {
      const page = await fixture(twin, 390, "#not-a-real-answer");
      expect(await page.locator(":target").count()).toBe(0);
      expect(await page.locator('[data-testid="faq-list"] h3').count()).toBe(18);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Frequently asked questions",
      );
      expect(await page.locator("script").count()).toBe(0);
      await expect(page.getByTestId("faq-join")).toHaveAttribute("href", "/join");
    });

    test("RED: exposes a named, visible topic navigation resolving every old section hash", async () => {
      const page = await fixture(twin);
      const nav = topicNav(page);
      expect(await nav.count(), "topic-jump navigation is missing").toBe(1);
      expect(await nav.ariaSnapshot()).toMatch(/^- navigation "[^"]+"/);
      await expect(nav).toBeVisible();
      expect(await nav.locator("a").count()).toBe(8);
      for (const [id, label] of legacyTopics) {
        const link = nav.locator(`a[href="#${id}"]`);
        expect(await link.count()).toBe(1);
        expect(await link.ariaSnapshot()).toContain(label);
        await expect(link).toBeVisible();
        await expect(page.locator(`[id="${id}"]`)).toHaveText(label);
      }
    });

    test("RED: gives every answer a distinct shared-data ID and question-specific permalink name", async () => {
      const page = await fixture(twin);
      const rows = await answers(page);
      for (let i = 0; i < rows.length; i++) {
        const item = original.flatMap((group) => group.items)[i]!;
        const row = rows[i]!;
        expect(
          strings(item),
          "ID must be stored with shared FAQ data, not generated by a renderer",
        ).toContain(row.id);
        expect(row.name, "link name identifies which answer is shared").toContain(item[0]);
        expect(legacyTopics.map(([id]) => id)).not.toContain(row.id);
      }
      const ids = await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
      expect(new Set(ids).size, "no collision with shell/section IDs").toBe(ids.length);
    });

    test("RED: answer IDs survive reordered items rather than following positional indexes", async () => {
      const before = await answers(await fixture(twin));
      for (const group of FAQS) group.items.reverse();
      const after = await answers(await fixture(twin));
      expect(after.map(({ question, id }) => [question, id]).sort()).toEqual(
        before.map(({ question, id }) => [question, id]).sort(),
      );
      expect(after.map((row) => row.question)).not.toEqual(before.map((row) => row.question));
    });

    test("RED: rank/null-state copy and question edits never change an answer URL", async () => {
      const before = await answers(await fixture(twin));
      const rank = original.find((group) => group.sectionId === "faq-ranks")!;
      const replacements = new Map(
        rank.items.flatMap(([q, a]) => [
          [q, hostileQuestion + q],
          [a, longAnswer],
        ]),
      );
      FAQS.splice(0, FAQS.length, ...(replaceCopy(original, replacements) as typeof FAQS));
      const after = await answers(await fixture(twin));
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      expect(after.map((row) => row.question).join(" ")).toContain(hostileQuestion);
    });

    test("CONTROL: hostile and long fallback copy stays literal readable text, not executable markup", async () => {
      const [q, a] = original.find((group) => group.sectionId === "faq-ranks")!.items[0]!;
      FAQS.splice(
        0,
        FAQS.length,
        ...(replaceCopy(
          original,
          new Map([
            [q, hostileQuestion],
            [a, longAnswer],
          ]),
        ) as typeof FAQS),
      );
      const page = await fixture(twin, 390);
      expect(await page.locator('[data-testid="faq-list"]').textContent()).toContain(
        hostileQuestion,
      );
      expect(await page.locator('[data-testid="faq-list"]').textContent()).toContain(longAnswer);
      expect(await page.locator('[data-testid="faq-list"] img, [onerror], script').count()).toBe(0);
      expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    });

    for (const width of [1280, 390]) {
      test(`RED: ${width}px no-JS keyboard topic jump, answer share and fresh deep link`, async () => {
        const lastAnswer = original.at(-1)!.items[0]![1];
        FAQS.splice(
          0,
          FAQS.length,
          ...(replaceCopy(original, new Map([[lastAnswer, longAnswer]])) as typeof FAQS),
        );
        const page = await fixture(twin, width);
        const nav = topicNav(page);
        expect(await nav.count(), "topic-jump navigation is missing").toBe(1);
        const topic = nav.locator('a[href="#faq-events"]');
        await tabTo(page, topic);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${origin}/faq#faq-events`);
        await expect(page.locator(":target")).toBeInViewport();
        await page.locator(":target").focus();
        await expect(page.locator(":target")).toBeFocused();
        const rows = await answers(page);
        const answer = rows[rows.length - 1]!;
        const link = page.locator(
          `[data-testid="faq-list"] a[href=${JSON.stringify(answer.href)}]`,
        );
        await tabTo(page, link);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${origin}/faq#${answer.id}`);
        const target = page.locator(":target");
        await expect(target).toBeInViewport();
        // Hash targets must accept focus without a click handler. Native links
        // count; otherwise tabindex=-1 (or 0) on the destination is sufficient.
        await target.focus();
        await expect(target).toBeFocused();
        const bookmark = page.url();
        await page.goto(`${origin}/faq`);
        await page.goto(bookmark);
        await expect(page.locator(":target")).toBeInViewport();
        expect(await page.locator(":target").textContent()).toContain("What do you store about me");
        await expect(page.getByText(longAnswer, { exact: true })).toBeVisible();
        expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
      });
    }
  });
}

test.describe("FAQ public-read and alternate regression controls", () => {
  test("RED: copied answer fragments resolve to the same question in both renderers", async () => {
    const hono = await answers(await fixture("Hono"));
    const kit = await answers(await fixture("Kit"));
    expect(kit.map(({ question, id }) => [question, id])).toEqual(
      hono.map(({ question, id }) => [question, id]),
    );
  });

  test("CONTROL: Hono HTML and Markdown stay public and cookie-independent without reading sessions", async () => {
    const signedCookie = (
      await serializeSigned("__Host-two_session", "faq-fixture-session", env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
      })
    ).split(";")[0]!;
    const noSessionEnv = {
      ...env,
      get SESSION_STORE() {
        throw new Error("Static FAQ must not read session storage");
      },
    };
    for (const path of ["/faq", "/faq.md"]) {
      const guest = await app.request(path, {}, noSessionEnv);
      const cookie = await app.request(path, { headers: { cookie: signedCookie } }, noSessionEnv);
      expect(guest.status).toBe(200);
      expect(cookie.status).toBe(200);
      expect(cookie.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(cookie.headers.getSetCookie()).toEqual([]);
      expect(await cookie.text()).toBe(await guest.text());
    }
  });

  test("CONTROL: real Kit load uses only APP_URL/setHeaders, public cache and no session/DB dependency", async () => {
    const headers: Record<string, string> = {};
    const event = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "setHeaders")
            return (values: Record<string, string>) => Object.assign(headers, values);
          throw new Error(`Static FAQ must not read event.${String(key)}`);
        },
      },
    );
    const data = await loadKit(event);
    expect(headers).toEqual({ "cache-control": "public, max-age=3600" });
    expect(data.appUrl).toBe(origin);
    expect(data.faqs).toEqual(FAQS);
    expect(
      kitModules.filter((path) =>
        /(?:^|\/)(?:db|sessions?|postgres|drizzle-orm)(?:[/.]|$)/i.test(path),
      ),
    ).toEqual([]);
  });

  test("CONTROL: Markdown still presents every answer and the recovery-guide destination truthfully", async () => {
    const response = await app.request("/faq.md", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const markdown = await response.text();
    let position = -1;
    for (const group of original)
      for (const [q, a, link] of group.items) {
        const next = markdown.indexOf(`### ${q}`, position + 1);
        expect(next).toBeGreaterThan(position);
        position = next;
        expect(markdown).toContain(a);
        if (link) expect(markdown).toContain(`[${link.label}](${link.href})`);
      }
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toContain("[object Object]");
  });
});
