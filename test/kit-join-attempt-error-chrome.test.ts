// Builder-owned supplement: Kit join-attempt error chrome gaps.
//
// The acceptance suite (test/kit-join-attempt-detail-error-acceptance.test.ts)
// is Test-Author-owned and must not be edited from this branch. Paperclip
// Review proved two shipped behaviours unpinned there, each with a surviving
// mutant, so this file pins them here instead:
//
// - Fallback branch: the list load rethrows non-database errors and the hook
//   boundary releases them as a 500 through this same +error.svelte. The
//   acceptance renders only 404 and 503, so deleting the {:else} branch (or
//   mislabelling it with outage copy) stays green while a moderator gets an
//   admin page with no heading and an aria-labelledby pointing nowhere.
// - List coverage: the acceptance boundary lookup accepts an [id]-level file
//   first, so moving the boundary down to [id]/+error.svelte stays green
//   while list-load failures silently return to the public root shell. This
//   file only recognises a boundary at the join-attempts level or higher —
//   the placement that covers BOTH routes — so the move mutant fails here.
//
// Hermetic: source pins plus an SSR render of the real list-covering boundary
// with a stubbed $app/state (the acceptance harness shape). No live database,
// no network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// List-covering placements only: SvelteKit renders the closest +error.svelte
// above the erroring load, so an [id]-level file covers the detail route but
// leaves GET /admin/join-attempts on the public root shell. Either of these
// covers both routes.
const LIST_COVERING_CANDIDATES = [
  "web/src/routes/admin/join-attempts/+error.svelte",
  "web/src/routes/admin/+error.svelte",
] as const;

type Boundary = { path: string; source: string };

function findListErrorBoundary(): Boundary | null {
  for (const candidate of LIST_COVERING_CANDIDATES) {
    const absolute = join(root, candidate);
    if (existsSync(absolute)) return { path: candidate, source: readFileSync(absolute, "utf8") };
  }
  return null;
}

function requireListErrorBoundary(): Boundary {
  const found = findListErrorBoundary();
  if (!found) {
    throw new Error(
      `no list-covering +error.svelte (looked for ${LIST_COVERING_CANDIDATES.join(", ")}); an [id]-level file alone leaves GET /admin/join-attempts on the public shell`,
    );
  }
  return found;
}

describe("builder: the error boundary covers the join-attempts list route", () => {
  it("exists at the join-attempts level or higher, never only at [id]", () => {
    expect(
      findListErrorBoundary(),
      `expected one of ${LIST_COVERING_CANDIDATES.join(", ")} to exist`,
    ).not.toBeNull();
  });

  it("renders inside AdminShell with the list back link", () => {
    const { path, source } = requireListErrorBoundary();
    expect(source, `${path} imports the admin chrome`).toContain("AdminShell.svelte");
    expect(source, `${path} renders the admin chrome`).toContain("<AdminShell");
    expect(source, path).toContain('href="/admin/join-attempts"');
    expect(source, path).toContain("Back to join attempts");
  });

  it("keeps a distinct fallback branch for non-404/503 statuses", () => {
    const { path, source } = requireListErrorBoundary();
    expect(source, `${path} keeps the fallback branch`).toContain("{:else}");
    expect(source, `${path} labels the fallback distinctly`).toContain("Something went wrong");
  });
});

describe("builder: the fallback render keeps moderators in admin chrome", () => {
  const CANARY = "canary-<b>7f3a9e</b>-trace";
  const ADMIN_CHROME = [
    "TWO admin",
    'aria-label="Administration"',
    'href="/admin/join-attempts"',
    "moderators only",
  ];

  type RenderBoundary = (status: number, message: string) => { head: string; body: string };
  let renderBoundary: RenderBoundary | null = null;
  let boundaryError: unknown = null;

  beforeAll(async () => {
    try {
      await initBoundaryRender();
    } catch (error) {
      boundaryError = error;
    }
  });

  function requireRender(): RenderBoundary {
    if (boundaryError) throw boundaryError;
    if (!renderBoundary) throw new Error("boundary render harness did not initialize");
    return renderBoundary;
  }

  async function initBoundaryRender(): Promise<void> {
    // Render the LIST-covering boundary: under the [id]-only move mutant this
    // lookup finds nothing and every render test below fails with it.
    const { path } = requireListErrorBoundary();
    const worktree = `${root}/`;
    const scratch = mkdtempSync(join(tmpdir(), "kit-join-attempt-error-chrome-"));
    const entry = join(scratch, "kit-join-attempt-error-chrome-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Boundary from ${JSON.stringify(join(worktree, path))};
export function renderBoundary(status, message) {
  globalThis.__kitListErrorPage = {
    status,
    error: { message },
    url: new URL("https://next.example.test/admin/join-attempts"),
    params: {},
    route: { id: "/admin/join-attempts" },
  };
  const { head, body } = render(Boundary);
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-join-attempt-error-chrome.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-join-attempt-error-chrome-svelte-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
              path: "app-state",
              namespace: "kit-list-error-builder",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "kit-list-error-builder" }, () => ({
              contents: `export const page = {
                get status() { return globalThis.__kitListErrorPage.status; },
                get error() { return globalThis.__kitListErrorPage.error; },
                get url() { return globalThis.__kitListErrorPage.url; },
                get params() { return globalThis.__kitListErrorPage.params; },
                get route() { return globalThis.__kitListErrorPage.route; },
              };`,
              loader: "js",
            }));
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
    ({ renderBoundary } = (await import(pathToFileURL(outfile).href)) as {
      renderBoundary: RenderBoundary;
    });
    rmSync(scratch, { recursive: true, force: true });
  }

  function expectAdminChrome(rendered: { head: string; body: string }, label: string) {
    for (const token of ADMIN_CHROME) {
      expect(rendered.body, `${label} keeps ${JSON.stringify(token)}`).toContain(token);
    }
    expect(rendered.body, `${label} keeps the list back link`).toContain("Back to join attempts");
    expect(rendered.head, `${label} stays out of search indexes`).toContain("noindex");
  }

  function expectNoLeak(rendered: { head: string; body: string }, label: string) {
    expect(rendered.body, `${label} echoes no failure`).not.toContain("canary-");
    expect(rendered.body, `${label} offers no public join CTA`).not.toContain("Join with Discord");
    expect(rendered.body, `${label} offers no invite escape`).not.toContain("discord.gg");
    expect(rendered.body, `${label} bounces nowhere near OAuth`).not.toContain("/auth/discord");
  }

  it("unexpected failure: 500 in admin chrome with the fallback heading and no outage copy", () => {
    const rendered = requireRender()(500, CANARY);
    expectAdminChrome(rendered, "500");
    expectNoLeak(rendered, "500");
    expect(rendered.body, "500 carries the fallback heading").toContain("Something went wrong");
    expect(rendered.body, "500 is not the outage page").not.toContain(
      "Admin temporarily unavailable",
    );
    expect(rendered.body, "500 is not the missing-id page").not.toContain("Join attempt not found");
  });

  it("500 renders distinctly from 404 and 503: one static page is not a boundary", () => {
    const render = requireRender();
    const fallback = render(500, CANARY);
    expect(fallback.body).not.toBe(render(404, CANARY).body);
    expect(fallback.body).not.toBe(render(503, CANARY).body);
  });
});
