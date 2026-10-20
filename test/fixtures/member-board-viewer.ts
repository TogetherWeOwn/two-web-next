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
  // Strip link/script chrome by walking angle-bracket tokens instead of tag
  // regexes (CodeQL js/bad-tag-filter): drop link tokens and lone script
  // closers case-insensitively, and skip raw script bodies through </script>.
  const inert = (value: string): string => {
    const lower = value.toLowerCase();
    let out = "";
    let cursor = 0;
    while (cursor < value.length) {
      const open = value.indexOf("<", cursor);
      if (open === -1) {
        out += value.slice(cursor);
        break;
      }
      out += value.slice(cursor, open);
      let pos = open + 1;
      const closing = value[pos] === "/";
      if (closing) pos += 1;
      const nameStart = pos;
      while (pos < value.length) {
        const code = value.charCodeAt(pos);
        const word =
          (code >= 48 && code <= 57) || // 0-9
          (code >= 65 && code <= 90) || // A-Z
          (code >= 97 && code <= 122); // a-z
        if (!word) break;
        pos += 1;
      }
      const tag = value.slice(nameStart, pos).toLowerCase();
      if (tag.length === 0) {
        out += "<";
        cursor = open + 1;
        continue;
      }
      let end = pos;
      let quote = 0;
      while (end < value.length) {
        const code = value.charCodeAt(end);
        if (quote !== 0) {
          if (code === quote) quote = 0;
        } else if (code === 34 || code === 39) {
          quote = code;
        } else if (code === 62) {
          break;
        }
        end += 1;
      }
      if (end >= value.length) {
        out += value.slice(open);
        break;
      }
      const tagEnd = end + 1;
      const next = value.charCodeAt(pos);
      const delimited =
        next === 62 || // ">"
        next === 47 || // "/"
        next === 32 || // " "
        next === 9 ||
        next === 10 ||
        next === 13 ||
        next === 12;
      if (tag === "link" && delimited) {
        cursor = tagEnd;
        continue;
      }
      if (tag === "script" && delimited) {
        if (closing || value.charCodeAt(end - 1) === 47) {
          cursor = tagEnd;
          continue;
        }
        let skipped = -1;
        let found = lower.indexOf("</script", tagEnd);
        while (found !== -1) {
          const gt = value.indexOf(">", found + 8);
          if (gt === -1) break;
          let wellFormed = true;
          for (let k = found + 8; k < gt; k += 1) {
            const c = value.charCodeAt(k);
            if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 47) {
              wellFormed = false;
              break;
            }
          }
          if (wellFormed) {
            skipped = gt + 1;
            break;
          }
          found = lower.indexOf("</script", found + 8);
        }
        cursor = skipped === -1 ? tagEnd : skipped;
        continue;
      }
      out += value.slice(open, tagEnd);
      cursor = tagEnd;
    }
    return out;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${inert(head)}<style>${styles}</style></head><body${bodyAttrs}>${inert(body)}</body></html>`;
}
