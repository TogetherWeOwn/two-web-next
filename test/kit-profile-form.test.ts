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
import { parseFragment } from "parse5";
import { assert, beforeAll, describe, expect, it } from "vitest";
import type { MemberView } from "../src/profiles/store";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

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

function byAttr(nodes: ReturnType<typeof elements>, name: string, value: string) {
  return nodes.find((el) => attr(el, name) === value);
}

const parseView = (html: string) => elements(parseFragment(html));

describe("Kit profile view: 422 re-render keeps the Hono form contract", () => {
  it("renders no error chrome without errors", () => {
    const nodes = parseView(renderView(baseProps()));
    expect(byAttr(nodes, "data-testid", "profile-error")).toBeUndefined();
    expect(byAttr(nodes, "id", "profile-bio-error")).toBeUndefined();
    const bio = byAttr(nodes, "id", "profile-bio");
    assert(bio?.tagName === "textarea");
    expect(attr(bio, "aria-describedby")).toBe("profile-bio-hint profile-bio-count");
  });

  it("renders the error summary with field links and per-field errors with aria wiring", () => {
    const errors = {
      bio: "Keep your bio to 1000 characters or fewer.",
      games: "Add no more than 20 games.",
      timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
    };
    const html = renderView(
      baseProps({
        errors,
        values: { bio: "x", games_text: "a", timezone: "y", leaderboard_opt_out: false },
      }),
    );
    // Summary alert with links into the controls (server `games` maps to games_text).
    const nodes = parseView(html);
    const summary = byAttr(nodes, "data-testid", "profile-error");
    assert(summary);
    expect(attr(summary, "role")).toBe("alert");
    const links = elements(summary).filter((el) => el.tagName === "a");
    // Field errors beside the controls, wired for assistive tech. Timezone
    // keeps its help text associated alongside the error; Bio and Games keep
    // their composition hint and count nodes associated alongside the error.
    for (const [name, message] of Object.entries(errors)) {
      const field = `profile-${name === "games" ? "games-text" : name}`;
      const link = byAttr(links, "href", `#${field}`);
      const control = byAttr(nodes, "id", field);
      const error = byAttr(nodes, "id", `${field}-error`);
      assert(link && control && error);
      expect(textOf(link)).toBe(message);
      expect(attr(control, "aria-invalid")).toBe("true");
      expect(attr(control, "aria-describedby")).toBe(
        field === "profile-timezone"
          ? `profile-timezone-help ${field}-error`
          : `${field}-hint ${field}-count ${field}-error`,
      );
      expect(textOf(error)).toBe(message);
    }
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
    const summary = byAttr(parseView(html), "data-testid", "profile-error");
    assert(summary);
    expect(textOf(summary).trim()).toBe(
      "Only your bio, games, timezone and leaderboard setting can be changed.",
    );
    expect(elements(summary).some((el) => el.tagName === "a")).toBe(false);
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
    const nodes = parseView(html);
    for (const [field, name, value] of [
      ["profile-bio", "bio", "draft bio"],
      ["profile-games-text", "games_text", "draft game"],
    ] as const) {
      const textarea = byAttr(nodes, "id", field);
      assert(textarea);
      expect(textarea.tagName).toBe("textarea");
      expect(attr(textarea, "name")).toBe(name);
      expect(attr(textarea, "rows")).toBe("4");
      expect(attr(textarea, "aria-describedby")).toBe(`${field}-hint ${field}-count`);
      expect(textOf(textarea)).toBe(value);
    }
    const timezone = byAttr(nodes, "id", "profile-timezone");
    assert(timezone?.tagName === "input");
    expect(attr(timezone, "value")).toBe("Mars/Olympus");
  });

  it("renders the leaderboard switch with the submitted choice preserved", () => {
    const checked = renderView(
      baseProps({
        errors: { bio: "bad" },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: true },
      }),
    );
    const unchecked = renderView(baseProps());
    for (const [html, expected] of [
      [checked, true],
      [unchecked, false],
    ] as const) {
      const checkbox = byAttr(parseView(html), "id", "profile-leaderboard-opt-out");
      assert(checkbox?.tagName === "input");
      expect(attr(checkbox, "name")).toBe("leaderboard_opt_out");
      expect(attr(checkbox, "type")).toBe("checkbox");
      expect(attr(checkbox, "checked") !== undefined).toBe(expected);
    }
  });

  it("groups privacy within the native edit form and binds the consequence alongside errors", () => {
    const html = renderView(baseProps({ errors: { leaderboard_opt_out: "Choose hide or show." } }));
    const nodes = parseView(html);
    const identityActions = byAttr(nodes, "data-testid", "profile-identity-actions");
    expect(
      identityActions?.childNodes.some(
        (node) =>
          "tagName" in node && node.tagName === "a" && attr(node, "href") === "#edit-heading",
      ),
    ).toBe(true);
    const form = byAttr(nodes, "data-testid", "profile-form");
    assert(form?.tagName === "form");
    const privacy = byAttr(elements(form), "aria-labelledby", "profile-privacy-heading");
    assert(privacy?.tagName === "section");
    const section = elements(privacy);
    const heading = byAttr(section, "id", "profile-privacy-heading");
    const checkbox = byAttr(section, "id", "profile-leaderboard-opt-out");
    const help = byAttr(section, "id", "profile-leaderboard-privacy-help");
    assert(heading?.tagName === "h3" && checkbox && help);
    expect(textOf(heading)).toBe("Privacy");
    expect(attr(checkbox, "aria-describedby")).toBe(
      "profile-leaderboard-privacy-help profile-leaderboard-opt-out-error",
    );
    expect(textOf(help)).toContain(
      "After you save, hiding removes you from every member leaderboard and its counts.",
    );
  });

  it.each([false, true])(
    "keeps edit and privacy off another member’s profile (moderator: %s)",
    (isModerator) => {
      const nodes = parseView(renderView(baseProps({ isOwner: false, isModerator })));
      expect(byAttr(nodes, "href", "#edit-heading")).toBeUndefined();
      expect(byAttr(nodes, "id", "profile-privacy-heading")).toBeUndefined();
      expect(byAttr(nodes, "name", "leaderboard_opt_out")).toBeUndefined();
    },
  );

  it("carries the island binding contract so the binder owns pending/cancel/focus", () => {
    const html = renderView(baseProps());
    const nodes = parseView(html);
    // Mount point the member-profile.js binder queries, keyed to this member.
    const editor = byAttr(nodes, "data-testid", "profile-edit");
    assert(editor);
    expect(attr(editor, "data-island")).toBe("member-profile");
    expect(attr(editor, "data-member-id")).toBe(MEMBER.id);
    // Unchanged write contract: no-JS posts the PATCH override to Hono, the
    // binder PATCHes JSON to the same route when script runs.
    const form = byAttr(elements(editor), "data-testid", "profile-form");
    assert(form?.tagName === "form");
    expect(attr(form, "action")).toBe(`/members/${MEMBER.id}`);
    const fields = elements(form);
    const method = byAttr(fields, "name", "_method");
    assert(method?.tagName === "input");
    expect(attr(method, "value")).toBe("PATCH");
    // Writable fields plus the spam-trap pair the admission gate requires.
    for (const name of ["bio", "games_text", "timezone", "website", "formOpenedAt"]) {
      expect(byAttr(fields, "name", name)).toBeDefined();
    }
    // Controls the binder and the lifecycle tests address by testid.
    for (const testid of ["profile-save", "profile-cancel"]) {
      expect(byAttr(fields, "data-testid", testid)).toBeDefined();
    }
  });

  it("escapes hostile error and value text instead of interpreting it", () => {
    const hostileError = "<script>alert(1)</script>";
    const hostileBio = "</textarea><img src=x onerror=alert(1)>";
    const html = renderView(
      baseProps({
        errors: { bio: hostileError },
        values: {
          bio: hostileBio,
          games_text: "",
          timezone: "",
          leaderboard_opt_out: false,
        },
      }),
    );
    const nodes = parseView(html);
    const summary = byAttr(nodes, "data-testid", "profile-error");
    const error = byAttr(nodes, "id", "profile-bio-error");
    const bio = byAttr(nodes, "id", "profile-bio");
    assert(summary && error && bio?.tagName === "textarea");
    expect(textOf(summary).trim()).toBe(hostileError);
    expect(textOf(error)).toBe(hostileError);
    expect(textOf(bio)).toBe(hostileBio);
    const scripts = nodes.filter((el) => el.tagName === "script");
    expect(scripts.map(textOf)).not.toContain("alert(1)");
    expect(byAttr(nodes, "src", "x")).toBeUndefined();
  });
});
