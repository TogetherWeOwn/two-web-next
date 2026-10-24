// Acceptance-owned. Real shared readers, Hono homepage, Kit load and compiled
// Svelte SSR: a renderer-only fix cannot satisfy the mapper pins, and a mapper
// fix on only one read path cannot satisfy both homepages. No source-text pins.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listPublishedFeatured, listVisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import app from "./app";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("no database in link acceptance");
  },
}));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile(source: string, options: Record<string, unknown>): { js: { code: string } };
};
const envKey = "__featuredLinkAcceptanceEnv";
const sharedEnv: Record<string, unknown> = {};
let scratch = "";
let kit: {
  load(
    args: Record<string, unknown>,
  ): Promise<{ featured: Array<{ title: string; url: string | null }> }>;
  renderHome(data: Record<string, unknown>): string;
  renderNew(data: Record<string, unknown>): string;
  renderEdit(data: Record<string, unknown>): string;
  reset(): void;
};
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>)[envKey] = sharedEnv;
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "featured-link-ssr-"),
  );
  const outfile = join(scratch, "bundle.mjs");
  await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Home from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
        import New from ${JSON.stringify(join(root, "web/src/routes/admin/featured/new/+page.svelte"))};
        import Edit from ${JSON.stringify(join(root, "web/src/routes/admin/featured/[id]/+page.svelte"))};
        export { load } from ${JSON.stringify(join(root, "web/src/routes/+page.server.ts"))};
        export { __resetHomeGuestCacheForTests as reset } from ${JSON.stringify(join(root, "src/home-cache.ts"))};
        export const renderHome = data => render(Home, { props: { data } }).body;
        export const renderNew = data => render(New, { props: { data } }).body;
        export const renderEdit = data => render(Edit, { props: { data } }).body;
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "featured-link-real-kit-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "link-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "link-fixture" }, () => ({
            contents: `export const env = globalThis[${JSON.stringify(envKey)}];`,
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
  kit = (await import(pathToFileURL(outfile).href)) as typeof kit;
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[envKey];
});
const fetchSpy = vi.fn(() => {
  throw new Error("featured links must not be fetched");
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetHomeGuestCacheForTests();
  kit?.reset();
});

// Hand-derived outcomes, not the production URL helper. Encoded path data and
// an @ outside authority stay links. Explicit ports are allowed for links;
// unlike images there is no CSP origin-port restriction here.
const cases = [
  { label: "username", raw: "https://trusted.example@evil.example/", want: null },
  { label: "password", raw: "https://user:pass@example.test/", want: null },
  { label: "empty userinfo", raw: "https://@example.test/", want: null },
  { label: "backslash", raw: "https://example.test/a\\b", want: null },
  { label: "space", raw: "https://example.test/a b", want: null },
  { label: "leading whitespace", raw: " https://example.test/path", want: null },
  { label: "trailing whitespace", raw: "https://example.test/path ", want: null },
  { label: "tab", raw: "https://example.test/a\tb", want: null },
  { label: "newline", raw: "https://example.test/a\nb", want: null },
  { label: "C0", raw: "https://example.test/a\u0007b", want: null },
  { label: "DEL", raw: "https://example.test/a\u007fb", want: null },
  { label: "non-http", raw: "javascript:alert(1)", want: null },
  {
    label: "http with port",
    raw: "http://example.test:8080/path?query=yes#frag",
    want: "http://example.test:8080/path?query=yes#frag",
  },
  {
    label: "https with port",
    raw: "https://example.test:8443/path?query=yes#frag",
    want: "https://example.test:8443/path?query=yes#frag",
  },
  {
    label: "encoded path",
    raw: "https://example.test/a%20b?next=%5C#part",
    want: "https://example.test/a%20b?next=%5C#part",
  },
  {
    label: "path at-sign",
    raw: "https://example.test/team@home",
    want: "https://example.test/team@home",
  },
  { label: "no link", raw: null, want: null },
];

function fixture(url: string | null) {
  let reads = 0;
  // Real Drizzle projection and mapping with a local SQL transport, not a
  // sanitized reader mock. Published-base reads select eight columns; direct
  // visible reads select six. The raw stored URL always crosses this seam.
  const db = drizzle(async (sql) => {
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "featured_contents"')) {
      reads++;
      const row = [1, "Stored evening", "Stored body", url, null, null];
      const select = sql.slice(0, sql.indexOf('from "featured_contents"'));
      return { rows: [select.includes('"starts_at"') ? [...row, null, null] : row] };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => [],
      lastReadFailed: () => false,
    },
  } as Env;
  for (const key of Object.keys(sharedEnv)) delete sharedEnv[key];
  Object.assign(sharedEnv, env);
  return { db, env, reads: () => reads };
}

function expectFeatured(html: string, want: string | null) {
  const articles =
    html.match(/<article\b[^>]*data-testid="featured-item"[^>]*>[\s\S]*?<\/article>/g) ?? [];
  expect(articles).toHaveLength(1); // Suppressing the entire row is not a fix.
  const item = articles[0]!;
  expect(item).toContain("Stored evening");
  expect(item).toContain("Stored body");
  if (want === null) expect(item).not.toMatch(/<a\b|\bhref=/);
  else expect(item).toContain(`href="${want}"`);
}

describe("featured stored-link acceptance: shared mapper and both real homepages", () => {
  it.each(cases)("sanitizes $label in both shared reader projections", async ({ raw, want }) => {
    const f = fixture(raw);
    for (const read of [listVisibleFeatured, listPublishedFeatured]) {
      const rows = await read(f.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Stored evening", body: "Stored body", url: want });
    }
    expect(f.reads()).toBe(2);
  });
  it.each(cases)(
    "Hono keeps the stored $label title, linking only safe URLs",
    async ({ raw, want }) => {
      const f = fixture(raw);
      const res = await app.request("/", {}, f.env);
      expect(res.status).toBe(200);
      expectFeatured(await res.text(), want);
      expect(f.reads()).toBe(1);
    },
  );
  it.each(cases)(
    "Kit load + SSR keeps the stored $label title, linking only safe URLs",
    async ({ raw, want }) => {
      const f = fixture(raw);
      const url = new URL(baseEnv.APP_URL);
      const data = await kit.load({
        url,
        request: new Request(url),
        locals: { status: "guest" },
        cookies: { delete() {} },
        setHeaders() {},
      });
      // Inspect the load DTO as well as SSR: a Kit-only anchor guard is not the
      // shared-mapper fix, and unsafe links must not survive in serialized data.
      expect(data.featured).toHaveLength(1);
      expect(data.featured[0]).toMatchObject({ title: "Stored evening", url: want });
      expectFeatured(kit.renderHome(data), want);
      expect(f.reads()).toBe(1);
    },
  );
});

describe("featured Kit form link guidance", () => {
  it.each(["new", "edit"])("%s form associates all refused classes with the link input", (mode) => {
    const data = {
      view: {
        id: 1,
        title: "Stored evening",
        status: "draft",
        visible: false,
        startsAt: null,
        endsAt: null,
        updatedAt: new Date(0).toISOString(),
        checkedAt: new Date(0).toISOString(),
        imageSrc: null,
        imageAlt: "Stored evening",
        values: {
          title: "Stored evening",
          body: "",
          url: "",
          image_url: "",
          image_alt: "",
          is_published: "",
          position: "0",
          starts_at: "",
          ends_at: "",
        },
      },
    };
    const html = mode === "new" ? kit.renderNew(data) : kit.renderEdit(data);
    const input = html.match(/<input\b[^>]*name="url"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    const ids = input!.match(/aria-describedby="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    const copy = ids
      .map((id) => html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</p>`))?.[1] ?? "")
      .join(" ");
    expect(copy).toMatch(/credentials|userinfo|user.?name/i);
    expect(copy).toMatch(/backslash/i);
    expect(copy).toMatch(/white.?space|spaces?/i);
    expect(copy).toMatch(/control|C0/i);
  });
});
