// Test Author owned: no implementation writes. Real Hono handlers and compiled
// Svelte SSR, not source-text pins. Reintroducing a maintenance ETA, a misleading
// homepage label, query reflection, or an unsafe fallback must fail here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { databaseUnavailable, maintenanceHandler } from "../src/errors";
import { FALLBACK_INVITE } from "../src/invite";
import { requestLog } from "../src/request-log";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => {
    js: { code: string };
  };
};
const INVITE = "https://discord.gg/fixture-invite";
const ORIGIN = "https://outage.example.test";
const REQUEST_ID = "fedcba9876543210-LHR";
const ENV = { APP_URL: ORIGIN, DISCORD_INVITE_URL: INVITE } as Env;
const PRIVATE = "PRIVATE_FAILURE_AND_QUERY_MARKER";
let scratch: string;
let renderKit: (status: number, boundary?: boolean) => string;

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "outage-copy-"));
  const state = join(scratch, "state.mjs");
  writeFileSync(
    state,
    `export const page = {
    status: 503, error: { message: ${JSON.stringify(PRIVATE)} }, data: {}, params: {},
    route: { id: null }, state: {}, form: null,
    url: new URL(${JSON.stringify(`${ORIGIN}/events?next=https://evil.example/&q=${PRIVATE}`)})
  };`,
  );
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `
    import { render } from "svelte/server";
    import ErrorShell from ${JSON.stringify(join(ROOT, "web/src/lib/ErrorShell.svelte"))};
    import Boundary from ${JSON.stringify(join(ROOT, "web/src/routes/+error.svelte"))};
    import { page } from ${JSON.stringify(state)};
    export function renderKit(status, boundary = false) {
      page.status = status;
      const { head, body } = render(boundary ? Boundary : ErrorShell, {
        props: boundary ? {} : { code: status, inviteUrl: ${JSON.stringify(INVITE)} }
      });
      return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' + head +
        '</head><body>' + body + '</body></html>';
    }
  `,
  );
  const outfile = join(scratch, "render.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: ROOT,
    // SSR needs no generated Kit tsconfig; aliases are supplied explicitly.
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(ROOT, "web/node_modules"), join(ROOT, "node_modules")],
    alias: { "#lib": join(ROOT, "web/src/lib") },
    plugins: [
      {
        name: "outage-acceptance-real-svelte-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({ path: state }));
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
  ({ renderKit } = await import(pathToFileURL(outfile).href));
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("copy fixtures must remain offline");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function hono503() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requestLog);
  app.get("/503", maintenanceHandler(INVITE));
  return app.request(
    `${ORIGIN}/503?next=https://evil.example/&q=${PRIVATE}`,
    {
      headers: { "cf-ray": REQUEST_ID },
    },
    ENV,
  );
}

function lead(html: string) {
  const match = /<p\b[^>]*class="lead"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  expect(match, "real rendered lead exists").not.toBeNull();
  return (match?.[1] ?? "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function link(html: string, testid: string) {
  const match = new RegExp(`<a\\b([^>]*data-testid="${testid}"[^>]*)>([\\s\\S]*?)<\\/a>`).exec(
    html,
  );
  expect(match, `real ${testid} recovery anchor exists`).not.toBeNull();
  return {
    href: /\bhref="([^"]*)"/.exec(match?.[1] ?? "")?.[1],
    label: (match?.[2] ?? "")
      .replace(/<!--[^]*?-->/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

const RENDERERS = ["Hono", "Kit"] as const;
async function documentFor(renderer: (typeof RENDERERS)[number]) {
  return renderer === "Hono" ? (await hono503()).text() : renderKit(503);
}

describe.each(RENDERERS)("%s 503 recovery", (renderer) => {
  it("lead admits temporary unavailability without inventing maintenance or a recovery deadline", async () => {
    const copy = lead(await documentFor(renderer));
    expect(copy).toMatch(/temporarily unavailable/i);
    expect(copy).not.toMatch(
      /maintenance|\b(?:one|a|1)[ -]minute\b|\bback (?:in|at|within)\b|\bwill (?:return|recover|be back)\b|never closes/i,
    );
  });

  it("the stable homepage anchor names its actual destination instead of promising a retry", async () => {
    const home = link(await documentFor(renderer), "error-retry");
    expect(home.href).toBe("/");
    expect(home.label).toMatch(/(?:back|return|continue|go).*home(?:page)?/i);
    expect(home.label).not.toMatch(/try again|retry/i);
  });

  it("CONTROL: keeps noindex, a single named heading, and explicit safe recovery without automatic retry", async () => {
    const html = await documentFor(renderer);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="error-heading"');
    expect(html).toMatch(/<h1 id="error-heading">[^<]+<\/h1>/);
    expect(link(html, "error-invite")).toEqual({
      href: INVITE,
      label: "Use the Discord invite instead",
    });
    expect(link(html, "error-retry").href).toBe("/");
    expect(html).not.toMatch(/http-equiv="refresh"|PRIVATE_FAILURE_AND_QUERY_MARKER|evil\.example/);
    expect(html).not.toMatch(/<form\b|onload=|onclick=/i);
  });
});

describe("preservation controls", () => {
  it("Hono keeps private/no-store, 503, the support reference and no redirect", async () => {
    const response = await hono503();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain(REQUEST_ID);
  });

  it("Hono negotiated outage still sanitizes an unusable configured invite", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/events", (c) => databaseUnavailable(c));
    const response = await app.request(
      `${ORIGIN}/events`,
      { headers: { accept: "text/html" } },
      {
        ...ENV,
        DISCORD_INVITE_URL: "javascript:alert(1)",
      },
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(link(html, "error-invite").href).toBe(FALLBACK_INVITE);
    expect(html).not.toContain("javascript:");
  });

  it("Kit's real boundary uses the safe invite floor and never echoes the failure or query", () => {
    const html = renderKit(503, true);
    expect(link(html, "error-invite").href).toBe(FALLBACK_INVITE);
    expect(link(html, "error-retry").href).toBe("/");
    expect(html).not.toMatch(/PRIVATE_FAILURE_AND_QUERY_MARKER|evil\.example/);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it.each([
    { code: 400, title: "Check your request" },
    { code: 403, title: "You do not have access to this" },
    { code: 404, title: "We cannot find that page" },
    { code: 410, title: "This page is gone" },
    { code: 429, title: "Slow down a little" },
    { code: 500, title: "Something broke on our side" },
  ])(
    "Kit $code keeps its status-specific heading, noindex and homepage recovery",
    ({ code, title }) => {
      const html = renderKit(code, true);
      expect(html).toContain(`<h1 id="error-heading">${title}</h1>`);
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(link(html, "error-home")).toEqual({ href: "/", label: "Back to the homepage" });
      expect(html).not.toContain(PRIVATE);
    },
  );
});
