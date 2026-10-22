// route-inventory: GET /about
// Kit parity slice.
// The Kit about page (web/src/routes/about/) renders the same content
// contract as the Hono leaf (src/screens/about.tsx): the strap, lead and
// three fact cards from the shared source (src/about-content.ts), and the
// exact public URL/canonical/cache contract with no session or database
// behavior.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import { ABOUT_FACTS, ABOUT_LEAD, ABOUT_STRAP, aboutPageData } from "../src/about-content";
import { transformContentLeafChunk } from "../src/kit-content-chunk";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { resolveRouteOwner, ROUTE_MANIFEST } from "../src/route-ownership";
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

const FACT_TERMS = [
  "Voice-first",
  "No application, no interview",
  "From forum threads to voice rooms",
];

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
async function buildKitAboutBundle(): Promise<{
  renderPage: (data: ReturnType<typeof aboutPageData>) => string;
  applicationModules: string[];
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-about-"));
  try {
    const entry = join(scratch, "kit-about-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/about/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
export function renderPage(data) {
  // Mirror the server load, which merges leafCss into the page data.
  const { head, body } = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-about.mjs");
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
          name: "kit-about-svelte-ssr",
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
      renderPage: (data: ReturnType<typeof aboutPageData>) => string;
    };
    const applicationModules = Object.keys(result.metafile.inputs).filter(
      (module) => !module.includes("node_modules/"),
    );
    return { renderPage, applicationModules };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The content section both renderers must agree on, extracted by the stable
// aria-labelledby anchor (the section carries no testid on either side) and
// compared through the shared framework-tolerant treatment. Svelte's empty
// `<!---->` snippet/if anchors have no Hono counterpart, so they are excised
// first: zero-width hydration markers, serializer-owned like the markers the
// shared treatment already strips — never content.
function contentSectionOf(html: string): string {
  const match = html.match(/<section[^>]*aria-labelledby="about-heading"[\s\S]*?<\/section>/);
  if (!match) throw new Error("about content section is missing");
  return normalizeSection(match[0].replace(/<!---->/g, ""));
}

async function honoAbout() {
  const res = await app.request("/about", {}, env);
  return { res, html: await res.text() };
}

describe("about manifest ownership", () => {
  it("ships the native about route enabled as public reads", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/about",
      enabled: true,
      reads: "public",
    });
  });

  it("owns /about on Kit with Hono as the rollback", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/about" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/about" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/about" })).toBe("hono");
    expect(
      resolveRouteOwner({ method: "GET", path: "/about" }, [
        { method: "GET", path: "/about", enabled: false, reads: "public" },
      ]),
    ).toBe("hono");
  });
});

describe("about shared content source", () => {
  it("serves the strap, lead and three fact cards both renderers share", () => {
    expect(ABOUT_STRAP).toBe("Est. 1998");
    expect(ABOUT_LEAD).toContain("An adult gaming community");
    expect(ABOUT_FACTS.map(([term]) => term)).toEqual(FACT_TERMS);
    expect(aboutPageData(APP_URL)).toEqual({
      appUrl: APP_URL,
      strap: ABOUT_STRAP,
      lead: ABOUT_LEAD,
      facts: ABOUT_FACTS,
    });
  });

  it("pins the Hono screen to the shared module, not a copied sentence", () => {
    const raw = readFileSync(new URL("../src/screens/about.tsx", import.meta.url), "utf8");
    // The screen renders through the shared seam (which owns the static
    // null-state bytes and the live derivation), never a pasted sentence.
    // Call-site pins (with the call paren/keys) so the import line alone
    // cannot satisfy them.
    expect(raw).toContain("aboutPageData(appUrl, ranks)");
    expect(raw).toContain("ranks?: LadderRank[]");
    expect(raw).toContain("../about-content");
  });
});

describe("Hono /about contract", () => {
  it("answers 200 with the public cache contract and no session surface", async () => {
    const { res, html } = await honoAbout();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(html).toContain('data-testid="about-facts"');
    expect(html).toContain('data-testid="about-join"');
    expect(html).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(html).toContain('<h1 id="about-heading">About Together We Own</h1>');
    for (const [term, definition] of ABOUT_FACTS) {
      expect(html).toContain(term);
      expect(html).toContain(definition);
    }
  });
});

describe("Kit /about parity with Hono", () => {
  let renderPage: (data: ReturnType<typeof aboutPageData>) => string;
  let applicationModules: string[];

  beforeAll(async () => {
    ({ renderPage, applicationModules } = await buildKitAboutBundle());
  }, 60_000);

  it("bundles no database or session modules", () => {
    const forbidden = applicationModules.filter((module) =>
      /(?:^|[\\/])(?:db|database|session)(?:[\\/.]|$)/i.test(module),
    );
    expect(forbidden).toEqual([]);
  });

  it("renders the identical content section", async () => {
    const kitHtml = renderPage(aboutPageData(APP_URL));
    const { html: honoHtml } = await honoAbout();
    expect(contentSectionOf(kitHtml)).toBe(contentSectionOf(honoHtml));
  });

  it("keeps the semantic and a11y contract", () => {
    const html = renderPage(aboutPageData(APP_URL));
    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('aria-label="Primary"');
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl(APP_URL, "/about")}"`);
    expect(html).toContain('<h1 id="about-heading">About Together We Own</h1>');
    expect(html).toContain('<p class="strap">Est. 1998</p>');
    expect(html).toContain("An adult gaming community");
    for (const term of FACT_TERMS) expect(html).toContain(term);
    expect(html.match(/<div class="card">/g)).toHaveLength(3);
    expect(html).toContain('data-testid="about-facts"');
    expect(html).toContain('data-testid="about-join"');
    expect(html).toContain('href="/join"');
    // Community-information nav: exactly the About link is current.
    expect(html).toContain('aria-label="Community information"');
    expect(html).toContain('<a href="/about" aria-current="page">About</a>');
    expect(html).not.toContain('href="/faq" aria-current');
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
    // The Hono leaf always emits /about.md via the Leaf chrome (page-shell);
    // the Kit page must too, or enabling it regresses machine discovery.
    // Attribute-wise: Svelte SSR owns void-element serialization, not us.
    const kit = renderPage(aboutPageData(APP_URL));
    for (const token of ['rel="alternate"', 'type="text/markdown"', 'href="/about.md"']) {
      expect(kit).toContain(token);
    }
    const { html: honoHtml } = await honoAbout();
    for (const token of ['rel="alternate"', 'href="/about.md"']) {
      expect(honoHtml).toContain(token);
    }
  });

  it("renders no scripts and no secret-shaped content (no-JS page)", () => {
    const html = renderPage(aboutPageData(APP_URL));
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
    const html = transformContentLeafChunk(renderPage(aboutPageData(APP_URL)));
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
      new URL("../web/src/routes/about/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(raw).toContain("export const csr = false");
    expect(raw).toContain('"public, max-age=3600"');
    // Comments describe the no-session/no-cookie/no-web-database contract in
    // prose, so the dependency pin runs on code only. The single allowed
    // database read is the bot-owned ranks leg for the ladder fact.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/dbFor|session|SESSION_STORE|postgres|drizzle|cookies|locals|parent/i);
    expect(code).toContain("readRanks(env)");
    // The load takes only setHeaders: a second destructured property
    // (cookies, locals, request, parent) would be a session/cookie read even
    // under a name the token list above does not know.
    expect(code).toMatch(/async \(\{\s*setHeaders\s*\}\)/);
    // The leaf CSS reaches the page only through this load's data merge.
    expect(code).toContain("leafCss: LEAF_CRITICAL_CSS");
    // APP_URL plus the live ranks drive the render: dropping either must fail
    // this pin rather than silently render a wrong canonical or stale fact.
    expect(code).toMatch(/aboutPageData\(env\.APP_URL, ranks\)/);
  });
});
