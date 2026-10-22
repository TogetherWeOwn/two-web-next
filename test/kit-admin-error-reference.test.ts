// Builder-owned supplement: admin group error boundary reference threading.
//
// Main's admin boundary (web/src/routes/admin/+error.svelte) arrived after
// this slice's every-boundary pin, which requires each own-chrome boundary to
// carry the support-reference block the moderator guide promises. The merge
// threads page.data.requestId through the new boundary, mirroring the
// join-attempts precedent. The correlation suite pins the block's existence;
// this file renders with the id set and unset, so a neutered derivation
// fails here.
//
// Hermetic: an SSR render of the real admin boundary with a stubbed
// $app/state (the acceptance harness shape, plus page.data). No live
// database, no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const BOUNDARY = "web/src/routes/admin/+error.svelte";

describe("builder: the admin boundary renders the served support reference", () => {
  const CANARY = "canary-<b>7f3a9e</b>-trace";
  const SERVED_ID = "01J9X7Q2M4W0B3D6F8H1K3N5P7";

  type RenderBoundary = (
    status: number,
    message: string,
    data?: { requestId?: string },
  ) => { head: string; body: string };
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
    const worktree = `${root}/`;
    const scratch = mkdtempSync(join(tmpdir(), "kit-admin-error-reference-"));
    const entry = join(scratch, "kit-admin-error-reference-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Boundary from ${JSON.stringify(join(worktree, BOUNDARY))};
export function renderBoundary(status, message, data) {
  globalThis.__kitAdminErrorPage = {
    status,
    error: { message },
    data,
    url: new URL("https://next.example.test/admin"),
    params: {},
    route: { id: "/admin" },
  };
  const { head, body } = render(Boundary);
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-admin-error-reference.mjs");
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
          name: "kit-admin-error-reference-svelte-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
              path: "app-state",
              namespace: "kit-admin-error-builder",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "kit-admin-error-builder" }, () => ({
              contents: `export const page = {
                get status() { return globalThis.__kitAdminErrorPage.status; },
                get error() { return globalThis.__kitAdminErrorPage.error; },
                get data() { return globalThis.__kitAdminErrorPage.data; },
                get url() { return globalThis.__kitAdminErrorPage.url; },
                get params() { return globalThis.__kitAdminErrorPage.params; },
                get route() { return globalThis.__kitAdminErrorPage.route; },
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

  it("renders the served support reference from page data", () => {
    const rendered = requireRender()(503, CANARY, { requestId: SERVED_ID });
    expect(rendered.body, "503 names the outage like Hono").toContain(
      "Admin temporarily unavailable",
    );
    expect(rendered.body, "503 names the served id").toContain(SERVED_ID);
    expect(rendered.body, "503 keeps the reference testid").toContain(
      'data-testid="error-support-reference"',
    );
    expect(rendered.body, "503 keeps the dashboard way back").toContain("Back to the dashboard");
    expect(rendered.body, "503 echoes no failure").not.toContain("canary-");
    expect(rendered.head, "503 stays out of search indexes").toContain("noindex");
  });

  it("renders no reference block without a request id", () => {
    const rendered = requireRender()(503, CANARY);
    expect(rendered.body, "503 without an id renders no block").not.toContain(
      "error-support-reference",
    );
    expect(rendered.body, "503 without an id stays defined").not.toContain("undefined");
  });
});
