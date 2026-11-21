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
    loader: { ".css": "empty" },
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

  it("shows equal visible sign-up counts as ties without changing the reader's order", () => {
    const html = renderPage(
      baseData({
        rows: [
          { username: "Vic", count: 3, rank: 1, isViewer: true },
          { username: "Mira", count: 3, rank: 2, isViewer: false },
          { username: "Jo", count: 1, rank: 3, isViewer: false },
        ],
      }),
    );
    expect(html).toContain("Ranked by events signed up for (going), not by attendance.");
    expect(html).toContain('content="Members ranked by events they signed up for as going."');
    expect(html).toContain('aria-label="Leading sign-up counts"');
    expect(html).toContain("Vic (you)");
    expect(html.match(/1 \(tied\)/g)).toHaveLength(2);
    expect(html).not.toContain("2 (tied)");
    expect(html).toContain('<th scope="row">Jo</th>');
    expect(html).not.toContain("Season elapsed");
  });

  it("does not assign an exact tie rank at the clipped start of the relative window", () => {
    const html = renderPage(
      baseData({
        scope: "relative",
        rows: [
          { username: "Mira", count: 3, rank: 8, isViewer: false },
          { username: "Vic", count: 3, rank: 9, isViewer: true },
        ],
      }),
    );
    expect(html.match(/>Tied</g)).toHaveLength(2);
    expect(html).not.toContain("8 (tied)");
    expect(html).not.toContain("Leading sign-up counts");
    expect(html).toContain("Around you (5 above and below): Going counts");
  });

  it("distinguishes an empty game from an outage and offers no-JS recovery", () => {
    const data = baseData({ season: "2000-02", activity: "valheim", rows: [] });
    const html = renderPage(data);
    expect(html).toContain('aria-label="Season elapsed" max="29" value="29"');
    expect(html).toContain("Ended 1 March 2000 (UTC)");
    expect(html).toContain("Nobody is ranked for this season and game yet.");
    expect(html).toContain('<a href="/leaderboards/members?season=2000-02">show every game</a>');
    expect(html).toContain('<a href="/profile">profile settings</a>');
    expect(html).not.toContain("Leading sign-up counts");
    expect(html).not.toContain("Hidden (only you see this)");
    const outage = renderPage({ ...data, available: false });
    expect(outage).toContain("Rankings are temporarily unavailable.");
    expect(outage).not.toContain("Nobody is ranked");
  });
});
