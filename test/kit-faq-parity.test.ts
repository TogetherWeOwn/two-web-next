// route-inventory: GET /faq
// Kit parity slice.
// The Kit FAQ page (web/src/routes/faq/) renders the same content contract
// as the Hono leaf (src/screens/faq.tsx): every question group from the
// shared source (src/faq-content.ts), the strap and lead, and the exact
// public URL/canonical/cache contract with no session or database behavior.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRouteOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { FAQS, faqPageData } from "../src/faq-content";
import { transformContentLeafChunk } from "../src/kit-content-chunk";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { FAQS as screenFaqs } from "../src/screens/faq";
import { canonicalUrl } from "../src/seo";
import app from "./app";
import { contentLeafDom, GUEST_JOIN } from "./helpers/content-leaf-dom";
import type { Env } from "../src/env";

const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const SECTION_IDS = FAQS.map((group) => group.sectionId);
const QUESTIONS = FAQS.flatMap((group) => group.items.map(([question]) => question));
const QUESTION_COUNT = QUESTIONS.length;

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// The real Kit page, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as ci/kit-preview-e2e.mjs:
// #lib/* resolves through the web alias, relative src/* through the worktree).
async function buildKitFaqBundle(): Promise<{
  renderPage: (data: ReturnType<typeof faqPageData>) => string;
  applicationModules: string[];
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-faq-"));
  try {
    const entry = join(scratch, "kit-faq-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/faq/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
export function renderPage(data) {
  // Mirror the server load, which merges leafCss into the page data.
  const { head, body } = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-faq.mjs");
    const result = await build({
      metafile: true,
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
          name: "kit-faq-svelte-ssr",
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
    const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
      renderPage: (data: ReturnType<typeof faqPageData>) => string;
    };
    const applicationModules = Object.keys(result.metafile.inputs).filter(
      (module) => !module.includes("node_modules/"),
    );
    return { renderPage, applicationModules };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function honoFaq() {
  const res = await app.request("/faq", {}, env);
  return { res, html: await res.text() };
}

describe("faq manifest ownership", () => {
  it("ships the native faq route enabled as public reads", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/faq",
      enabled: true,
      reads: "public",
    });
  });

  it("owns /faq on Kit with Hono as the rollback", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/faq" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/faq" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/faq" })).toBe("hono");
    expect(
      resolveRouteOwner({ method: "GET", path: "/faq" }, [
        { method: "GET", path: "/faq", enabled: false, reads: "public" },
      ]),
    ).toBe("hono");
  });
});

describe("faq shared content source", () => {
  it("serves the same question groups to Hono, Markdown and Kit", () => {
    expect(screenFaqs).toBe(FAQS);
    expect(SECTION_IDS).toEqual([
      "faq-getting-in",
      "faq-first-week",
      "faq-ranks",
      "faq-events",
      "faq-onboarding",
      "faq-tickets",
      "faq-profile",
      "faq-privacy",
    ]);
    expect(QUESTION_COUNT).toBe(18);
  });

  it("passes the app URL and the shared questions to the Kit page", () => {
    const data = faqPageData(APP_URL);
    expect(data.appUrl).toBe(APP_URL);
    expect(data.faqs).toBe(FAQS);
  });
});

describe("Hono /faq contract", () => {
  it("answers 200 with the public cache contract and no session surface", async () => {
    const { res, html } = await honoFaq();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const dom = contentLeafDom(html);
    expect(dom.one("div", { "data-testid": "faq-list" })).toBeDefined();
    expect(dom.one("a", { "data-testid": "faq-join", href: "/join" })).toBeDefined();
    expect(dom.guestJoin()).toEqual(GUEST_JOIN);
    expect(dom.all("h3").map(dom.text)).toContain("How do I join?");
  });
});

describe("Kit /faq parity with Hono", () => {
  let renderPage: (data: ReturnType<typeof faqPageData>) => string;
  let applicationModules: string[];

  beforeAll(async () => {
    ({ renderPage, applicationModules } = await buildKitFaqBundle());
  }, 60_000);

  it("bundles no database or session modules", () => {
    const forbidden = applicationModules.filter((module) =>
      /(?:^|[\\/])(?:db|database|session)(?:[\\/.]|$)/i.test(module),
    );
    expect(forbidden).toEqual([]);
  });

  it("renders the identical question list", async () => {
    const kitHtml = renderPage(faqPageData(APP_URL));
    const { html: honoHtml } = await honoFaq();
    const list = { "data-testid": "faq-list" };
    const markup = (html: string) =>
      contentLeafDom(html)
        .markup("div", list)
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"');
    expect(markup(kitHtml)).toBe(markup(honoHtml));
  });

  it("keeps the semantic and a11y contract", () => {
    const html = renderPage(faqPageData(APP_URL));
    const dom = contentLeafDom(html);
    expect(dom.all("main")).toHaveLength(1);
    expect(dom.one("a", { class: "skip-link", href: "#main" })).toBeDefined();
    expect(dom.one("nav", { "aria-label": "Primary" })).toBeDefined();
    expect(dom.all("link", { rel: "canonical" })).toHaveLength(1);
    expect(
      dom.one("link", { rel: "canonical", href: canonicalUrl(APP_URL, "/faq") }),
    ).toBeDefined();
    expect(dom.text(dom.one("h1", { id: "faq-heading" }))).toBe("Frequently asked questions");
    expect(dom.text(dom.one("p", { class: "strap" }))).toBe("New here? Start here");
    const list = dom.one("div", { "data-testid": "faq-list" });
    expect(list).toBeDefined();
    const groups = list && dom.all("section", { "aria-labelledby": null }, list);
    expect(groups?.map((group) => dom.attr(group, "aria-labelledby"))).toEqual(SECTION_IDS);
    for (const id of SECTION_IDS) expect(dom.one("h2", { id })).toBeDefined();
    expect(dom.all("h3").map(dom.text)).toEqual(QUESTIONS);
    expect(dom.all("div", { class: "card" })).toHaveLength(QUESTION_COUNT);
    expect(dom.one("a", { "data-testid": "faq-join", href: "/join" })).toBeDefined();
    const nav = dom.one("nav", { "aria-label": "Community information" });
    expect(nav).toBeDefined();
    const current = nav && dom.all("a", { "aria-current": null }, nav);
    expect(current).toHaveLength(1);
    expect(dom.text(current?.[0])).toBe("FAQ");
    expect(current?.map((link) => dom.attr(link, "href"))).toEqual(["/faq"]);
    expect(current?.map((link) => dom.attr(link, "aria-current"))).toEqual(["page"]);
    expect(dom.one("a", { href: "/about", "aria-current": null })).toBeUndefined();
    expect(dom.one("a", { href: "/rules", "aria-current": null })).toBeUndefined();
    expect(dom.one("a", { href: "/privacy", "aria-current": null })).toBeUndefined();
    expect(dom.guestJoin()).toEqual(GUEST_JOIN);
    expect(html).not.toContain("Sign out");
  });

  it("keeps the markdown-alternate discovery both renderers share", async () => {
    const kit = contentLeafDom(renderPage(faqPageData(APP_URL)));
    const { html } = await honoFaq();
    const alternate = { rel: "alternate", href: "/faq.md" };
    expect(kit.one("link", { ...alternate, type: "text/markdown" })).toBeDefined();
    expect(contentLeafDom(html).one("link", alternate)).toBeDefined();
  });

  it("renders no scripts and no secret-shaped content (no-JS page)", () => {
    const html = renderPage(faqPageData(APP_URL));
    expect(contentLeafDom(html).elements.some((node) => node.tagName === "script")).toBe(false);
    expect(html).not.toMatch(/__Host-two_session\s*=/);
    expect(html).not.toMatch(/DISCORD_BOT_TOKEN/i);
  });

  it("serves the leaf CSS with zero render-blocking stylesheet links", () => {
    // Apply the production hook transform before checking the CSP-allowlisted CSS bytes.
    const dom = contentLeafDom(transformContentLeafChunk(renderPage(faqPageData(APP_URL))));
    expect(dom.inlineStyles()).toContain(LEAF_CRITICAL_CSS);
    expect(dom.linksWithRel("stylesheet")).toHaveLength(0);
    expect(
      dom.linksWithRel("preload").some((link) => dom.attr(link, "as")?.toLowerCase() === "style"),
    ).toBe(false);
    expect(dom.one("body", { class: "base-theme content-theme" })).toBeDefined();
    expect(
      dom.elements.some((node) => /lobby-|font-sans/.test(dom.attr(node, "class") ?? "")),
    ).toBe(false);
  });

  it("pins the server load contract at the source level", () => {
    const raw = readFileSync(
      new URL("../web/src/routes/faq/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(raw).toContain("export const csr = false");
    expect(raw).toContain('"public, max-age=3600"');
    // Comments describe the no-session/no-database contract in prose, so the
    // dependency pin runs on code only.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/dbFor|session|SESSION_STORE|postgres|drizzle|cookies|locals|parent/i);
    // The load takes only setHeaders: a second destructured property
    // (cookies, locals, request, parent) would be a session/cookie read even
    // under a name the token list above does not know.
    expect(code).toMatch(/async \(\{\s*setHeaders\s*\}\)/);
    // The leaf CSS reaches the page only through this load's data merge.
    expect(code).toContain("leafCss: LEAF_CRITICAL_CSS");
    // The stamp is the only config-driven behavior besides the canonical:
    // dropping FAQ_LAST_REVIEWED (or APP_URL) must fail this pin rather than
    // silently hide the date.
    expect(code).toMatch(/faqPageData\(env\.APP_URL,\s*env\.FAQ_LAST_REVIEWED\)/);
  });
});
