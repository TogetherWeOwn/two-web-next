// Builder-owned review regressions: keep the independent exact-event
// acceptance file unchanged. Exercise Kit refusal before any read, the real
// error boundary, and scope removal in both server-rendered viewer twins.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActivityLogPage } from "../src/admin/pages/activity-log";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const causer = "100000000000000111";

describe("Kit exact-event scope: refuse duplicate input before reads", () => {
  it.each([eventKey, "", "   ", null])(
    "refuses duplicate scope with first value %j",
    async (first) => {
      const dbForFn = vi.fn(async () => ({}) as Db);
      const listFn = vi.fn(async () => []);
      const setHeaders = vi.fn();
      await expect(
        loadActivityLogPage({
          env: {} as Env,
          subjectParam: "Alpha",
          causerParam: causer,
          pageParam: "3",
          eventParam: first,
          eventParamCount: 2,
          setHeaders,
          dbForFn,
          listFn,
        }),
      ).rejects.toMatchObject({ status: 422, message: "Invalid event scope" });
      expect(setHeaders).toHaveBeenCalledExactlyOnceWith({ "cache-control": "private, no-store" });
      expect(dbForFn).not.toHaveBeenCalled();
      expect(listFn).not.toHaveBeenCalled();
    },
  );

  it("admits a single valid event scope through the same helper", async () => {
    const db = {} as Db;
    const listFn = vi.fn(async () => []);
    const out = await loadActivityLogPage({
      env: {} as Env,
      subjectParam: null,
      causerParam: null,
      pageParam: null,
      eventParam: eventKey,
      eventParamCount: 1,
      setHeaders: vi.fn(),
      dbForFn: async () => db,
      listFn,
    });
    expect(listFn).toHaveBeenCalledExactlyOnceWith(db, {
      subject: "",
      causer: "",
      page: 1,
      event: eventKey,
    });
    expect(out.query.event).toBe(eventKey);
  });
});

type Render = (data: unknown) => { head: string; body: string };

async function bundleComponent(entry: string, boundary = false): Promise<Render> {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Page from "./${entry}";
        export function renderPage(data) {
          globalThis.__activityScopeErrorPage = data;
          return render(Page, ${boundary ? "{}" : "{ props: { data } }"});
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "activity-scope-regression-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "app-state",
            namespace: "activity-scope-regression",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "activity-scope-regression" }, () => ({
            contents: `export const page = new Proxy({}, {
            get(_, key) { return globalThis.__activityScopeErrorPage[key]; }
          });`,
            loader: "js",
          }));
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
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
    )
  ).renderPage;
}

describe("exact-event scope: rendered recovery", () => {
  let renderError: Render;
  let renderActivity: Render;
  beforeAll(async () => {
    renderError = await bundleComponent("web/src/routes/admin/+error.svelte", true);
    renderActivity = await bundleComponent("web/src/routes/admin/activity-log/+page.svelte");
  });

  function errorState(status: number, routeId = "/admin/activity-log") {
    return {
      status,
      error: { message: "private-<b>failure-canary</b>" },
      url: new URL(`https://example.test${routeId}?event=invalid-canary`),
      route: { id: routeId },
      params: {},
    };
  }

  it("names invalid event scope at 422 with plain-link recovery, never retry advice or raw input", () => {
    const { head, body } = renderError(errorState(422));
    expect(head).toContain("Invalid event scope");
    expect(head).toContain("noindex");
    expect(body).toContain('<h1 id="admin-error-heading">Invalid event scope</h1>');
    expect(body).toContain("Remove the invalid scope.");
    expect(body).toMatch(/href="\/admin\/activity-log"[^>]*>Show all activity<\/a>/);
    expect(body).toContain('aria-label="Administration"');
    expect(body).not.toContain("Try again shortly");
    expect(body).not.toContain("Retry loading");
    expect(body).not.toContain("invalid-canary");
    expect(body).not.toContain("failure-canary");
  });

  it.each([
    [503, "/admin/activity-log", "Admin temporarily unavailable"],
    [500, "/admin/activity-log", "Something went wrong"],
    [422, "/admin/events", "Something went wrong"],
    [404, "/admin/events/missing", "Event not found"],
  ])("keeps status %i on %s distinct", (status, routeId, title) => {
    const { head, body } = renderError(errorState(status as number, routeId as string));
    expect(head).toContain(title as string);
    expect(body).toContain(`<h1 id="admin-error-heading">${title}</h1>`);
    expect(body).not.toContain("Invalid event scope");
    expect(body).not.toContain("failure-canary");
  });

  it.each(["Hono", "Kit"])(
    "%s removal retains subject and causer but drops scope and resets page",
    async (twin) => {
      const data = {
        rows: [],
        query: { subject: "Alpha & Beta", causer, event: eventKey, page: 3 },
        hasNext: true,
      };
      const html =
        twin === "Kit" ? renderActivity(data).body : await ActivityLogPage(data)!.toString();
      const href = html.match(/<a href="([^"]+)"[^>]*>Show all activity<\/a>/)?.[1];
      expect(href).toBeDefined();
      const url = new URL(href!.replaceAll("&amp;", "&"), "https://example.test");
      expect(url.pathname).toBe("/admin/activity-log");
      expect([...url.searchParams.entries()].sort()).toEqual([
        ["causer", causer],
        ["page", "1"],
        ["subject", "Alpha & Beta"],
      ]);
      expect(url.searchParams.has("event")).toBe(false);
    },
  );
});
