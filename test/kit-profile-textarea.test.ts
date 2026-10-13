// Kit profile view: the owner edit form's textareas render their exact values.
//
// Svelte keeps whitespace inside a <textarea> (it drops only the newline right
// after the opening tag), so an indented {form.games_text} child becomes part
// of the field value. Both textareas bind value as an attribute instead, which
// Svelte SSR serializes as the exact body text — formatter-proof. This test
// SSR-compiles the real ProfileView (same harness shape as
// test/kit-rules-parity.test.ts) and asserts the rendered bodies match.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { MemberView } from "../src/profiles/store";

const APP_URL = "https://next.example.test";

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => string;

let renderView: RenderView;

const ownerProps = (member: MemberView) => ({
  member,
  stats: null,
  isOwner: true,
  isModerator: false,
  appUrl: APP_URL,
  joinResult: null,
});

const textareaBody = (html: string, name: string): string => {
  const match = html.match(
    new RegExp(`<textarea\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)<\\/textarea>`),
  );
  expect(match, `${name} textarea renders`).not.toBeNull();
  // Group 1 always participates when the match succeeds; the ?? only
  // satisfies noUncheckedIndexedAccess, it never masks a missing textarea.
  return match?.[1] ?? "";
};

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-profile-textarea-"));
  const entry = join(scratch, "kit-profile-textarea-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderView(props) {
  const { body } = render(View, { props });
  return body;
}
`,
  );
  const outfile = join(scratch, "kit-profile-textarea.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    plugins: [
      {
        name: "kit-profile-textarea-svelte-ssr",
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
  ({ renderView } = (await import(pathToFileURL(outfile).href)) as {
    renderView: RenderView;
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

describe("Kit profile view: edit-form textareas carry no indentation", () => {
  it("renders the bio and games bodies exactly, empty when there are no games", () => {
    const withGames = renderView(
      ownerProps({
        id: "100000000000000001",
        username: "alice",
        avatar: null,
        bio: "Alice bio",
        games: ["Minecraft", "Factorio"],
        timezone: "Europe/London",
      }),
    );
    expect(textareaBody(withGames, "games_text")).toBe("Minecraft\nFactorio");
    expect(textareaBody(withGames, "bio")).toBe("Alice bio");

    const noGames = renderView(
      ownerProps({
        id: "100000000000000002",
        username: "bob",
        avatar: null,
        bio: "",
        games: [],
        timezone: null,
      }),
    );
    expect(textareaBody(noGames, "games_text")).toBe("");
    expect(textareaBody(noGames, "bio")).toBe("");
  });
});
