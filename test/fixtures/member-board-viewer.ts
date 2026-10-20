// Acceptance-owned fixture: actual page renderers, synthetic rows, no DB or login.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { MemberLeaderboardPage } from "../../src/leaderboards/pages";

const root = fileURLToPath(new URL("../../", import.meta.url));
const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
export type Twin = "hono" | "kit";
export type Scope = "overall" | "relative";
export const VIEWER = "Fixture viewer";
const viewerId = "100000000000000202";

type Data = Record<string, unknown>;
type RenderKit = (data: Data) => string;
let renderKit: RenderKit;
let compileCss: Awaited<ReturnType<typeof cssCompiler>>;

function cssCompiler() {
  const { compile } = webRequire("@tailwindcss/node") as {
    compile: (
      css: string,
      options: { base: string; onDependency: (path: string) => void },
    ) => Promise<{ build: (candidates: string[]) => string }>;
  };
  return compile(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
}

export async function prepareMemberBoardFixtures() {
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "member-board-viewer-"),
  );
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "render.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib/") },
      plugins: [
        {
          name: "member-board-viewer-ssr",
          setup(plugin) {
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
    ({ renderPage: renderKit } = (await import(pathToFileURL(outfile).href)) as {
      renderPage: RenderKit;
    });
    compileCss = await cssCompiler();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function renderMemberBoard(twin: Twin, scope: Scope, viewerPresent = true, empty = false) {
  // Overall is long; relative is the real eleven-row neighborhood with absolute ranks.
  const size = empty ? 0 : scope === "overall" ? 60 : 11;
  const viewerIndex = scope === "overall" ? 8 : 5;
  const rows = Array.from({ length: size }, (_, index) => ({
    userId: index === viewerIndex && viewerPresent ? viewerId : `fixture-member-${index}`,
    username:
      index === viewerIndex ? VIEWER : `Fixture member ${String(index + 1).padStart(2, "0")}`,
    count: 100 - index,
    rank: scope === "overall" ? index + 1 : index + 36,
    isViewer: index === viewerIndex && viewerPresent,
  }));
  if (twin === "kit") {
    return renderKit({
      season: "all",
      scope,
      activity: null,
      rows,
      viewerUsername: VIEWER,
      available: true,
      appUrl: "https://example.test",
    });
  }
  return MemberLeaderboardPage({
    appUrl: "https://example.test",
    session: { id: viewerId, username: VIEWER, avatar: null, member: true, moderator: false },
    query: { season: "all", scope, activity: null },
    rows,
    available: true,
  })!.toString() as string;
}

export function memberBoardDocument(twin: Twin, scope: Scope) {
  const html = renderMemberBoard(twin, scope);
  const candidates = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
    match[1]!.split(/\s+/),
  );
  // Real served order for the schedule shell (src/page-shell.tsx): styles,
  // theme-tokens, theme, schedule-theme. Tokens must precede the sheets that
  // consume them, or sticky headers resolve --surface to transparent.
  const css = ["styles", "theme-tokens", "theme", "schedule-theme"]
    .map((name) => readFileSync(join(root, `public/${name}.css`), "utf8"))
    .join("\n");
  const styles = css + (twin === "kit" ? `\n${compileCss.build(candidates)}` : "");
  if (styles.includes("</style")) throw new Error("Fixture CSS must not close its style tag");
  // Keep the real shell and page, but inline the served styles and never execute islands.
  // Preserve the real <body> attributes: the Hono shell themes through
  // body.base-theme.schedule-theme, and a bare <body> drops every token.
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/)?.[1] ?? "";
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/);
  const bodyAttrs = bodyMatch?.[1] ?? "";
  const body = bodyMatch?.[2] ?? html;
  const inert = (value: string) =>
    value.replace(/<link\b[^>]*>/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${inert(head)}<style>${styles}</style></head><body${bodyAttrs}>${inert(body)}</body></html>`;
}
