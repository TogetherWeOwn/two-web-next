// route-inventory: GET /about
// route-inventory: GET /faq
// route-inventory: GET /rules
// route-inventory: GET /privacy
//
// Leaf share descriptions acceptance: each public information leaf carries
// its own truthful description in the HTML meta description, og:description
// and twitter:description tags, from one shared static authority used by both
// the Hono and Kit renderers.
//
// Test-author owned: consume unchanged; request corrections from the
// acceptance author via a new card. Builder implements the authority module
// and wires both renderers; never edit this file.
//
// Contract: EXPECTED_LEAF_DESCRIPTIONS below is the exact shared copy. Each
// sentence is true to the linked page's current content and adds no new
// legal, privacy or SEO-performance claim:
// - /about names the adult community, the 1998 founding (page strap
//   "Est. 1998") and the open doors for newcomers (page lead).
// - /faq lists the page's own section topics: joining, first week, ranks,
//   events, game picker, tickets, profiles and conduct.
// - /rules lists the five rule titles verbatim; the ampersand pins safe
//   escaping (&amp;) in real renderer output.
// - /privacy names the policy's own coverage: what the site stores, who can
//   see it, and how to ask for deletion.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aboutPageData } from "../src/about-content";
import type { Env } from "../src/env";
import { faqPageData } from "../src/faq-content";
import { Layout } from "../src/pages";
import { POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { resolveRouteOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { rulesPageData } from "../src/rules-content";
import { canonicalUrl } from "../src/seo";
import app from "./app";

const APP_URL = "https://next.example.test";
const GENERIC_DESCRIPTION = "Together We Own: a close-knit adult gaming community, founded 1998.";

export const EXPECTED_LEAF_DESCRIPTIONS = {
  "/about":
    "About Together We Own: an adult gaming community since 1998, now open for newcomers to turn up and say hello.",
  "/faq":
    "Newcomer FAQ: joining, first week, ranks, events, game picker, tickets, profiles and conduct.",
  "/rules":
    "House rules: 18+ only, Respect the room, Voice-first, Play fair & Moderators have the last word.",
  "/privacy":
    "Privacy policy: what the website stores, who can see it, and how to ask for deletion.",
} as const;

type LeafPath = keyof typeof EXPECTED_LEAF_DESCRIPTIONS;
const LEAF_PATHS = Object.keys(EXPECTED_LEAF_DESCRIPTIONS) as LeafPath[];

const EXPECTED_LEAF_TITLES: Record<LeafPath, string> = {
  "/about": "About — Together We Own",
  "/faq": "FAQ — Together We Own",
  "/rules": "House rules — Together We Own",
  "/privacy": "Privacy policy — Together We Own",
};

// Hono <main>…</main> sha256 (first 16 hex) at the acceptance base with no
// FAQ/rules stamps: the builder change is head-only, so these bytes must not
// move. Recompute only with a reviewed body change, never to mask one.
const EXPECTED_HONO_MAIN_HASHES: Record<LeafPath, string> = {
  "/about": "ac24c11687046a56",
  "/faq": "bfe0acc87e089896",
  "/rules": "e18de14465347d09",
  "/privacy": "4fec04848edda308",
};

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY_REL = "src/leaf-descriptions.ts";

const HONO_LEAF_FILES = [
  "src/screens/about.tsx",
  "src/screens/faq.tsx",
  "src/screens/rules.tsx",
  "src/screens/privacy.tsx",
  "src/page-shell.tsx",
  "src/static-leaves.tsx",
  "src/seo-leaves.tsx",
];

const KIT_LEAF_FILES = [
  "web/src/routes/about/+page.svelte",
  "web/src/routes/faq/+page.svelte",
  "web/src/routes/rules/+page.svelte",
  "web/src/routes/privacy/+page.svelte",
  "web/src/routes/about/+page.server.ts",
  "web/src/routes/faq/+page.server.ts",
  "web/src/routes/rules/+page.server.ts",
  "web/src/routes/privacy/+page.server.ts",
  "web/src/lib/Shell.svelte",
  "web/src/lib/SiteMetadata.svelte",
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function headOf(html: string): string {
  const match = html.match(/<head>([\s\S]*?)<\/head>/);
  expect(match, "response must carry a <head> section").not.toBeNull();
  return match![1]!;
}

function mainOf(html: string): string {
  const match = html.match(/<main[\s\S]*?<\/main>/);
  expect(match, "response must carry a <main> section").not.toBeNull();
  return match![0]!;
}

function mainHash(main: string): string {
  return createHash("sha256").update(main).digest("hex").slice(0, 16);
}

async function honoLeaf(path: LeafPath): Promise<{ html: string; head: string }> {
  const res = await app.request(path, {}, env);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, head: headOf(html) };
}

// The full leaf head contract: one title, one meta description, one
// self-pointing canonical mirrored by og:url, the OG/Twitter description
// pair with the same escaped copy, the Logo 1 share image, the Markdown
// alternate, and no robots tag (indexable leaves).
function expectLeafHead(head: string, path: LeafPath): void {
  const expected = EXPECTED_LEAF_DESCRIPTIONS[path];
  const escaped = escapeHtml(expected);
  const canonical = canonicalUrl(APP_URL, path);
  const title = EXPECTED_LEAF_TITLES[path];

  expect(head.match(/<title>/g) ?? []).toHaveLength(1);
  expect(head).toContain(`<title>${title}</title>`);

  const meta = head.match(/<meta name="description"[^>]*>/g) ?? [];
  expect(meta, `${path}: exactly one HTML meta description`).toHaveLength(1);
  expect(meta[0]).toContain(`content="${escaped}"`);

  const og = head.match(/<meta property="og:description"[^>]*>/g) ?? [];
  expect(og, `${path}: exactly one og:description`).toHaveLength(1);
  expect(og[0]).toContain(`content="${escaped}"`);

  const twitter = head.match(/<meta name="twitter:description"[^>]*>/g) ?? [];
  expect(twitter, `${path}: exactly one twitter:description`).toHaveLength(1);
  expect(twitter[0]).toContain(`content="${escaped}"`);

  expect(head.match(/rel="canonical"/g) ?? []).toHaveLength(1);
  expect(head).toContain(`<link rel="canonical" href="${canonical}"`);
  expect(head).toContain(`<meta property="og:url" content="${canonical}"`);
  expect(head).toContain(`<meta property="og:title" content="${title}"`);
  expect(head).toContain(`<meta name="twitter:title" content="${title}"`);
  expect(head).toContain('<meta name="twitter:card" content="summary"');
  expect(head).toContain(
    `property="og:image" content="${new URL("/icons/icon-512.png", canonical).href}"`,
  );
  expect(head).toContain('property="og:image:alt" content="Together We Own community logo"');
  expect(head.match(/type="text\/markdown"/g) ?? []).toHaveLength(1);
  expect(head).toContain(`href="${path}.md"`);
  expect(head, `${path}: indexable leaves carry no robots tag`).not.toContain('name="robots"');
  expect(head, `${path}: must not fall back to the generic site text`).not.toContain(
    GENERIC_DESCRIPTION,
  );
}

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally (same shape as the about
// parity harness).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type KitLeafData =
  | ReturnType<typeof aboutPageData>
  | ReturnType<typeof faqPageData>
  | ReturnType<typeof rulesPageData>
  | { html: string; version: number; appUrl: string };

// The real Kit leaf pages, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild: #lib/* resolves through the web
// alias, relative src/* through the worktree. One bundle renders all four
// leaves; each render merges leafCss like its server load does.
async function buildKitLeafBundle(): Promise<{
  renderKitLeaf: (route: LeafPath, data: KitLeafData) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-leaf-desc-"));
  try {
    const entry = join(scratch, "kit-leaf-desc-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import AboutPage from ${JSON.stringify(join(worktree, "web/src/routes/about/+page.svelte"))};
import FaqPage from ${JSON.stringify(join(worktree, "web/src/routes/faq/+page.svelte"))};
import RulesPage from ${JSON.stringify(join(worktree, "web/src/routes/rules/+page.svelte"))};
import PrivacyPage from ${JSON.stringify(join(worktree, "web/src/routes/privacy/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
const PAGES = { "/about": AboutPage, "/faq": FaqPage, "/rules": RulesPage, "/privacy": PrivacyPage };
export function renderKitLeaf(route, data) {
  const { head, body } = render(PAGES[route], { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-leaf-desc.mjs");
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
          name: "kit-leaf-desc-svelte-ssr",
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
    const { renderKitLeaf } = (await import(pathToFileURL(outfile).href)) as {
      renderKitLeaf: (route: LeafPath, data: KitLeafData) => string;
    };
    return { renderKitLeaf };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function kitDataFor(path: LeafPath): KitLeafData {
  if (path === "/about") return aboutPageData(APP_URL);
  if (path === "/faq") return faqPageData(APP_URL, undefined);
  if (path === "/rules") return rulesPageData(APP_URL, undefined);
  return {
    html: renderPolicyMarkdown(POLICY_MARKDOWN),
    version: POLICY_VERSION,
    appUrl: APP_URL,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("leaf-share-description tests must remain local");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("leaf share descriptions: exact shared copy", () => {
  it("defines four distinct short descriptions, none of them the generic site text", () => {
    const values = LEAF_PATHS.map((p) => EXPECTED_LEAF_DESCRIPTIONS[p]);
    expect(new Set(values).size).toBe(4);
    for (const value of values) {
      expect(value.length).toBeGreaterThan(20);
      expect(value.length).toBeLessThan(200);
      expect(value).not.toBe(GENERIC_DESCRIPTION);
    }
  });

  it("keeps the copy true to each page without new legal, privacy or SEO-performance claims", () => {
    expect(EXPECTED_LEAF_DESCRIPTIONS["/about"]).toContain("1998");
    expect(EXPECTED_LEAF_DESCRIPTIONS["/faq"].toLowerCase()).toContain("joining");
    expect(EXPECTED_LEAF_DESCRIPTIONS["/rules"]).toContain("18+ only");
    expect(EXPECTED_LEAF_DESCRIPTIONS["/privacy"].toLowerCase()).toContain("stores");
    const forbidden = [
      "GDPR",
      "guarantee",
      "best",
      "SEO",
      "secure",
      "encrypted",
      "certified",
      "fastest",
    ];
    for (const value of Object.values(EXPECTED_LEAF_DESCRIPTIONS)) {
      for (const word of forbidden) expect(value).not.toContain(word);
      // Whole-word only: the community rank ladder ("ranks") is page truth,
      // a search-ranking promise ("rank") is not.
      expect(value.toLowerCase()).not.toMatch(/\brank\b/);
    }
  });
});

describe("leaf share descriptions: one static authority for both renderers", () => {
  it("ships a single static authority module with the four descriptions", () => {
    const authorityPath = join(root, AUTHORITY_REL);
    expect(
      existsSync(authorityPath),
      `missing behavior: ${AUTHORITY_REL} must export the four leaf descriptions`,
    ).toBe(true);
    const raw = readFileSync(authorityPath, "utf8");
    expect(raw).toContain("LEAF_DESCRIPTIONS");
    for (const path of LEAF_PATHS) {
      expect(raw, `${AUTHORITY_REL} must carry the ${path} copy`).toContain(
        EXPECTED_LEAF_DESCRIPTIONS[path],
      );
    }
    // Pure data like the other leaf content sources: no session, cookie or DB.
    expect(raw).not.toMatch(/dbFor|session|SESSION_STORE|postgres|drizzle|cookies|locals/i);
  });

  it("is imported by the Hono leaf path, never a pasted sentence", () => {
    const hits = HONO_LEAF_FILES.filter((rel) =>
      readFileSync(join(root, rel), "utf8").includes("leaf-descriptions"),
    );
    expect(hits, "Hono leaves must import the shared authority").not.toHaveLength(0);
  });

  it("is imported by the Kit leaf path, never a pasted sentence", () => {
    const hits = KIT_LEAF_FILES.filter((rel) =>
      readFileSync(join(root, rel), "utf8").includes("leaf-descriptions"),
    );
    expect(hits, "Kit leaves must import the shared authority").not.toHaveLength(0);
  });

  it("keeps renderer files free of copied description sentences", () => {
    const offenders: string[] = [];
    for (const rel of [...HONO_LEAF_FILES, ...KIT_LEAF_FILES]) {
      const raw = readFileSync(join(root, rel), "utf8");
      for (const path of LEAF_PATHS) {
        const literal = EXPECTED_LEAF_DESCRIPTIONS[path];
        if (raw.includes(literal) || raw.includes(escapeHtml(literal)))
          offenders.push(`${rel} (${path})`);
      }
    }
    expect(offenders, "descriptions live once in the authority, not in renderers").toEqual([]);
  });
});

describe("leaf share descriptions: Hono head matrix (real routes)", () => {
  it.each(LEAF_PATHS)("%s emits its own meta, og and twitter descriptions", async (path) => {
    const { head } = await honoLeaf(path);
    expectLeafHead(head, path);
  });

  it("escapes the rules ampersand in real Hono output", async () => {
    const { head } = await honoLeaf("/rules");
    expect(head).toContain("Play fair &amp; Moderators have the last word");
    expect(head).not.toContain("Play fair & Moderators have the last word");
  });
});

describe("leaf share descriptions: Kit head matrix (real SSR)", () => {
  let renderKitLeaf: (route: LeafPath, data: KitLeafData) => string;

  beforeAll(async () => {
    ({ renderKitLeaf } = await buildKitLeafBundle());
  }, 120_000);

  it.each(LEAF_PATHS)("%s emits its own meta, og and twitter descriptions", async (path) => {
    const html = renderKitLeaf(path, kitDataFor(path));
    expectLeafHead(headOf(html), path);
  });

  it("escapes the rules ampersand in real Kit output", async () => {
    const html = renderKitLeaf("/rules", kitDataFor("/rules"));
    expect(headOf(html)).toContain("Play fair &amp; Moderators have the last word");
  });
});

describe("leaf share descriptions: preservation pins", () => {
  it("keeps the Hono body bytes unchanged (head-only change)", async () => {
    for (const path of LEAF_PATHS) {
      const { html } = await honoLeaf(path);
      expect(mainHash(mainOf(html)), `${path}: body must not move`).toBe(
        EXPECTED_HONO_MAIN_HASHES[path],
      );
      expect(mainOf(html), `${path}: descriptions live in <head>, not <main>`).not.toContain(
        EXPECTED_LEAF_DESCRIPTIONS[path],
      );
    }
  });

  it("keeps the public cache contract and sets no cookies on the leaves", async () => {
    for (const path of LEAF_PATHS) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
  });

  it("CONTROL: leaves keep their route ownership (no flag or rollout change)", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/about",
      enabled: true,
      reads: "public",
    });
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/faq",
      enabled: true,
      reads: "public",
    });
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/rules",
      enabled: false,
      reads: "public",
    });
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/privacy",
      enabled: false,
      reads: "public",
    });
    expect(resolveRouteOwner({ method: "GET", path: "/about" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/faq" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/rules" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/privacy" })).toBe("hono");
  });

  it("CONTROL: Layout keeps the generic default when no description is supplied", async () => {
    const html = headOf(
      await jsx(Layout, { title: "Default page", canonical: APP_URL }).toString(),
    );
    expect(html.match(/<meta name="description"[^>]*>/g)).toHaveLength(1);
    expect(html).toContain(`<meta name="description" content="${GENERIC_DESCRIPTION}"/>`);
    expect(html).not.toContain('property="og:description"');
    expect(html).not.toContain('name="twitter:description"');
  });

  it("CONTROL: the branded 404 still carries no share tags", async () => {
    const res = await app.request("/nx-9x7q2-zzz", {}, env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("og:");
    expect(html).not.toContain("twitter:");
  });
});
