// route-inventory: GET /rules
// Kit parity slice.
// The Kit house-rules page (web/src/routes/rules/) renders the same content
// contract as the Hono leaf (src/screens/rules.tsx): the five rules from the
// shared source (src/rules-content.ts), the valid stamp shown, an invalid or
// missing date hidden, and the exact public URL/canonical/cache contract with
// no session or database behavior.
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
import { RULES, rulesPageData } from "../src/rules-content";
import { RULES as screenRules } from "../src/screens/rules";
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

// Valid, invalid and missing date fixtures: the acceptance net for the stamp.
const FIXTURES = [
  { name: "valid", raw: "2026-09-01", iso: "2026-09-01", label: "1 September 2026" },
  { name: "invalid", raw: "someday", iso: null, label: null },
  { name: "empty", raw: "", iso: null, label: null },
  { name: "missing", raw: undefined, iso: null, label: null },
] as const;

const RULE_NAMES = [
  "18+ only",
  "Respect the room",
  "Voice-first",
  "Play fair",
  "Moderators have the last word",
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
async function buildKitRulesBundle(): Promise<{
  renderPage: (data: ReturnType<typeof rulesPageData>) => string;
  applicationModules: string[];
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-rules-"));
  try {
    const entry = join(scratch, "kit-rules-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/rules/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
export function renderPage(data) {
  // Mirror the server load, which merges leafCss into the page data.
  const { head, body } = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-rules.mjs");
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
          name: "kit-rules-svelte-ssr",
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
      renderPage: (data: ReturnType<typeof rulesPageData>) => string;
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
  const match = html.match(/<section[^>]*aria-labelledby="rules-heading"[\s\S]*?<\/section>/);
  if (!match) throw new Error("rules content section is missing");
  return normalizeSection(match[0].replace(/<!---->/g, ""));
}

async function honoRules(raw: string | undefined) {
  const bindings = raw === undefined ? env : { ...env, RULES_LAST_UPDATED: raw };
  const res = await app.request("/rules", {}, bindings);
  return { res, html: await res.text() };
}

describe("rules manifest ownership", () => {
  it("ships the native rules route disabled as public reads", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/rules",
      enabled: false,
      reads: "public",
    });
  });

  it("keeps /rules on Hono until enablement flips the manifest", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/rules" })).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: "/rules" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/rules" })).toBe("hono");
    expect(
      resolveRouteOwner({ method: "GET", path: "/rules" }, [
        { method: "GET", path: "/rules", enabled: true, reads: "public" },
      ]),
    ).toBe("kit");
  });
});

describe("rules shared content source", () => {
  it("serves the same five rules to Hono, Markdown and Kit", () => {
    expect(screenRules).toBe(RULES);
    expect(RULES.map(([name]) => name)).toEqual(RULE_NAMES);
  });

  it.each(FIXTURES)("maps the $name fixture to its stamp", (fixture) => {
    const data = rulesPageData(APP_URL, fixture.raw);
    expect(data.appUrl).toBe(APP_URL);
    expect(data.rules).toBe(RULES);
    expect(data.lastUpdated).toEqual(
      fixture.iso === null ? null : { iso: fixture.iso, label: fixture.label },
    );
  });
});

describe("Hono /rules contract per date fixture", () => {
  it.each(FIXTURES)(
    "answers 200 with the public cache contract and no session surface ($name)",
    async (fixture) => {
      const { res, html } = await honoRules(fixture.raw);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(html).toContain('data-testid="rules-list"');
      expect(html).toContain('data-testid="rules-join"');
      expect(html).toContain(
        '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
      );
      if (fixture.iso === null) {
        expect(html).not.toContain("rules-last-updated");
      } else {
        expect(html).toContain('data-testid="rules-last-updated"');
        expect(html).toContain(`<time datetime="${fixture.iso}">${fixture.label}</time>`);
      }
    },
  );
});

describe("Kit /rules parity with Hono", () => {
  let renderPage: (data: ReturnType<typeof rulesPageData>) => string;
  let applicationModules: string[];

  beforeAll(async () => {
    ({ renderPage, applicationModules } = await buildKitRulesBundle());
  }, 60_000);

  it("bundles no database or session modules", () => {
    const forbidden = applicationModules.filter((module) =>
      /(?:^|[\\/])(?:db|database|session)(?:[\\/.]|$)/i.test(module),
    );
    expect(forbidden).toEqual([]);
  });

  it.each(FIXTURES)("renders the identical content section ($name)", async (fixture) => {
    const data = rulesPageData(APP_URL, fixture.raw);
    const kitHtml = renderPage(data);
    const { html: honoHtml } = await honoRules(fixture.raw);
    expect(contentSectionOf(kitHtml)).toBe(contentSectionOf(honoHtml));
  });

  it.each(FIXTURES)("keeps the semantic and a11y contract ($name)", (fixture) => {
    const html = renderPage(rulesPageData(APP_URL, fixture.raw));
    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('aria-label="Primary"');
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl(APP_URL, "/rules")}"`);
    expect(html).toContain('<h1 id="rules-heading">House rules</h1>');
    for (const name of RULE_NAMES) expect(html).toContain(name);
    expect(html.match(/<li class="card">/g)).toHaveLength(5);
    expect(html).toContain('data-testid="rules-join"');
    expect(html).toContain('href="/join"');
    // Community-information nav: exactly the House-rules link is current.
    expect(html).toContain('aria-label="Community information"');
    expect(html).toContain('<a href="/rules" aria-current="page">House rules</a>');
    expect(html).not.toContain('href="/about" aria-current');
    expect(html).not.toContain('href="/faq" aria-current');
    expect(html).not.toContain('href="/privacy" aria-current');
    // Header join action matches the Hono leaf's joinAction chrome byte for
    // byte for every visitor, without a session read.
    expect(html).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(html).not.toContain("Sign out");
    if (fixture.iso === null) {
      expect(html).not.toContain("rules-last-updated");
    } else {
      expect(html).toContain(`<time datetime="${fixture.iso}">${fixture.label}</time>`);
    }
  });

  it("keeps the markdown-alternate discovery both renderers share", async () => {
    // The Hono leaf always emits /rules.md via the Leaf chrome (page-shell);
    // the Kit page must too, or enabling it regresses machine discovery.
    // Attribute-wise: Svelte SSR owns void-element serialization, not us.
    const kit = renderPage(rulesPageData(APP_URL, "2026-09-01"));
    for (const token of ['rel="alternate"', 'type="text/markdown"', 'href="/rules.md"']) {
      expect(kit).toContain(token);
    }
    const { html: honoHtml } = await honoRules("2026-09-01");
    for (const token of ['rel="alternate"', 'href="/rules.md"']) {
      expect(honoHtml).toContain(token);
    }
  });

  it("renders no scripts and no secret-shaped content (no-JS page)", () => {
    const html = renderPage(rulesPageData(APP_URL, "2026-09-01"));
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/__Host-two_session\s*=/);
    expect(html).not.toMatch(/DISCORD_BOT_TOKEN/i);
  });

  it("pins the server load contract at the source level", () => {
    const raw = readFileSync(
      new URL("../web/src/routes/rules/+page.server.ts", import.meta.url),
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
    // The stamp is the only config-driven behavior: dropping RULES_LAST_UPDATED
    // (or APP_URL) must fail this pin rather than silently hide the date.
    expect(code).toMatch(/rulesPageData\(env\.APP_URL,\s*env\.RULES_LAST_UPDATED\)/);
  });
});
