// Kit member-board SSR render contract: the real
// web/src/routes/leaderboards/members/+page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// test/kit-about-parity.test.ts), rendered with fake load data. The board is
// members-only, so its chrome must be the member chrome Hono serves from
// src/page-shell.tsx (Signed in + viewer name + Sign out form), never the
// Shell default guest chrome. The executed parity journey caught the guest
// default in CI; this render pins it hermetically.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type BoardData = Record<string, unknown>;
let renderPage: (data: BoardData) => string;
let scratch = "";

function baseData(overrides: BoardData = {}): BoardData {
  return {
    season: "all",
    scope: "overall",
    activity: null,
    rows: [{ username: "Vic", count: 3, rank: 1, isViewer: true }],
    viewerUsername: "Vic",
    available: true,
    appUrl: "https://example.test",
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-members-render-"));
  const entry = join(scratch, "kit-members-render-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-members-render.mjs");
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
        name: "kit-members-svelte-ssr",
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
  ({ renderPage } = (await import(pathToFileURL(outfile).href)) as {
    renderPage: (data: BoardData) => string;
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("Kit member board render", () => {
  it("serves member chrome (Signed in, viewer name, Sign out), never guest chrome", () => {
    const html = renderPage(baseData());
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain('<span class="account-caption">Signed in</span>');
    expect(html).toContain('<span class="who">Vic</span>');
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Welcome, guest");
    expect(html).not.toContain("Sign in with Discord");
    // The viewer's own row is marked from the server-side isViewer flag.
    expect(html).toContain('aria-current="true"');
  });

  it("links the board in the Primary nav as the current page, as Hono does, not Events", () => {
    const nav = renderPage(baseData()).match(
      /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/,
    );
    expect(nav).not.toBeNull();
    expect(nav![1]).toContain(
      '<a href="/leaderboards/members" aria-current="page">Leaderboard</a>',
    );
    // Events is a sibling section here, never the current page.
    expect(nav![1]).toContain('<a href="/events">Events</a>');
  });
});
