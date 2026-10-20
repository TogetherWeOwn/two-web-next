// Acceptance: board captions name their scope + window, and empty boards
// recover with links instead of bare status paragraphs — identically on the
// Hono and Kit twins.
//
// Locked contract (paired Builder satisfies this without editing this file):
// - Overall captions name the scope and the 1-100 cap ("Overall", "ranks
//   1-100" with either dash); relative captions name the scope and the window
//   ("Around you", "<n> above and below" where n tracks RELATIVE_NEIGHBORS).
//   Both keep the season and game labels, including the "every game" fallback.
// - The window math is helper-driven: neither twin view
//   (src/leaderboards/pages.tsx, web/.../members/+page.svelte) hardcodes the
//   new window/cap literals, and both twins render byte-identical captions for
//   the same query. Content tests fail until the copy exists; the no-literals
//   guard plus parity force a single shared source without naming its path.
// - Relative-empty links the overall scope for the same season/game, names the
//   ranked path ("going to get ranked") and links events. Overall-empty links
//   events, and clears the game filter when one is set. Assertions run on the
//   post-form board region only, so the scope nav cannot false-pass them.
// - Guardrail: caption and empty-state markup links boards and events only —
//   never profile/user links, never a Discord id. MembersBoardRow already
//   omits userId; these tests pin the rendered bytes.
// - Unchanged controls: the viewer-row highlight still marks exactly the
//   viewer row per scope per twin, and the Hono 400 filter page keeps its
//   recovery actions and problem naming. (Kit 400 shell behavior is pinned by
//   its own acceptance card, not here.)
//
// Hermetic only: the real Hono component plus the real Kit page compiled with
// the web workspace's svelte/compiler (same harness as
// test/kit-members-render.test.ts), synthetic rows, no DB or login. At the
// pinned base the caption-content and empty-link tests fail red (generic
// caption, zero files hold the copy, zero links in empty states) while the
// parity, no-literals, guardrail and unchanged controls pass.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { OVERALL_CAP, RELATIVE_NEIGHBORS, type BoardRow } from "../src/leaderboards/members";
import {
  boardPath,
  MemberBoardFilterErrorPage,
  MemberLeaderboardPage,
  type BoardQuery,
} from "../src/leaderboards/pages";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type Twin = "hono" | "kit";
type BoardData = Record<string, unknown>;

const TWINS: Twin[] = ["hono", "kit"];
const VIEWER = "Caption viewer";
const VIEWER_ID = "100000000000000202";
const MEMBER_SESSION = {
  id: VIEWER_ID,
  username: VIEWER,
  avatar: null,
  member: true,
  moderator: false,
};

let renderKit: (data: BoardData) => string;

beforeAll(async () => {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "board-captions-"),
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
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib/") },
      plugins: [
        {
          name: "board-captions-ssr",
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
      renderPage: (data: BoardData) => string;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function sampleRows(): BoardRow[] {
  return [
    { userId: "100000000000000201", username: "Board alpha", count: 9, rank: 1 },
    { userId: VIEWER_ID, username: VIEWER, count: 7, rank: 2 },
    { userId: "100000000000000203", username: "Board gamma", count: 5, rank: 3 },
  ];
}

function renderTwin(twin: Twin, query: BoardQuery, rows: BoardRow[]): string {
  if (twin === "hono") {
    return MemberLeaderboardPage({
      appUrl: "https://example.test",
      session: MEMBER_SESSION,
      query,
      rows,
      available: true,
    })!.toString() as string;
  }
  return renderKit({
    season: query.season,
    scope: query.scope,
    activity: query.activity,
    // The Kit load strips Discord ids server-side (MembersBoardRow): the page
    // only ever sees rank + name + count + the viewer mark.
    rows: rows.map(({ userId, ...row }) => ({
      ...row,
      isViewer: userId === VIEWER_ID,
    })),
    viewerUsername: VIEWER,
    available: true,
    appUrl: "https://example.test",
  });
}

function captionText(html: string, label: string): string {
  const match = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/);
  expect(match, `${label} renders a table caption`).not.toBeNull();
  return match![1]!.replace(/\s+/g, " ").trim();
}

/**
 * The post-form board region: everything after the filter form up to </main>.
 * The scope nav already links both scopes, so empty-state link assertions run
 * here — on the full document they would false-pass on nav links.
 */
function boardRegion(html: string, label: string): string {
  const formEnd = html.lastIndexOf("</form>");
  expect(formEnd, `${label} keeps the filter form`).toBeGreaterThan(-1);
  const mainEnd = html.indexOf("</main>", formEnd);
  expect(mainEnd, `${label} keeps the main landmark`).toBeGreaterThan(-1);
  return html.slice(formEnd + "</form>".length, mainEnd);
}

for (const twin of TWINS) {
  describe(`${twin} board captions`, () => {
    it("overall caption names the scope, the 1-100 cap and the season/game labels", () => {
      const caption = captionText(
        renderTwin(twin, { season: "2026-09", scope: "overall", activity: "chess" }, sampleRows()),
        `${twin} overall`,
      );
      expect(caption).toContain("Overall");
      expect(caption).toMatch(/ranks 1[–-]100/);
      expect(caption).toContain(String(OVERALL_CAP));
      expect(caption).toContain("2026-09");
      expect(caption).toContain("chess");
    });

    it("relative caption names the scope, the neighbor window and the season/game labels", () => {
      const caption = captionText(
        renderTwin(twin, { season: "2026-09", scope: "relative", activity: "chess" }, sampleRows()),
        `${twin} relative`,
      );
      expect(caption).toContain("Around you");
      expect(caption).toContain(`${RELATIVE_NEIGHBORS} above and below`);
      expect(caption).toContain("2026-09");
      expect(caption).toContain("chess");
    });

    it("unfiltered captions keep the every-game label", () => {
      for (const scope of ["overall", "relative"] as const) {
        const caption = captionText(
          renderTwin(twin, { season: "all", scope, activity: null }, sampleRows()),
          `${twin} ${scope} unfiltered`,
        );
        expect(caption).toContain("every game");
      }
    });
  });
}

describe("caption single source", () => {
  it.each(["overall", "relative"] as const)(
    "%s captions are byte-identical across twins",
    (scope) => {
      const query: BoardQuery = { season: "2026-09", scope, activity: "chess" };
      expect(
        captionText(renderTwin("kit", query, sampleRows()), "kit"),
        `${scope} caption parity`,
      ).toBe(captionText(renderTwin("hono", query, sampleRows()), "hono"));
    },
  );

  it("neither twin view hardcodes the new window/cap literals", () => {
    const honoView = readFileSync(join(root, "src/leaderboards/pages.tsx"), "utf8");
    const kitView = readFileSync(
      join(root, "web/src/routes/leaderboards/members/+page.svelte"),
      "utf8",
    );
    for (const [label, source] of [
      ["Hono view", honoView],
      ["Kit view", kitView],
    ] as const) {
      expect(source, `${label} must not hardcode the window copy`).not.toContain("above and below");
      expect(source, `${label} must not hardcode the cap copy`).not.toMatch(/ranks 1[–-]100/);
    }
  });
});

for (const twin of TWINS) {
  describe(`${twin} empty-board recovery`, () => {
    it("relative-empty links the overall scope for the same season and game", () => {
      const query: BoardQuery = { season: "2026-09", scope: "relative", activity: "chess" };
      const region = boardRegion(renderTwin(twin, query, []), `${twin} relative-empty`);
      expect(region).toContain(
        `href="${boardPath({ ...query, scope: "overall" }).replace(/&/g, "&amp;")}"`,
      );
    });

    it("relative-empty names the ranked path and links events", () => {
      const query: BoardQuery = { season: "2026-09", scope: "relative", activity: "chess" };
      const region = boardRegion(renderTwin(twin, query, []), `${twin} relative-empty`);
      expect(region).toContain("going to get ranked");
      expect(region).toMatch(/href="\/events("|\?)/);
    });

    it("overall-empty with a game filter links events and clears the filter", () => {
      const query: BoardQuery = { season: "2026-09", scope: "overall", activity: "chess" };
      const region = boardRegion(renderTwin(twin, query, []), `${twin} overall-empty`);
      expect(region).toMatch(/href="\/events("|\?)/);
      expect(region).toContain(`href="${boardPath({ ...query, activity: null })}"`);
    });

    it("overall-empty without a filter links events", () => {
      const query: BoardQuery = { season: "all", scope: "overall", activity: null };
      const region = boardRegion(renderTwin(twin, query, []), `${twin} overall-empty`);
      expect(region).toMatch(/href="\/events("|\?)/);
    });
  });
}

describe("board caption and empty-state guardrails", () => {
  it("new markup links boards and events only, never profiles or ids", () => {
    const queries: BoardQuery[] = [
      { season: "2026-09", scope: "overall", activity: "chess" },
      { season: "2026-09", scope: "relative", activity: "chess" },
      { season: "all", scope: "overall", activity: null },
      { season: "all", scope: "relative", activity: null },
    ];
    const cases: Array<["table" | "empty", BoardRow[]]> = [
      ["table", sampleRows()],
      ["empty", []],
    ];
    for (const twin of TWINS) {
      for (const query of queries) {
        for (const [kind, rows] of cases) {
          const region = boardRegion(
            renderTwin(twin, query, rows),
            `${twin} ${query.scope} ${kind}`,
          );
          const hrefs = [...region.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
          for (const href of hrefs) {
            expect(href, `${twin} ${query.scope} ${kind} profile link`).not.toMatch(
              /\/profiles?\b/i,
            );
            expect(href, `${twin} ${query.scope} ${kind} user link`).not.toMatch(/\/users?\//i);
            expect(href, `${twin} ${query.scope} ${kind} id link`).not.toMatch(/userId|user_id/i);
          }
          expect(region, `${twin} ${query.scope} ${kind} carries no Discord id`).not.toMatch(
            /\d{17,}/,
          );
        }
      }
    }
  });

  it("control: viewer-row highlight still marks exactly the viewer row per scope per twin", () => {
    for (const twin of TWINS) {
      for (const scope of ["overall", "relative"] as const) {
        const html = renderTwin(twin, { season: "all", scope, activity: null }, sampleRows());
        const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
        const marked = rows.filter((row) => /^<tr\b[^>]*aria-current="true"/.test(row));
        expect(marked, `${twin} ${scope} marks one row`).toHaveLength(1);
        expect(marked[0]).toContain(VIEWER);
        expect(marked[0]).toMatch(/>2<\//);
      }
    }
  });

  it("control: the Hono 400 filter page keeps its recovery actions and problem naming", () => {
    const html = MemberBoardFilterErrorPage({
      session: MEMBER_SESSION,
      problem: "Unknown season",
    })!.toString() as string;
    expect(html).toContain('data-testid="error-board"');
    expect(html).toContain('data-testid="error-home"');
    expect(html).toContain("Show the board");
    expect(html).toContain("Back to the homepage");
    expect(html).toContain("Unknown season");
    expect(html).not.toContain("temporarily unavailable");
  });
});
