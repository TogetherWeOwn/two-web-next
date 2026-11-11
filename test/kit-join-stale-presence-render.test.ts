// Kit /join stale-presence render contract: the real +page.svelte, compiled
// with the web workspace's svelte/compiler and bundled by esbuild (the same
// harness as test/kit-home-render.test.ts), SSR-rendered with fresh, stale,
// and flag-absent staleness. Snapshots ride the production projection
// (toPublicWidgetSnapshot: aggregates only, the Kit __data.json privacy
// boundary); the read-time freshness flag travels as the separate widgetStale
// load field, exactly as the load returns them. String presence in source
// cannot catch a wrong branch: inverting both stale conditions (or deleting
// one) keeps every source-grep suite green while serving "now" copy for stale
// data, the exact bug the fresh-only fix removes. These renders fail those
// mutants on both the heading and the empty-channels line. The Test Author
// acceptance (test/join-widget-fresh-only-acceptance.test.ts, never edited
// here) keeps the Hono end-to-end and cross-renderer parity pins; this suite
// is the executed Kit side. No network, no database: fixtures only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPublicWidgetSnapshot, type DiscordWidgetSnapshot } from "../src/discord-widget";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
// svelte lives in the web workspace only; the root workspace never sees it,
// so the compiler type is structural (no svelte types in the root tsconfig).
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderPage = (data: Record<string, unknown>) => string;

let renderPage: RenderPage;
let scratch = "";

const GUILD = "326474832151838730";
const APP_URL = "https://example.test";
const INVITE_URL = "https://discord.gg/invite";
const WIDGET_URL = `https://discord.com/widget?id=${GUILD}&theme=dark`;

function snapshot(overrides: Partial<DiscordWidgetSnapshot> = {}): DiscordWidgetSnapshot {
  return {
    guildId: GUILD,
    name: "Together We Own",
    inviteUrl: "https://discord.gg/widget-invite",
    presenceCount: 42,
    channels: [
      { id: "1", name: "stage-night", position: 1 },
      { id: "2", name: "lobby-voice", position: 2 },
    ],
    members: [],
    fetchedAt: 0,
    ...overrides,
  };
}

function pageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inviteUrl: INVITE_URL,
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    widgetUrl: WIDGET_URL,
    widgetSnapshot: null,
    widgetStale: false,
    oneClickHref: "/join/discord",
    appUrl: APP_URL,
    joinResult: null,
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-join-stale-render-"));
  const entry = join(scratch, "kit-join-stale-render-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/join/+page.svelte"))};
export function renderPage(data) {
  const { body } = render(Page, { props: { data } });
  return body;
}
`,
  );
  const outfile = join(scratch, "kit-join-stale-render-bundle.mjs");
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
        name: "kit-join-stale-render-svelte-ssr",
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
    renderPage: RenderPage;
  };
  renderPage = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Kit /join stale-presence render", () => {
  it("a stale snapshot qualifies the heading and never renders now copy", () => {
    const body = renderPage(
      pageData({ widgetSnapshot: toPublicWidgetSnapshot(snapshot()), widgetStale: true }),
    );
    expect(body).toContain('data-testid="join-widget-presence"');
    expect(body).toContain("In Together We Own as of the last update");
    expect(body).not.toContain("In Together We Own now");
    expect(body).toContain("stage-night");
  });

  it("a fresh snapshot keeps the live heading and never qualifies", () => {
    const body = renderPage(
      pageData({ widgetSnapshot: toPublicWidgetSnapshot(snapshot()), widgetStale: false }),
    );
    expect(body).toContain('data-testid="join-widget-presence"');
    expect(body).toContain("In Together We Own now");
    expect(body).not.toContain("as of the last update");
  });

  it("a missing stale flag renders the live copy (absent means fresh)", () => {
    const body = renderPage(
      pageData({ widgetSnapshot: toPublicWidgetSnapshot(snapshot()), widgetStale: undefined }),
    );
    expect(body).toContain("In Together We Own now");
    expect(body).not.toContain("as of the last update");
  });

  it("a stale empty-channels snapshot qualifies the line and never renders right now", () => {
    const body = renderPage(
      pageData({
        widgetSnapshot: toPublicWidgetSnapshot(snapshot({ channels: [] })),
        widgetStale: true,
      }),
    );
    expect(body).toContain("No voice channels open as of the last update.");
    expect(body).not.toContain("right now");
  });

  it("a fresh empty-channels snapshot keeps the live line and never qualifies", () => {
    const body = renderPage(
      pageData({
        widgetSnapshot: toPublicWidgetSnapshot(snapshot({ channels: [] })),
        widgetStale: false,
      }),
    );
    expect(body).toContain("No voice channels open right now.");
    expect(body).not.toContain("as of the last update");
  });

  it("a dropped snapshot renders no presence block, only the facade strap", () => {
    const body = renderPage(pageData({ widgetSnapshot: null }));
    expect(body).not.toContain('data-testid="join-widget-presence"');
    expect(body).toContain('data-testid="join-widget-load"');
  });
});
