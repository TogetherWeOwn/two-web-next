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
import { parseFragment } from "parse5";
import { assert, beforeAll, describe, expect, it } from "vitest";
import {
  PROFILE_ERROR_IDS,
  PROFILE_FIELD_IDS,
  ProfilePage,
  profileFieldForErrorKey,
} from "../src/profiles/pages";
import type { MemberView } from "../src/profiles/store";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

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
    const { checkbox, nodes } = leaderboardError(html);
    expectSummaryLink(nodes);
    expect(attr(checkbox, "aria-invalid")).toBe("true");
    expect(attr(checkbox, "aria-describedby")).toBe("profile-leaderboard-opt-out-error");
    // Submitted opt-out (true) keeps the switch ticked, like the other fields
    // keep their drafts.
    expect(attr(checkbox, "checked")).toBeDefined();
  });

  it("keeps the switch unticked when the submitted choice was false", () => {
    const html = renderHono(
      { leaderboard_opt_out: LEADERBOARD_ERROR },
      { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
    );
    const { checkbox } = leaderboardError(html);
    expect(attr(checkbox, "checked")).toBeUndefined();
  });
});

const leaderboardError = (html: string, message = LEADERBOARD_ERROR) => {
  const nodes = elements(parseFragment(html));
  const error = nodes.find((node) => attr(node, "id") === "profile-leaderboard-opt-out-error");
  const checkbox = nodes.find((node) => attr(node, "id") === "profile-leaderboard-opt-out");
  assert(error && checkbox, "Expected the leaderboard checkbox and its error");
  expect(error.tagName).toBe("p");
  expect(attr(error, "class")?.split(/\s+/)).toContain("error");
  expect(textOf(error).trim()).toBe(message);
  expect(checkbox.tagName).toBe("input");
  expect(attr(checkbox, "name")).toBe("leaderboard_opt_out");
  expect(attr(checkbox, "value")).toBe("1");
  expect(attr(checkbox, "type")).toBe("checkbox");
  return { checkbox, nodes };
};

function expectSummaryLink(nodes: ReturnType<typeof elements>, message = LEADERBOARD_ERROR) {
  const summary = nodes.find((node) => attr(node, "data-testid") === "profile-error");
  assert(summary, "Expected the profile error summary");
  expect(attr(summary, "role")).toBe("alert");
  const link = elements(summary).find(
    (node) => attr(node, "href") === "#profile-leaderboard-opt-out",
  );
  assert(link?.tagName === "a", "Expected the summary link to the leaderboard field");
  expect(link.parentNode?.nodeName).toBe("li");
  expect(textOf(link)).toBe(message);
}

describe("Svelte ProfileView renders the leaderboard error", () => {
  it("links the summary to the switch with aria wiring and keeps the submitted choice", () => {
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: LEADERBOARD_ERROR },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: true },
      }),
    );
    const { checkbox, nodes } = leaderboardError(html);
    expectSummaryLink(nodes);
    expect(attr(checkbox, "aria-invalid")).toBe("true");
    expect(attr(checkbox, "aria-describedby")?.split(/\s+/)).toEqual([
      "profile-leaderboard-privacy-help",
      "profile-leaderboard-opt-out-error",
    ]);
    expect(nodes.some((node) => attr(node, "id") === "profile-leaderboard-privacy-help")).toBe(
      true,
    );
    expect(attr(checkbox, "checked")).toBeDefined();
  });

  it("keeps the switch unticked when the submitted choice was false", () => {
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: LEADERBOARD_ERROR },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    const { checkbox } = leaderboardError(html);
    expect(attr(checkbox, "checked")).toBeUndefined();
  });

  it("escapes a hostile leaderboard error instead of interpreting it", () => {
    const hostile = "<script>alert(1)</script>";
    const html = renderView(
      baseProps({
        errors: { leaderboard_opt_out: hostile },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    const { nodes } = leaderboardError(html, hostile);
    expectSummaryLink(nodes, hostile);
    const scripts = nodes.filter((node) => node.tagName === "script");
    expect(scripts.map(textOf)).not.toContain("alert(1)");
  });
});
