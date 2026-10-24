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
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import { resolveRouteOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { FAQS, faqPageData } from "../src/faq-content";
import { transformContentLeafChunk } from "../src/kit-content-chunk";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { FAQS as screenFaqs } from "../src/screens/faq";
import { canonicalUrl } from "../src/seo";
import app from "./app";
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

// The question list both renderers must agree on. The list is a div (not a
// section), so the shared sectionOf helper cannot anchor it: extract by tag
// depth instead, then apply the shared framework-tolerant treatment.
// Svelte's empty `<!---->` snippet anchors have no Hono counterpart, so they
// are excised first: zero-width hydration markers, serializer-owned like the
// markers the shared treatment already strips — never content. Quote
// entities differ the same way: Hono escapes `'`/`"` in text while Svelte
// emits them bare, so map the entities before comparing — the contract is
// the text, never the serializer's escaping.
function faqListOf(html: string): string {
  const start = html.indexOf('<div data-testid="faq-list">');
  if (start === -1) throw new Error("faq list is missing");
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      end = match.index + match[0].length;
      break;
    }
  }
  if (end === -1) throw new Error("faq list never closes");
  return normalizeSection(
    html
      .slice(start, end)
      .replace(/<!---->/g, "")
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"'),
  );
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
    expect(html).toContain('data-testid="faq-list"');
    expect(html).toContain('data-testid="faq-join"');
    expect(html).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(html).toContain("How do I join?");
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
    expect(faqListOf(kitHtml)).toBe(faqListOf(honoHtml));
  });

  it("keeps the semantic and a11y contract", () => {
    const html = renderPage(faqPageData(APP_URL));
    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('aria-label="Primary"');
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl(APP_URL, "/faq")}"`);
    expect(html).toContain('<h1 id="faq-heading">Frequently asked questions</h1>');
    expect(html).toContain('<p class="strap">New here? Start here</p>');
    expect(html.match(/<section aria-labelledby=/g)).toHaveLength(SECTION_IDS.length);
    for (const id of SECTION_IDS) expect(html).toContain(`id="${id}"`);
    for (const question of QUESTIONS) expect(html).toContain(question);
    expect(html.match(/<div class="card">/g)).toHaveLength(QUESTION_COUNT);
    expect(html).toContain('data-testid="faq-join"');
    expect(html).toContain('href="/join"');
    // Community-information nav: exactly the FAQ link is current.
    expect(html).toContain('aria-label="Community information"');
    expect(html).toContain('<a href="/faq" aria-current="page">FAQ</a>');
    expect(html).not.toContain('href="/about" aria-current');
    expect(html).not.toContain('href="/rules" aria-current');
    expect(html).not.toContain('href="/privacy" aria-current');
    // Header join action matches the Hono leaf's joinAction chrome byte for
    // byte for every visitor, without a session read.
    expect(html).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(html).not.toContain("Sign out");
  });

  it("keeps the markdown-alternate discovery both renderers share", async () => {
    // The Hono leaf always emits /faq.md via the Leaf chrome (page-shell);
    // the Kit page must too, or enabling it regresses machine discovery.
    // Attribute-wise: Svelte SSR owns void-element serialization, not us.
    const kit = renderPage(faqPageData(APP_URL));
    for (const token of ['rel="alternate"', 'type="text/markdown"', 'href="/faq.md"']) {
      expect(kit).toContain(token);
    }
    const { html: honoHtml } = await honoFaq();
    for (const token of ['rel="alternate"', 'href="/faq.md"']) {
      expect(honoHtml).toContain(token);
    }
  });

  it("renders no scripts and no secret-shaped content (no-JS page)", () => {
    const html = renderPage(faqPageData(APP_URL));
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/__Host-two_session\s*=/);
    expect(html).not.toMatch(/DISCORD_BOT_TOKEN/i);
  });

  it("serves the leaf CSS with zero render-blocking stylesheet links", () => {
    // Same served contract as the Hono leaf (test/leaf-css-drift.test.ts):
    // the exact hash-allowlisted block, no stylesheet link, and the Hono
    // body class so the leaf block owns the canvas. This harness renders the
    // page without +layout.svelte, so the layout asset SvelteKit adds on the
    // built worker is folded in through the production hook transform
    // (transformContentLeafChunk, via dispatchHookRequest): the assertion
    // runs on the transformed document, and ci/kit-worker-e2e.mjs pins the
    // same contract against the real built worker.
    const html = transformContentLeafChunk(renderPage(faqPageData(APP_URL)));
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<link(?=[^>]*rel="preload")(?=[^>]*as="style")/);
    expect(html).toContain('<body class="base-theme content-theme">');
    // The content shell must not lean on the stripped layout stylesheet:
    // no Tailwind utilities in the served class attributes (the leaf block
    // owns every styled element). Re-adding one stays green nowhere else.
    expect(html).not.toMatch(/class="[^"]*(lobby-|font-sans)/);
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
