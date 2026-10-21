// Kit profile view: the owner edit form renders 422 errors, preserved values
// and the leaderboard switch exactly like the Hono ProfilePage
// (src/profiles/pages.tsx), so a failed Svelte save never falls back to the
// old UI. SSR-compiles the real ProfileView (same harness shape as
// test/kit-profile-textarea.test.ts).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { MemberView } from "../src/profiles/store";

const APP_URL = "https://next.example.test";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => string;

let renderView: RenderView;

const MEMBER: MemberView = {
  id: "100000000000000001",
  username: "alice",
  avatar: null,
  bio: "Alice bio",
  games: ["Chess"],
  timezone: "Europe/London",
  leaderboardOptOut: false,
};

const baseProps = (overrides: Record<string, unknown> = {}) => ({
  member: MEMBER,
  stats: null,
  isOwner: true,
  isModerator: false,
  appUrl: APP_URL,
  joinResult: null,
  ...overrides,
});

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-profile-form-"));
  const entry = join(scratch, "kit-profile-form-entry.mjs");
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
  const outfile = join(scratch, "kit-profile-form.mjs");
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
        name: "kit-profile-form-svelte-ssr",
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

describe("Kit profile view: 422 re-render keeps the Hono form contract", () => {
  it("renders no error chrome without errors", () => {
    const html = renderView(baseProps());
    expect(html).not.toContain('data-testid="profile-error"');
    expect(html).not.toContain("profile-bio-error");
  });

  it("renders the error summary with field links and per-field errors with aria wiring", () => {
    const html = renderView(
      baseProps({
        errors: {
          bio: "Keep your bio to 1000 characters or fewer.",
          games: "Add no more than 20 games.",
          timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
        },
        values: { bio: "x", games_text: "a", timezone: "y", leaderboard_opt_out: false },
      }),
    );
    // Summary alert with links into the controls (server `games` maps to games_text).
    expect(html).toContain('data-testid="profile-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#profile-bio"');
    expect(html).toContain('href="#profile-games-text"');
    expect(html).toContain('href="#profile-timezone"');
    // Field errors beside the controls, wired for assistive tech. Timezone
    // keeps its help text associated alongside the error.
    for (const field of ["profile-bio", "profile-games-text", "profile-timezone"]) {
      expect(html).toContain(`id="${field}-error"`);
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain(
        field === "profile-timezone"
          ? `aria-describedby="profile-timezone-help ${field}-error"`
          : `aria-describedby="${field}-error"`,
      );
    }
    expect(html).toContain("Keep your bio to 1000 characters or fewer.");
    expect(html).toContain("Add no more than 20 games.");
  });

  it("keeps unknown error keys global with no fabricated control link", () => {
    const html = renderView(
      baseProps({
        errors: {
          fields: "Only your bio, games, timezone and leaderboard setting can be changed.",
        },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    expect(html).toContain('data-testid="profile-error"');
    expect(html).toContain(
      "Only your bio, games, timezone and leaderboard setting can be changed.",
    );
    expect(html).not.toContain('href="#profile-bio"');
  });

  it("preserves the submitted values instead of the stored member record", () => {
    const html = renderView(
      baseProps({
        errors: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." },
        values: {
          bio: "draft bio",
          games_text: "draft game",
          timezone: "Mars/Olympus",
          leaderboard_opt_out: true,
        },
      }),
    );
    // The draft lands in the controls; the read-only section above still
    // shows the stored record until the save succeeds (same as the Hono page).
    expect(html).toContain('<textarea id="profile-bio" name="bio" rows="4">draft bio</textarea>');
    expect(html).toContain(
      '<textarea id="profile-games-text" name="games_text" rows="4">draft game</textarea>',
    );
    expect(html).toContain('value="Mars/Olympus"');
  });

  it("renders the leaderboard switch with the submitted choice preserved", () => {
    const checked = renderView(
      baseProps({
        errors: { bio: "bad" },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: true },
      }),
    );
    expect(checked).toContain('name="leaderboard_opt_out"');
    expect(checked).toContain('id="profile-leaderboard-opt-out"');
    expect(checked).toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);

    const unchecked = renderView(baseProps());
    expect(unchecked).toContain('name="leaderboard_opt_out"');
    expect(unchecked).not.toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  });

  it("carries the island binding contract so the binder owns pending/cancel/focus", () => {
    const html = renderView(baseProps());
    // Mount point the member-profile.js binder queries, keyed to this member.
    expect(html).toContain('data-island="member-profile"');
    expect(html).toContain(`data-member-id="${MEMBER.id}"`);
    // Unchanged write contract: no-JS posts the PATCH override to Hono, the
    // binder PATCHes JSON to the same route when script runs.
    expect(html).toContain(`action="/members/${MEMBER.id}"`);
    expect(html).toContain('name="_method" value="PATCH"');
    // Writable fields plus the spam-trap pair the admission gate requires.
    for (const name of ["bio", "games_text", "timezone", "website", "formOpenedAt"]) {
      expect(html).toContain(`name="${name}"`);
    }
    // Controls the binder and the lifecycle tests address by testid.
    for (const testid of ["profile-edit", "profile-form", "profile-save", "profile-cancel"]) {
      expect(html).toContain(`data-testid="${testid}"`);
    }
  });

  it("escapes hostile error and value text instead of interpreting it", () => {
    const html = renderView(
      baseProps({
        errors: { bio: "<script>alert(1)</script>" },
        values: {
          bio: "<img src=x onerror=alert(1)>",
          games_text: "",
          timezone: "",
          leaderboard_opt_out: false,
        },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    // Svelte text interpolation escapes `<` (leaving `>` literal, which is
    // still inert markup): hostile strings stay text, never elements.
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)>");
  });
});
