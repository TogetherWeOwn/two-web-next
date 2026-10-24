// Test-only executed-renderer fixtures. No database or remote service.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx";
import { faqPageData } from "../../src/faq-content";
import { ProfilePage } from "../../src/profiles/pages";
import type { MemberView } from "../../src/profiles/store";

export const gamesScopeOrigin = "https://games.example.test";
export const gamesScopeMember: MemberView = {
  id: "100000000000000001",
  username: "Fixture",
  avatar: null,
  bio: "Stored bio",
  games: ["Chess"],
  timezone: "UTC",
  leaderboardOptOut: false,
};
export const gamesScopeLinkName = "Open Discord to change game roles";
export type GamesScopeProps = {
  isOwner?: boolean;
  errors?: Record<string, string>;
  values?: { bio: string; games_text: string; timezone: string; leaderboard_opt_out: boolean };
};
export type GamesScopeRenderer = (props?: GamesScopeProps) => string;

export const renderGamesScopeHono: GamesScopeRenderer = (props = {}) =>
  String(
    jsx(ProfilePage, {
      member: gamesScopeMember,
      isOwner: true,
      appUrl: gamesScopeOrigin,
      ...props,
    }),
  );

// The real Kit components are compiled and executed, not inspected as source or
// replaced with a hand-written rendering. Adapted from profile-composition-hints
// and faq-rsvp-recovery-acceptance's esbuild/Svelte harnesses.
export async function compileGamesScopeKit() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler");
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "games-scope-",
    ),
  );
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "render.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Profile from ${JSON.stringify(join(root, "web/src/lib/ProfileView.svelte"))};
import Faq from ${JSON.stringify(join(root, "web/src/routes/faq/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(root, "src/leaf-critical-css.ts"))};
export const profile = props => render(Profile, { props }).body;
export const faq = data => render(Faq, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } }).body;
`,
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
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "games-scope-real-svelte",
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
    const module = (await import(pathToFileURL(outfile).href)) as {
      profile(props: Record<string, unknown>): string;
      faq(data: ReturnType<typeof faqPageData>): string;
    };
    return {
      profile: ((props = {}) =>
        module.profile({
          member: gamesScopeMember,
          stats: null,
          isOwner: true,
          isModerator: false,
          appUrl: gamesScopeOrigin,
          joinResult: null,
          ...props,
        })) as GamesScopeRenderer,
      faq: () => module.faq(faqPageData(gamesScopeOrigin)),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function scopeText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function scopeTag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0] ?? "";
}

export function scopeNode(html: string, id: string): string {
  // IDs come from the rendered markup, so escape before constructing a regexp.
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    html.match(
      new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid="${escaped}"[^>]*>([\\s\\S]*?)</\\1>`),
    )?.[2] ?? ""
  );
}

export function gamesDescriptionIds(html: string): string[] {
  return (
    scopeTag(html, "profile-games-text")
      .match(/aria-describedby="([^"]*)"/)?.[1]
      ?.split(/\s+/)
      .filter(Boolean) ?? []
  );
}

// Semantic assertions deliberately allow editorial wording and any new hint ID.
// Removing the boundary, either role operation, or association must fail.
export const gamesScopeMeanings = [
  /(?:website|site|profile)[^.]{0,100}(?:games?|interests?)/i,
  /(?:do(?:es)? not|don['’]t|doesn['’]t|won['’]t|will not|never|without)[^.]{0,100}(?:grant|give|add|assign|change|affect|manage|sync)[^.]{0,100}(?:Discord|roles?)/i,
  /(?:do(?:es)? not|don['’]t|doesn['’]t|won['’]t|will not|never|without)[^.]{0,140}(?:remov|revok|change|affect|manage|sync)[^.]{0,100}(?:Discord|roles?)/i,
];
