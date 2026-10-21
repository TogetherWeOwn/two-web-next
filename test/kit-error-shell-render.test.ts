// Rendered accessibility evidence for the Kit error shell: the real
// ErrorShell.svelte, compiled with the web workspace's svelte/compiler and
// bundled by esbuild (same harness shape as test/kit-rsvp-refusal-render.test.ts),
// SSR-rendered per Kit status (plus the 429 admin way-back) and loaded into
// Chromium so heading structure, recovery-link accessible names, focus order
// and axe results are asserted on the rendered DOM — not on source text. The source-text pins in
// test/kit-errors-outcome.test.ts stay as the import/branch contract; this
// suite proves what a member's browser and assistive tech actually receive.
//
// The document wrapper (`<html lang="en">`, charset, viewport) mirrors
// web/src/app.html, which supplies those at runtime around %sveltekit.head% /
// %sveltekit.body%. The head links /styles.css and /theme.css, and every Kit
// page also loads web/src/app.css through +layout.svelte — that file defines
// the Open Lobby tokens and dark canvas the shell colours resolve through.
// setContent cannot load any of them from about:blank, so the identical
// public/ bytes are inlined and app.css is compiled with the web workspace's
// @tailwindcss/node (class candidates taken from the rendered markup) and
// inlined with them — contrast and target-size then evaluate against the CSS
// Kit actually serves, exactly as in ci/a11y.mjs. A computed-style pin on the
// dark body background keeps the fixture from silently falling back to the
// light Hono palette. The axe gate is the shared one: WCAG_AA_TAGS +
// assertNoViolations from ci/a11y-policy.mjs, no rule exclusions.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { assertNoViolations as gateAssert, WCAG_AA_TAGS as gateTags } from "../ci/a11y-policy.mjs";
import { kitErrorCopy, type KitErrorStatus } from "../src/kit-errors";
import { registerPastArchiveBrowserAcceptance } from "./helpers/past-archive-search-browser-acceptance";

const WCAG_AA_TAGS = gateTags as string[];
const assertNoViolations = gateAssert as (
  results: Awaited<ReturnType<AxeBuilder["analyze"]>>,
  label: string,
) => void;

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};
const { compile: compileTailwind } = webRequire("@tailwindcss/node") as {
  compile: (
    css: string,
    options: { base: string; onDependency: (path: string) => void },
  ) => Promise<{ build: (candidates: string[]) => string }>;
};

const INVITE = "https://discord.gg/fixture-invite";

interface ExpectedLink {
  testid: string;
  name: string;
  href: string;
}

const HOME: ExpectedLink = { testid: "error-home", name: "Back to the homepage", href: "/" };
const INVITE_LINK: ExpectedLink = {
  testid: "error-invite",
  name: "Use the Discord invite instead",
  href: INVITE,
};

// The executed admin way-back: the 429 shell names the refused save and links
// the form first. The derivation itself (429-only, /admin-only) is unit-pinned
// in test/admin-wayback.test.ts; this suite proves what the browser receives.
const ADMIN_BACK = { href: "/admin/events/game-night", label: "Back to the event editor" };
const ADMIN_BACK_NOTE = "Your submission was not saved. Reopen the form and try again.";

const CASES: Array<{ code: KitErrorStatus; links: ExpectedLink[] }> = [
  {
    code: 400,
    links: [{ testid: "error-events", name: "Browse all events", href: "/events" }, HOME],
  },
  {
    code: 404,
    links: [
      { testid: "error-join", name: "Join with Discord", href: "/auth/discord" },
      HOME,
      { testid: "error-all-events", name: "Browse all events", href: "/events" },
    ],
  },
  {
    code: 403,
    links: [
      { testid: "error-join-unlock", name: "Join to unlock member pages", href: "/join" },
      INVITE_LINK,
      HOME,
    ],
  },
  {
    code: 410,
    links: [{ testid: "error-events", name: "Browse all events", href: "/events" }, HOME],
  },
  { code: 429, links: [INVITE_LINK, HOME] },
  { code: 500, links: [INVITE_LINK, HOME] },
  {
    code: 503,
    links: [INVITE_LINK, { testid: "error-retry", name: "Try again", href: "/" }],
  },
];

type RenderErrorShell = (
  code: KitErrorStatus,
  adminBack?: { href: string; label: string } | null,
) => { head: string; body: string };

// Opt in with KIT_ERROR_SHELL_BROWSER_TESTS=true after installing Playwright
// Chromium and the Kit workspace dependencies. The a11y CI job sets the
// opt-in and verifies every case executed (ci/a11y-require-executed.mjs);
// the check job installs no browser, so an ungated launch fails there.
describe.skipIf(process.env.KIT_ERROR_SHELL_BROWSER_TESTS !== "true")(
  "Kit error shell rendered accessibility",
  () => {
    let renderErrorShell: RenderErrorShell;
    let browser: Browser;
    let page: Page;
    let servedCss: string;

    beforeAll(async () => {
      const worktree = fileURLToPath(new URL("../", import.meta.url));
      servedCss = ["public/styles.css", "public/theme.css"]
        .map((path) => readFileSync(join(worktree, path), "utf8"))
        .join("\n");
      // Inlining is only safe while the served sheets cannot close the style tag.
      expect(servedCss).not.toContain("</style");

      const scratch = mkdtempSync(join(tmpdir(), "kit-error-shell-"));
      const entry = join(scratch, "kit-error-shell-entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import ErrorShell from ${JSON.stringify(join(worktree, "web/src/lib/ErrorShell.svelte"))};
export function renderErrorShell(code, adminBack) {
  const { head, body } = render(ErrorShell, { props: { code, inviteUrl: ${JSON.stringify(INVITE)}, adminBack: adminBack ?? null } });
  return { head, body };
}
`,
      );
      const outfile = join(scratch, "kit-error-shell.mjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: worktree,
        nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
        alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
        plugins: [
          {
            name: "kit-error-shell-svelte-ssr",
            setup(plugin) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
                const source = readFileSync(args.path, "utf8");
                const { js } = compile(source, {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                });
                return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
              });
            },
          },
        ],
      });
      ({ renderErrorShell } = (await import(pathToFileURL(outfile).href)) as {
        renderErrorShell: RenderErrorShell;
      });
      rmSync(scratch, { recursive: true, force: true });

      // Compile the Kit stylesheet +layout.svelte loads on every page. Class
      // candidates come from the rendered markup of every status, so the
      // utilities the shell uses (bg-lobby-*, text-lobby-*) are generated
      // exactly as the Kit build generates them; the unlayered canvas and
      // .base-theme token mapping in app.css ride along regardless.
      const candidates = new Set<string>();
      for (const { code } of CASES) {
        const { head, body } = renderErrorShell(code);
        for (const match of `${head}\n${body}`.matchAll(/class="([^"]+)"/g)) {
          for (const token of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
            candidates.add(token);
          }
        }
      }
      // The admin way-back markup renders outside CASES; fold one 429 render
      // with it into the candidates so the compiled stylesheet covers the note
      // and link exactly as the Kit build generates them.
      {
        const { head, body } = renderErrorShell(429, ADMIN_BACK);
        for (const match of `${head}\n${body}`.matchAll(/class="([^"]+)"/g)) {
          for (const token of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
            candidates.add(token);
          }
        }
      }
      const kitCompiler = await compileTailwind(
        readFileSync(join(worktree, "web/src/app.css"), "utf8"),
        { base: join(worktree, "web/src"), onDependency: () => {} },
      );
      const kitCss = kitCompiler.build([...candidates]);
      // Inlining is only safe while the compiled sheet cannot close the style tag.
      expect(kitCss).not.toContain("</style");
      servedCss = `${servedCss}\n${kitCss}`;

      browser = await chromium.launch();
      page = await (await browser.newContext()).newPage();
    }, 120000);

    afterAll(async () => {
      await browser?.close();
    });

    registerPastArchiveBrowserAcceptance(() => browser);

    async function loadShell(
      code: KitErrorStatus,
      adminBack?: { href: string; label: string } | null,
    ): Promise<void> {
      // The shell offers recovery with no session, DB or network reads: rendering
      // must succeed with fetch refusing every call, and never invoke it.
      const fetchSpy = vi.fn(() => {
        throw new Error("kit error shell fixtures must remain offline");
      });
      vi.stubGlobal("fetch", fetchSpy);
      let rendered: { head: string; body: string };
      try {
        rendered = renderErrorShell(code, adminBack);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      await page.setContent(
        `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
          `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
          `${rendered.head}<style>${servedCss}</style></head><body>${rendered.body}</body></html>`,
      );
    }

    for (const { code, links } of CASES) {
      it(`${code}: one heading, named recovery links in focus order, no echoed failure, axe clean`, async () => {
        await loadShell(code);
        const copy = kitErrorCopy(code);

        // String evaluate (the featured-native-length pattern): the root
        // tsconfig has no DOM lib, so the callback runs untyped in the page
        // and its shape is declared here.
        const dom = await page.evaluate<{
          title: string;
          robots: string | null | undefined;
          headings: Array<{ tag: string; id: string; text: string }>;
          labelledBy: string | null | undefined;
          labelTargetTag: string | null;
          recoveryCodeHidden: string | null | undefined;
          recoveryCodeText: string | null;
          mainLinks: Array<{ testid: string | null; href: string | null; text: string }>;
          sectionText: string;
          bodyBackground: string;
        }>(`(() => {
        const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((el) => ({
          tag: el.tagName,
          id: el.id,
          text: el.textContent?.trim() ?? "",
        }));
        const section = document.querySelector("main section");
        const labelledBy = section?.getAttribute("aria-labelledby");
        const labelTarget = labelledBy ? document.getElementById(labelledBy) : null;
        const recoveryCode = document.querySelector(".recovery-code");
        const mainLinks = [...document.querySelectorAll("main a[href]")].map((el) => ({
          testid: el.getAttribute("data-testid"),
          href: el.getAttribute("href"),
          text: el.textContent?.trim().replace(/\\s+/g, " ") ?? "",
        }));
        return {
          title: document.title,
          robots: document.querySelector('meta[name="robots"]')?.getAttribute("content"),
          headings,
          labelledBy,
          labelTargetTag: labelTarget?.tagName ?? null,
          recoveryCodeHidden: recoveryCode?.getAttribute("aria-hidden"),
          recoveryCodeText: recoveryCode?.textContent?.trim() ?? null,
          mainLinks,
          sectionText: section?.innerText ?? "",
          bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
      })()`);

        // Exactly one heading in the whole rendered page, and it is the
        // section's accessible label.
        expect(dom.headings).toEqual([{ tag: "H1", id: "error-heading", text: copy.title }]);
        expect(dom.labelledBy).toBe("error-heading");
        expect(dom.labelTargetTag).toBe("H1");
        // Palette guard: the page must be evaluating in the dark Lobby Ember
        // colours members see (--color-lobby-surface, #141117, from the
        // compiled app.css), never the light Hono canvas — otherwise the axe
        // contrast run below checks a page nobody is served.
        expect(dom.bodyBackground).toBe("rgb(20, 17, 23)");
        expect(dom.title).toBe(`${copy.title} — Together We Own`);
        expect(dom.robots).toBe("noindex, nofollow");
        // The big status numeral is decorative: visible, but out of the a11y tree.
        expect(dom.recoveryCodeHidden).toBe("true");
        expect(dom.recoveryCodeText).toBe(copy.code);

        // Recovery links: exact set, hrefs and visible text, in DOM order.
        expect(dom.mainLinks).toEqual(
          links.map((link) => ({ testid: link.testid, href: link.href, text: link.name })),
        );
        // Each link's accessible name (as computed for assistive tech) is its
        // expected name and resolves to exactly that link.
        for (const link of links) {
          const byRole = page.getByRole("link", { name: link.name, exact: true });
          expect(await byRole.count()).toBe(1);
          expect(await byRole.getAttribute("data-testid")).toBe(link.testid);
        }

        // No echoed failure: the section's visible text is exactly the static
        // code, title, lead and link names — nothing else can be leaking in.
        // innerText reflects the CSS text-transform, so compare case-folded;
        // exact-case copy is already pinned via textContent above.
        expect(
          dom.sectionText
            .split("\n")
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean),
        ).toEqual(
          [copy.code, copy.title, copy.lead, ...links.map((link) => link.name)].map((line) =>
            line.toLowerCase(),
          ),
        );

        // Focus order: tabbing through the page reaches the recovery links in
        // the same order they are read.
        await page.evaluate("document.activeElement?.blur()");
        const tabbed: string[] = [];
        for (let i = 0; i < 20 && tabbed.length < links.length; i++) {
          await page.keyboard.press("Tab");
          const testid = await page.evaluate<string | null>(
            "document.activeElement?.getAttribute('data-testid') ?? null",
          );
          if (testid?.startsWith("error-")) tabbed.push(testid);
        }
        expect(tabbed).toEqual(links.map((link) => link.testid));

        const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
        assertNoViolations(results, `kit error shell ${code}`);
      });
    }

    it("429 with adminBack: names the refused save, links the form first, axe clean", async () => {
      await loadShell(429, ADMIN_BACK);
      const copy = kitErrorCopy(429);

      // String evaluate (the featured-native-length pattern): the root
      // tsconfig has no DOM lib, so the callback runs untyped in the page
      // and its shape is declared here.
      const dom = await page.evaluate<{
        note: string | null;
        mainLinks: Array<{ testid: string | null; href: string | null; text: string }>;
        sectionText: string;
      }>(`(() => {
        const section = document.querySelector("main section");
        return {
          note: document.querySelector(".admin-back-note")?.textContent?.trim() ?? null,
          mainLinks: [...document.querySelectorAll("main a[href]")].map((el) => ({
            testid: el.getAttribute("data-testid"),
            href: el.getAttribute("href"),
            text: el.textContent?.trim().replace(/\\s+/g, " ") ?? "",
          })),
          sectionText: section?.innerText ?? "",
        };
      })()`);

      // The note names the loss honestly, and the way-back link carries the
      // pinned testid, the form href and its label, ahead of invite/home.
      expect(dom.note).toBe(ADMIN_BACK_NOTE);
      expect(dom.mainLinks).toEqual([
        { testid: "error-admin-back", href: ADMIN_BACK.href, text: ADMIN_BACK.label },
        { testid: INVITE_LINK.testid, href: INVITE_LINK.href, text: INVITE_LINK.name },
        { testid: HOME.testid, href: HOME.href, text: HOME.name },
      ]);
      // The label resolves as an accessible name to exactly that link.
      const byRole = page.getByRole("link", { name: ADMIN_BACK.label, exact: true });
      expect(await byRole.count()).toBe(1);
      expect(await byRole.getAttribute("data-testid")).toBe("error-admin-back");

      // No echoed failure: the section's visible text is exactly the static
      // code, title, lead, note and link names — nothing else can leak in.
      // innerText reflects the CSS text-transform, so compare case-folded.
      expect(
        dom.sectionText
          .split("\n")
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean),
      ).toEqual(
        [
          copy.code,
          copy.title,
          copy.lead,
          ADMIN_BACK_NOTE,
          ADMIN_BACK.label,
          ...[INVITE_LINK, HOME].map((link) => link.name),
        ].map((line) => line.toLowerCase()),
      );

      // Focus order: tabbing reaches the way-back link first.
      await page.evaluate("document.activeElement?.blur()");
      const tabbed: string[] = [];
      for (let i = 0; i < 20 && tabbed.length < 3; i++) {
        await page.keyboard.press("Tab");
        const testid = await page.evaluate<string | null>(
          "document.activeElement?.getAttribute('data-testid') ?? null",
        );
        if (testid?.startsWith("error-")) tabbed.push(testid);
      }
      expect(tabbed).toEqual(["error-admin-back", "error-invite", "error-home"]);

      const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
      assertNoViolations(results, "kit error shell 429 with admin way back");
    });
  },
);
