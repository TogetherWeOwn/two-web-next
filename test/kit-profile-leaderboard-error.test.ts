// Regression coverage for the #847 review gap: no test covered the
// `leaderboard_opt_out` error branch. Both renderers (Hono ProfilePage and the
// Svelte ProfileView) must render the failed-save state for that key exactly
// like the other fields: a summary link into the switch control, a per-field
// error with a stable id and aria wiring, and the submitted switch choice
// preserved. The message below is the real validator copy from
// src/profiles/validation.ts, so the tests pin the contract end to end.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PROFILE_ERROR_IDS,
  PROFILE_FIELD_IDS,
  ProfilePage,
  profileFieldForErrorKey,
} from "../src/profiles/pages";
import type { MemberView } from "../src/profiles/store";

const LEADERBOARD_ERROR = "Choose whether to appear on the member leaderboard.";

const MEMBER: MemberView = {
  id: "100000000000000001",
  username: "alice",
  avatar: null,
  bio: "Alice bio",
  games: ["Chess"],
  timezone: "Europe/London",
  leaderboardOptOut: false,
};

const HONO_BASE = {
  member: MEMBER,
  isOwner: true as const,
  appUrl: "https://next.example.test",
};

const renderHono = (
  errors: Record<string, string>,
  values = { bio: "draft bio", games_text: "Go", timezone: "UTC", leaderboard_opt_out: true },
): string => String(jsx(ProfilePage, { ...HONO_BASE, errors, values }));

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => string;

let renderView: RenderView;

const baseProps = (overrides: Record<string, unknown> = {}) => ({
  member: MEMBER,
  stats: null,
  isOwner: true,
  isModerator: false,
  appUrl: "https://next.example.test",
  joinResult: null,
  ...overrides,
});

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-profile-leaderboard-error-"));
  const entry = join(scratch, "kit-profile-leaderboard-error-entry.mjs");
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
  const outfile = join(scratch, "kit-profile-leaderboard-error.mjs");
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
        name: "kit-profile-leaderboard-error-svelte-ssr",
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

describe("leaderboard_opt_out error key maps to the switch control", () => {
  it("resolves to the leaderboard field instead of staying global", () => {
    expect(profileFieldForErrorKey("leaderboard_opt_out")).toBe("leaderboard_opt_out");
    expect(PROFILE_FIELD_IDS.leaderboard_opt_out).toBe("profile-leaderboard-opt-out");
    expect(PROFILE_ERROR_IDS.leaderboard_opt_out).toBe("profile-leaderboard-opt-out-error");
  });
});

describe("Hono ProfilePage renders the leaderboard error", () => {
  it("links the summary to the switch with aria wiring and keeps the submitted choice", () => {
    const html = renderHono({ leaderboard_opt_out: LEADERBOARD_ERROR });
    expect(html).toContain('data-testid="profile-error"');
    expect(html).toContain('href="#profile-leaderboard-opt-out"');
    expect(html).toContain('id="profile-leaderboard-opt-out-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="profile-leaderboard-opt-out-error"');
    expect(html).toContain(LEADERBOARD_ERROR);
    // Submitted opt-out (true) keeps the switch ticked, like the other fields
    // keep their drafts.
    expect(html).toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  });

  it("keeps the switch unticked when the submitted choice was false", () => {
    const html = renderHono(
      { leaderboard_opt_out: LEADERBOARD_ERROR },
      { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
    );
    expect(html).toContain('id="profile-leaderboard-opt-out-error"');
    expect(html).toContain(LEADERBOARD_ERROR);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  });
});

describe("Svelte ProfileView renders the leaderboard error", () => {
  it("links the summary to the switch with aria wiring and keeps the submitted choice", () => {
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: LEADERBOARD_ERROR },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: true },
      }),
    );
    expect(html).toContain('data-testid="profile-error"');
    expect(html).toContain('href="#profile-leaderboard-opt-out"');
    expect(html).toContain('id="profile-leaderboard-opt-out-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="profile-leaderboard-opt-out-error"');
    expect(html).toContain(LEADERBOARD_ERROR);
    expect(html).toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  });

  it("keeps the switch unticked when the submitted choice was false", () => {
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: LEADERBOARD_ERROR },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    expect(html).toContain('id="profile-leaderboard-opt-out-error"');
    expect(html).toContain(LEADERBOARD_ERROR);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  });

  it("escapes a hostile leaderboard error instead of interpreting it", () => {
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: "<script>alert(1)</script>" },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
  });
});
