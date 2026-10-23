// route-inventory: GET /faq
// Acceptance: FAQ shows when answers were last reviewed, on both twins.
// The Hono leaf (src/screens/faq.tsx) and the Kit page
// (web/src/routes/faq/) render a validated "Last reviewed <date>" stamp
// from config, mirroring the /rules invalid-hides behavior
// (src/rules-last-updated.ts): a valid YYYY-MM-DD renders the stamp with
// machine-readable time, while a missing/empty value hides it silently
// and a malformed/impossible date warns and hides it — never a wrong date.
// The question list, order, anchors, strap, lead and join CTA stay unchanged,
// and the page stays a DB-free, session-free, no-JS static leaf.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import { FAQS, faqPageData } from "../src/faq-content";
import { FAQS as screenFaqs } from "../src/screens/faq";
import { canonicalUrl } from "../src/seo";
import app from "./app";
import type { Env } from "../src/env";
import postgres from "postgres";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("faq must not connect to a database");
  }),
}));

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

// The configured review date. Optional, YYYY-MM-DD, mirroring
// RULES_LAST_UPDATED: unset/empty hides silently, malformed warns and hides.
const FAQ_ENV_KEY = "FAQ_LAST_REVIEWED";
const WARNING = "Invalid community.faq_last_reviewed — hiding /faq stamp";

type Stamp = { iso: string; label: string } | null;
type Fixture = {
  name: string;
  raw: string | undefined;
  iso: string | null;
  label: string | null;
  shouldWarn: boolean;
};

// Valid, missing, malformed and leap-edge dates: the acceptance net.
const FIXTURES: Fixture[] = [
  {
    name: "valid",
    raw: "2026-09-01",
    iso: "2026-09-01",
    label: "1 September 2026",
    shouldWarn: false,
  },
  {
    name: "trimmed",
    raw: " 2026-09-01 ",
    iso: "2026-09-01",
    label: "1 September 2026",
    shouldWarn: false,
  },
  {
    name: "leap-valid",
    raw: "2024-02-29",
    iso: "2024-02-29",
    label: "29 February 2024",
    shouldWarn: false,
  },
  {
    name: "century-leap-valid",
    raw: "2000-02-29",
    iso: "2000-02-29",
    label: "29 February 2000",
    shouldWarn: false,
  },
  { name: "missing", raw: undefined, iso: null, label: null, shouldWarn: false },
  { name: "empty", raw: "", iso: null, label: null, shouldWarn: false },
  { name: "whitespace", raw: " \t\n ", iso: null, label: null, shouldWarn: false },
  { name: "malformed-word", raw: "someday", iso: null, label: null, shouldWarn: true },
  { name: "bad-shape-time", raw: "2026-09-01T00:00:00Z", iso: null, label: null, shouldWarn: true },
  { name: "bad-month", raw: "2026-13-01", iso: null, label: null, shouldWarn: true },
  { name: "impossible-feb30", raw: "2026-02-30", iso: null, label: null, shouldWarn: true },
  { name: "non-leap-feb29", raw: "2026-02-29", iso: null, label: null, shouldWarn: true },
  { name: "century-non-leap", raw: "1900-02-29", iso: null, label: null, shouldWarn: true },
  { name: "month-short", raw: "2026-04-31", iso: null, label: null, shouldWarn: true },
];

const SECTION_IDS = [
  "faq-getting-in",
  "faq-first-week",
  "faq-ranks",
  "faq-events",
  "faq-onboarding",
  "faq-tickets",
  "faq-profile",
  "faq-privacy",
];
const QUESTIONS = FAQS.flatMap((group) => group.items.map(([question]) => question));
const QUESTION_COUNT = 18;
const JOIN_CHROME =
  '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>';

// The Kit page data shape after the build: app URL, shared questions, and the
// validated stamp (null hides). Before the build faqPageData takes only the
// app URL and returns no stamp, so the mapping tests RED on valid dates.
type FaqDataWithStamp = { appUrl: string; faqs: typeof FAQS; lastReviewed?: Stamp };

function faqData(raw: string | undefined): FaqDataWithStamp {
  const fn = faqPageData as unknown as (
    appUrl: string,
    raw?: string | undefined,
  ) => FaqDataWithStamp;
  return fn(APP_URL, raw);
}

function bindingsFor(raw: string | undefined): Env {
  if (raw === undefined) return env;
  return { ...env, [FAQ_ENV_KEY]: raw } as unknown as Env;
}

async function honoFaq(raw: string | undefined) {
  const res = await app.request("/faq", {}, bindingsFor(raw));
  return { res, html: await res.text() };
}

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
  renderPage: (data: FaqDataWithStamp) => string;
  applicationModules: string[];
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-faq-review-"));
  try {
    const entry = join(scratch, "kit-faq-review-entry.mjs");
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
    const outfile = join(scratch, "kit-faq-review.mjs");
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
          name: "kit-faq-review-svelte-ssr",
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
      renderPage: (data: FaqDataWithStamp) => string;
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

function expectStamp(html: string, iso: string, label: string): void {
  expect(html).toContain('data-testid="faq-last-reviewed"');
  expect(html).toContain(`Last reviewed <time datetime="${iso}">${label}</time>`);
  // The stamp sits after the lead and before the list, mirroring /rules.
  const lead = html.indexOf('<p class="lead">');
  const stamp = html.indexOf('data-testid="faq-last-reviewed"');
  const list = html.indexOf('data-testid="faq-list"');
  expect(lead).toBeGreaterThanOrEqual(0);
  expect(stamp).toBeGreaterThan(lead);
  expect(list).toBeGreaterThan(stamp);
}

function expectNoStamp(html: string): void {
  expect(html).not.toContain("faq-last-reviewed");
  expect(html).not.toContain("Last reviewed");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("faq shared content source stays unchanged", () => {
  it("serves the same question groups to Hono, Markdown and Kit", () => {
    expect(screenFaqs).toBe(FAQS);
    expect(FAQS.map((group) => group.sectionId)).toEqual(SECTION_IDS);
    expect(QUESTIONS).toHaveLength(QUESTION_COUNT);
    expect(QUESTIONS).toContain("How do I join?");
  });

  it("passes the app URL and the shared questions to the Kit page", () => {
    const data = faqPageData(APP_URL);
    expect(data.appUrl).toBe(APP_URL);
    expect(data.faqs).toBe(FAQS);
  });
});

describe("faqPageData maps the review date to its stamp", () => {
  it.each(FIXTURES)("maps the $name fixture to its stamp", (fixture) => {
    const data = faqData(fixture.raw);
    expect(data.appUrl).toBe(APP_URL);
    expect(data.faqs).toBe(FAQS);
    expect(data.lastReviewed ?? null).toEqual(
      fixture.iso === null ? null : { iso: fixture.iso, label: fixture.label },
    );
    if (fixture.shouldWarn) {
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(WARNING);
    } else {
      expect(console.warn).not.toHaveBeenCalled();
    }
  });
});

describe("Hono /faq contract per review-date fixture", () => {
  it.each(FIXTURES)(
    "answers 200 with the public cache contract and no session surface ($name)",
    async (fixture) => {
      const { res, html } = await honoFaq(fixture.raw);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(html).toContain('data-testid="faq-list"');
      expect(html).toContain('data-testid="faq-join"');
      expect(html).toContain(JOIN_CHROME);
      expect(html).toContain("How do I join?");
      // Unchanged copy, order, anchors and join CTA on every fixture.
      // Hono escapes quotes in text while the source holds them bare, so
      // decode before comparing — the contract is the text, not the escaping.
      const decoded = html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
      for (const id of SECTION_IDS) expect(html).toContain(`id="${id}"`);
      for (const question of QUESTIONS) expect(decoded).toContain(question);
      expect(html).toContain('<p class="strap">New here? Start here</p>');
      if (fixture.iso === null) {
        expectNoStamp(html);
      } else {
        expectStamp(html, fixture.iso, fixture.label as string);
      }
      if (fixture.shouldWarn) {
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(WARNING);
      } else {
        expect(console.warn).not.toHaveBeenCalled();
      }
    },
  );
});

describe("DB-free faq route review stamp", () => {
  it.each([
    FIXTURES[0] as Fixture,
    FIXTURES[4] as Fixture,
    FIXTURES[7] as Fixture,
    FIXTURES[2] as Fixture,
  ])("stays 200 without dependencies for $name", async (fixture) => {
    const fetch = vi.fn(() => {
      throw new Error("faq must not fetch dependencies");
    });
    vi.stubGlobal("fetch", fetch);
    const SESSION_STORE = new Proxy(
      {},
      {
        get: () => {
          throw new Error("faq must not read sessions");
        },
      },
    );
    const res = await app.request("/faq", { headers: { cookie: "__Host-two_session=forged" } }, {
      ...(bindingsFor(fixture.raw) as unknown as Record<string, unknown>),
      SESSION_STORE,
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).toContain('data-testid="faq-list"');
    expect(html).toContain('data-testid="faq-join"');
    if (fixture.iso === null) {
      expectNoStamp(html);
    } else {
      expectStamp(html, fixture.iso, fixture.label as string);
    }
    expect(postgres).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    if (fixture.shouldWarn) {
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(WARNING);
    } else {
      expect(console.warn).not.toHaveBeenCalled();
    }
  });
});

describe("Kit /faq parity with Hono per review-date fixture", () => {
  let renderPage: (data: FaqDataWithStamp) => string;
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

  it.each(FIXTURES)("renders the identical question list ($name)", async (fixture) => {
    const kitHtml = renderPage(faqData(fixture.raw));
    const { html: honoHtml } = await honoFaq(fixture.raw);
    expect(faqListOf(kitHtml)).toBe(faqListOf(honoHtml));
  });

  it.each(FIXTURES)("keeps the semantic and stamp contract ($name)", (fixture) => {
    const html = renderPage(faqData(fixture.raw));
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
    expect(html).toContain('aria-label="Community information"');
    expect(html).toContain('<a href="/faq" aria-current="page">FAQ</a>');
    expect(html).not.toContain('href="/about" aria-current');
    expect(html).not.toContain('href="/rules" aria-current');
    expect(html).not.toContain('href="/privacy" aria-current');
    expect(html).toContain(JOIN_CHROME);
    expect(html).not.toContain("Sign out");
    if (fixture.iso === null) {
      expectNoStamp(html);
    } else {
      expectStamp(html, fixture.iso, fixture.label as string);
    }
  });

  it("keeps the markdown-alternate discovery both renderers share", async () => {
    const kit = renderPage(faqData("2026-09-01"));
    for (const token of ['rel="alternate"', 'type="text/markdown"', 'href="/faq.md"']) {
      expect(kit).toContain(token);
    }
    const { html: honoHtml } = await honoFaq("2026-09-01");
    for (const token of ['rel="alternate"', 'href="/faq.md"']) {
      expect(honoHtml).toContain(token);
    }
  });

  it("renders no scripts and no secret-shaped content (no-JS page)", () => {
    const html = renderPage(faqData("2026-09-01"));
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/__Host-two_session\s*=/);
    expect(html).not.toMatch(/DISCORD_BOT_TOKEN/i);
    // The stamp is static HTML: present in the raw SSR body, no island.
    expect(html).toContain('data-testid="faq-last-reviewed"');
  });

  it("pins the server load contract at the source level", () => {
    const raw = readFileSync(
      new URL("../web/src/routes/faq/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(raw).toContain("export const csr = false");
    expect(raw).toContain('"public, max-age=3600"');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/dbFor|session|SESSION_STORE|postgres|drizzle|cookies|locals|parent/i);
    expect(code).toMatch(/async \(\{\s*setHeaders\s*\}\)/);
    expect(code).toContain("leafCss: LEAF_CRITICAL_CSS");
    // The stamp is config-driven: dropping FAQ_LAST_REVIEWED (or APP_URL)
    // must fail this pin rather than silently hide the date.
    expect(code).toMatch(/faqPageData\(env\.APP_URL,\s*env\.FAQ_LAST_REVIEWED\)/);
  });
});
