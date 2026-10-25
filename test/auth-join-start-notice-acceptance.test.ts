/// <reference types="vite/client" />
// route-inventory: GET /join
// Acceptance: Kit /join renders the start-failed notice banner.
//
// Failing-first contract for the sibling build: Hono /join already renders
// `?notice=start-failed` as a visible `join-start-notice` banner (exact-match
// allowlist, hostile values leave no trace); Kit /join must allowlist the same
// value and render the same banner bytes. Hono bytes are the reference and
// must not change.
//
// OWNERSHIP: this file is acceptance-owned. The builder builds on this branch
// and must never edit this file; implement in the Kit load and page until it
// is green.
//
// Pinned testids (the builder implements exactly these):
// - `join-start-notice`: the banner for ?notice=start-failed, copy
//   "The Discord approval failed to start — try again below.", role=status.
// - `join-oneclick`: the one-click retry link, which never carries ?notice=.
//
// Hermetic: mounted Hono app with no database, real Kit load bundled with a
// stubbed Worker env, real Kit page compiled and SSR-rendered with fake load
// data. No database, no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";
import { JOIN_START_FAILED_NOTICE } from "../src/join/route-shared";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/invite";
const GUILD = "326474832151838730";
const WIDGET_URL = `https://discord.com/widget?id=${GUILD}&theme=dark`;

// Hono reference bytes (src/screens/join.tsx:48-52, verified via app.request
// on the unmodified tree): the exact outer HTML the Kit banner must match
// after whitespace normalization.
const HONO_BANNER_BYTES =
  '<p class="notice" role="status" data-testid="join-start-notice">The Discord approval failed to start — try again below.</p>';
const HONO_BANNER_COPY = "The Discord approval failed to start — try again below.";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

const BANNER_RE = /<p\b[^>]*data-testid="join-start-notice"[^>]*>([\s\S]*?)<\/p>/;
const BANNER_ALL = /<p\b[^>]*data-testid="join-start-notice"[^>]*>([\s\S]*?)<\/p>/g;

function bannerOuter(html: string): string | null {
  return html.match(BANNER_RE)?.[0] ?? null;
}

function bannerCount(html: string): number {
  return [...html.matchAll(BANNER_ALL)].length;
}

function normalizeBanner(bytes: string): string {
  return bytes.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

function oneClickHref(html: string): string {
  const tag = html.match(/<a[^>]*data-testid="join-oneclick"[^>]*>/)?.[0];
  expect(tag).not.toBeUndefined();
  const href = tag!.match(/href="([^"]*)"/)?.[1];
  expect(href).not.toBeUndefined();
  return href!.replace(/&amp;/g, "&");
}

// Hostile/mistyped values: every one must render the plain page (no banner,
// no trace, byte-identical to /join). The encoded "&next=/evil" case pins that
// a smuggled parameter inside the notice value is not split out.
const HOSTILE_NOTICES = [
  "bogus",
  "START-FAILED",
  "Start-Failed",
  "start-failed ",
  " start-failed",
  "start_failed",
  "start-failed&next=/evil",
  "<script>alert(1)</script>",
  "null",
  "undefined",
] as const;

describe("acceptance: Hono /join banner reference (GREEN controls)", () => {
  it("renders the exact banner bytes for ?notice=start-failed", async () => {
    expect(JOIN_START_FAILED_NOTICE).toBe("start-failed");
    const res = await app.request("/join?notice=start-failed", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bannerCount(html)).toBe(1);
    expect(bannerOuter(html)).toBe(HONO_BANNER_BYTES);
    expect(html).toContain(HONO_BANNER_COPY);
  });

  it("places the banner inside <main> before the join layout", async () => {
    const html = await (await app.request("/join?notice=start-failed", {}, env)).text();
    const main = html.indexOf('<main id="main"');
    const banner = html.indexOf('data-testid="join-start-notice"');
    const layout = html.indexOf('class="join-layout"');
    expect(main).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(main);
    expect(layout).toBeGreaterThan(banner);
  });

  it("keeps ?notice= display-only: the one-click href never carries it", async () => {
    const html = await (await app.request("/join?notice=start-failed", {}, env)).text();
    const href = oneClickHref(html);
    expect(href).toBe("/join/discord");
    expect(href).not.toContain("notice");
    expect(href).not.toContain("start-failed");
  });

  it("renders the plain page with no trace when ?notice= is absent", async () => {
    const html = await (await app.request("/join", {}, env)).text();
    expect(html).not.toContain('data-testid="join-start-notice"');
    expect(html).not.toContain("failed to start");
    expect(html).not.toContain("start-failed");
  });

  it.each([...HOSTILE_NOTICES])(
    "ignores a non-allowlisted notice %s (plain, byte-identical, no echo)",
    async (hostile) => {
      const plain = await (await app.request("/join", {}, env)).text();
      const res = await app.request(`/join?notice=${encodeURIComponent(hostile)}`, {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('data-testid="join-start-notice"');
      expect(html).not.toContain("failed to start");
      expect(html).not.toContain("alert(1)");
      expect(html).toBe(plain);
    },
  );

  it("ignores an empty ?notice= (plain page)", async () => {
    const plain = await (await app.request("/join", {}, env)).text();
    const html = await (await app.request("/join?notice=", {}, env)).text();
    expect(html).not.toContain('data-testid="join-start-notice"');
    expect(html).toBe(plain);
  });

  it("keeps cache parity: notice vs plain share cache-control and Vary", async () => {
    const noticed = await app.request("/join?notice=start-failed", {}, env);
    const plain = await app.request("/join", {}, env);
    const hostile = await app.request("/join?notice=bogus", {}, env);
    expect(noticed.headers.get("cache-control")).toBe(plain.headers.get("cache-control"));
    expect(hostile.headers.get("cache-control")).toBe(plain.headers.get("cache-control"));
    expect(noticed.headers.get("vary")).toBe("Cookie");
    expect(plain.headers.get("vary")).toBe("Cookie");
    // No flash in these requests, so the shared-cache TTL holds (60 s with a
    // warmed presence snapshot, 3600 s cold); a viewer-specific answer here
    // would be a cache regression.
    expect(plain.headers.get("cache-control")).toMatch(/^public, max-age=(60|3600)$/);
  });
});

// Kit load: the real +page.server.ts with only the Worker env stubbed (the
// same harness as test/join-public-snapshot.test.ts).
const LOAD_ENV_KEY = "__kitJoinNoticeAcceptanceEnv";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const joinLoadPath = join(root, "web/src/routes/join/+page.server.ts");

type KitJoinLoadArgs = {
  url: URL;
  request: Request;
  cookies: { delete: (name: string, options: Record<string, unknown>) => void };
  setHeaders: (headers: Record<string, string>) => void;
};

type KitJoinLoadData = {
  inviteUrl: string;
  widgetUrl: string | null;
  widgetSnapshot: Record<string, unknown> | null;
  oneClickHref: string;
  appUrl: string;
  joinResult: unknown;
  // Present after the build; absent (undefined) on the unmodified tree.
  notice?: string | null;
  [key: string]: unknown;
};

type KitJoinLoad = (args: KitJoinLoadArgs) => Promise<KitJoinLoadData>;

let kitLoad: KitJoinLoad;
let loadScratch = "";

beforeAll(async () => {
  (globalThis as Record<string, unknown>)[LOAD_ENV_KEY] = {
    env: { ...env },
    pending: [] as Promise<unknown>[],
    waitUntil: () => {},
  };
  loadScratch = mkdtempSync(join(tmpdir(), "kit-join-notice-acceptance-load-"));
  const outfile = join(loadScratch, "kit-join-notice-load-bundle.mjs");
  await build({
    stdin: {
      contents: `export { load } from ${JSON.stringify(joinLoadPath)};\n`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    plugins: [
      {
        name: "kit-join-notice-acceptance-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "kit-join-notice-acceptance-env",
            namespace: "kit-join-notice-acceptance",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-join-notice-acceptance" }, () => ({
            contents: [
              `export const env = globalThis[${JSON.stringify(LOAD_ENV_KEY)}].env;`,
              `export const waitUntil = globalThis[${JSON.stringify(LOAD_ENV_KEY)}].waitUntil;`,
              ``,
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    load: KitJoinLoad;
  };
  kitLoad = mod.load;
}, 60000);

afterAll(() => {
  if (loadScratch) rmSync(loadScratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[LOAD_ENV_KEY];
});

async function loadJoin(url: string): Promise<{
  data: KitJoinLoadData;
  headers: Record<string, string>;
}> {
  const headers: Record<string, string> = {};
  const data = await kitLoad({
    url: new URL(url, APP_URL),
    request: new Request(new URL(url, APP_URL), { method: "GET" }),
    cookies: { delete: () => {} },
    setHeaders: (values) => Object.assign(headers, values),
  });
  return { data, headers };
}

describe("acceptance: Kit /join load allowlists ?notice= (RED for exact)", () => {
  it("RED: ?notice=start-failed returns notice=start-failed", async () => {
    const { data } = await loadJoin("/join?notice=start-failed");
    expect(data.notice ?? null).toBe("start-failed");
  });

  it("absent ?notice= returns no notice (GREEN preserved)", async () => {
    const { data } = await loadJoin("/join");
    expect(data.notice ?? null).toBeNull();
  });

  it.each([...HOSTILE_NOTICES])("hostile ?notice=%s returns no notice (GREEN)", async (hostile) => {
    const { data } = await loadJoin(`/join?notice=${encodeURIComponent(hostile)}`);
    expect(data.notice ?? null).toBeNull();
    // The hostile value never rides the load data (no echo into __data.json).
    // Quoted comparison: legitimate JSON nulls contain `null` unquoted, while
    // an echoed hostile would appear as a quoted string.
    expect(JSON.stringify(data)).not.toContain(JSON.stringify(hostile));
  });

  it("empty ?notice= returns no notice (GREEN)", async () => {
    const { data } = await loadJoin("/join?notice=");
    expect(data.notice ?? null).toBeNull();
  });

  it("keeps ?notice= display-only: the one-click href never carries it (GREEN)", async () => {
    const { data } = await loadJoin("/join?notice=start-failed");
    expect(data.oneClickHref).toBe("/join/discord");
    expect(data.oneClickHref).not.toContain("notice");
  });

  it("keeps cache parity: notice vs plain share cache-control and Vary (GREEN)", async () => {
    const noticed = await loadJoin("/join?notice=start-failed");
    const plain = await loadJoin("/join");
    expect(noticed.headers["cache-control"]).toBe(plain.headers["cache-control"]);
    expect(plain.headers["vary"]).toBe("Cookie");
    expect(plain.headers["cache-control"]).toMatch(/^public, max-age=(60|3600)$/);
  });
});

// Kit SSR: the real join +page.svelte, compiled and rendered with fake load
// data (the same harness as test/kit-home-render.test.ts).
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderJoin = (data: Record<string, unknown>) => string;

let renderKitJoin: RenderJoin;
let ssrScratch = "";

function joinBaseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inviteUrl: INVITE_URL,
    widgetUrl: null,
    widgetSnapshot: null,
    oneClickHref: "/join/discord",
    appUrl: APP_URL,
    joinResult: null,
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    notice: null,
    ...overrides,
  };
}

beforeAll(async () => {
  ssrScratch = mkdtempSync(join(tmpdir(), "kit-join-notice-acceptance-ssr-"));
  const entry = join(ssrScratch, "kit-join-notice-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/join/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(ssrScratch, "kit-join-notice-bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-join-notice-acceptance-svelte-ssr",
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
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    renderPage: RenderJoin;
  };
  renderKitJoin = mod.renderPage;
}, 60000);

afterAll(() => {
  if (ssrScratch) rmSync(ssrScratch, { recursive: true, force: true });
});

describe("acceptance: Kit /join renders the banner (RED for exact)", () => {
  it("RED: notice=start-failed renders one banner with the Hono copy", () => {
    const html = renderKitJoin(joinBaseData({ notice: "start-failed" }));
    expect(bannerCount(html)).toBe(1);
    expect(html).toContain(HONO_BANNER_COPY);
    const kit = bannerOuter(html);
    expect(kit).not.toBeNull();
    expect(kit).toContain('data-testid="join-start-notice"');
    expect(kit).toContain('role="status"');
  });

  it("RED: Kit banner bytes match the Hono reference (whitespace-normalized)", () => {
    const html = renderKitJoin(joinBaseData({ notice: "start-failed" }));
    const kit = bannerOuter(html);
    expect(kit).not.toBeNull();
    expect(normalizeBanner(kit!)).toBe(normalizeBanner(HONO_BANNER_BYTES));
  });

  it("RED: the banner sits inside <main> before the join layout", () => {
    const html = renderKitJoin(joinBaseData({ notice: "start-failed" }));
    const main = html.indexOf("<main");
    const banner = html.indexOf('data-testid="join-start-notice"');
    const layout = html.indexOf("join-layout");
    expect(main).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(main);
    expect(layout).toBeGreaterThan(banner);
  });

  it("plain notice=null renders no banner and no trace (GREEN)", () => {
    const html = renderKitJoin(joinBaseData({ notice: null }));
    expect(html).not.toContain('data-testid="join-start-notice"');
    expect(html).not.toContain("failed to start");
    expect(html).not.toContain("start-failed");
  });

  it("RED (integration): load ?notice=start-failed then render shows the banner", async () => {
    const { data } = await loadJoin("/join?notice=start-failed");
    const html = renderKitJoin({ ...joinBaseData(), ...data });
    expect(bannerCount(html)).toBe(1);
    expect(html).toContain(HONO_BANNER_COPY);
  });

  it.each([...HOSTILE_NOTICES])(
    "integration: load ?notice=%s then render shows no banner (GREEN)",
    async (hostile) => {
      const { data } = await loadJoin(`/join?notice=${encodeURIComponent(hostile)}`);
      const html = renderKitJoin({ ...joinBaseData(), ...data });
      expect(html).not.toContain('data-testid="join-start-notice"');
      expect(html).not.toContain("failed to start");
    },
  );
});

describe("acceptance: /join cache parity across renderers (GREEN)", () => {
  it("Hono and Kit agree: notice and plain share the same cache answer", async () => {
    const honoNoticed = await app.request("/join?notice=start-failed", {}, env);
    const honoPlain = await app.request("/join", {}, env);
    const kitNoticed = await loadJoin("/join?notice=start-failed");
    const kitPlain = await loadJoin("/join");
    expect(honoNoticed.headers.get("cache-control")).toBe(honoPlain.headers.get("cache-control"));
    expect(kitNoticed.headers["cache-control"]).toBe(kitPlain.headers["cache-control"]);
    // Both renderers serve the same shared-cache TTL for the flash-free leaf
    // (cold 3600 s here; a warmed presence snapshot would be 60 s on both).
    expect(kitPlain.headers["cache-control"]).toBe(honoPlain.headers.get("cache-control"));
    expect(kitPlain.headers["vary"]).toBe("Cookie");
  });
});

describe("acceptance: /join no-JS contract (GREEN pins)", () => {
  it("Kit join stays server-rendered (GREEN)", () => {
    const load = readFileSync(
      new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(load).toContain("export const csr = false");
  });

  it("Hono banner is in the raw fetch body (no JS needed, GREEN)", async () => {
    const html = await (await app.request("/join?notice=start-failed", {}, env)).text();
    expect(bannerCount(html)).toBe(1);
    // The only script is the click-to-load widget facade (defer, no inline
    // bootstrap, no hydration): the banner and the one-click link work with
    // scripts disabled.
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    for (const tag of scripts) {
      expect(tag).toContain("/islands/join-widget.js");
      expect(tag).toContain("defer");
    }
    expect(oneClickHref(html)).toBe("/join/discord");
  });

  it("Kit SSR carries no scripts without a widget, only the facade with one (GREEN)", () => {
    const bare = renderKitJoin(joinBaseData({ widgetUrl: null, widgetSnapshot: null }));
    expect(bare).not.toContain("<script");
    const withWidget = renderKitJoin(joinBaseData({ widgetUrl: WIDGET_URL, widgetSnapshot: null }));
    const scripts = [...withWidget.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("/islands/join-widget.js");
    expect(scripts[0]).toContain("defer");
  });
});
