// Kit error request correlation: every Kit 403/429/500/503 page shows the
// request's support reference in Hono copy conventions, and the serving
// response carries the same value as x-request-id.
//
// Failing-first acceptance. Hono renders supportReference from the request id
// (src/error-responses.tsx) but the Kit boundary renders ErrorShell with only
// code + invite (web/src/routes/+error.svelte), and x-request-id is set by
// Hono middleware only (src/request-log.ts) with zero references in
// src/route-ownership.ts. The Builder threads the validated id through the
// Kit dispatch (header + render exposure) and the Svelte boundary (page data
// + ErrorShell prop); these tests pin each link. Hermetic: local fixtures
// only, no database, no network.
//
// The Svelte shells cannot be imported by the root suite (web/tsconfig.json
// extends the SvelteKit-generated config), so ErrorShell is compiled with the
// web workspace's svelte/compiler and bundled by esbuild — the same harness
// shape as test/kit-rsvp-refusal-render.test.ts — and SSR-rendered per
// status. The dispatch half targets dispatchHookRequest directly: the hook
// (web/src/hooks.server.ts) is a pure env binding, so the header and the
// render exposure must live in the tested core.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isFeedPath, negotiateKitError, type KitErrorStatus } from "../src/kit-errors";
import { safeRequestId } from "../src/request-log";
import { dispatchHookRequest, type HookEventLike } from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const HOST = "next.example.test";
const INVITE = "https://discord.gg/fixture-invite";
const RAY = "0123456789abcdef-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ULID_SAMPLE = "01ARYZ6S41AAAAAAAAAAAAAAAA";
const SECRETS = [
  "cookie-secret",
  "bearer-secret",
  "query-secret",
  "198.51.100.42",
  "123456789012345678",
  "private fixture details",
];
const HOSTILE_RAYS = [
  "cookie-secret",
  "0123456789abcdef-IP-secret",
  "123456789012345678",
  '0123456789abcdef-LHR"><b>x</b>',
];

const CORRELATED: KitErrorStatus[] = [403, 429, 500, 503];
const ALL_STATUSES: KitErrorStatus[] = [400, 404, 403, 410, 429, 500, 503];

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type RenderErrorShell = (code: KitErrorStatus, extra?: Record<string, string>) => string;

let renderErrorShell: RenderErrorShell;
// The reference prop the shell declares (Hono calls it supportReference).
// Discovered from source so the render contract accepts the Hono name without
// hard-coding it; when no such prop exists the render still runs and the
// reference assertions below fail.
let referenceProp = "supportReference";

beforeAll(async () => {
  const declared = read("web/src/lib/ErrorShell.svelte").match(/let\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const names = [...declared.matchAll(/([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!);
  referenceProp =
    ["supportReference", "requestId", "reference"].find((name) => names.includes(name)) ??
    names.find((name) => name !== "code" && name !== "inviteUrl") ??
    "supportReference";

  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-error-correlation-"));
  const entry = join(scratch, "kit-error-correlation-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import ErrorShell from ${JSON.stringify(join(worktree, "web/src/lib/ErrorShell.svelte"))};
export function renderErrorShell(code, extra) {
  const { head, body } = render(ErrorShell, { props: { code, inviteUrl: ${JSON.stringify(INVITE)}, ...(extra ?? {}) } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-error-correlation.mjs");
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
        name: "kit-error-correlation-svelte-ssr",
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
  ({ renderErrorShell } = (await import(pathToFileURL(outfile).href)) as {
    renderErrorShell: RenderErrorShell;
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

function referenceOf(html: string): string | null {
  return html.match(/data-testid="error-support-reference">([^<]*)<\/code>/)?.[1] ?? null;
}

function assertNoLeak(html: string) {
  for (const secret of SECRETS) expect(html).not.toContain(secret);
}

// A generated id is a valid ULID the production validator admits. Asserts
// presence first so a missing header fails as an assertion, never as a
// matcher TypeError on null.
function expectGeneratedRequestId(header: string | null) {
  expect(header, "x-request-id is set").toBeTruthy();
  expect(header!).toMatch(ULID);
  expect(safeRequestId(header)).toBe(header);
}

function errorBoundaries(): string[] {
  const routes = resolve(root, "web/src/routes");
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "+error.svelte") found.push(full);
    }
  };
  visit(routes);
  return found.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The boundary passes a per-request reference (Hono's supportReference name,
// or requestId/reference) into ErrorShell, bound to page data — either inline
// or through a value derived from page data. Static strings and echoed failure
// details fail: only page.data carries the dispatch's validated id.
function expectThreadsPageReference(source: string, path: string) {
  const tag =
    source.match(/<ErrorShell[\s\S]*?\/>/)?.[0] ?? source.match(/<ErrorShell[\s\S]*?>/)?.[0] ?? "";
  expect(tag, `${path} renders ErrorShell`).toContain("<ErrorShell");
  const binding = tag.match(/\b(supportReference|requestId|reference)\s*=\s*\{([\s\S]*?)\}/);
  expect(binding?.[0], `${path} passes a reference prop to ErrorShell`).toBeDefined();
  const expr = binding?.[2] ?? "";
  if (expr.includes("page.data")) return;
  const name = escapeRegExp(expr.trim());
  const derived = new RegExp(`\\b${name}\\s*=\\s*\\$derived\\([\\s\\S]*?page\\.data`).test(source);
  const assigned = new RegExp(`(const|let)\\s+${name}\\s*=[\\s\\S]*?page\\.data`).test(source);
  expect(derived || assigned, `${path} binds the ErrorShell reference from page.data`).toBe(true);
}

interface Seen {
  locals?: unknown;
  request?: Request;
}

function kitRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, APP_URL).href, { headers: { host: HOST, ...headers } });
}

// The dispatch must expose the served id to the render before resolve runs —
// Svelte loads read it from locals, so a header set after resolve cannot reach
// the page. Accepts the id under any locals key (exact key is the Builder's
// choice) or on the request resolve receives.
function exposedToRender(seen: Seen, header: string | null): boolean {
  if (!header) return false;
  const locals = seen.locals;
  if (locals && typeof locals === "object" && Object.values(locals).includes(header)) return true;
  return seen.request?.headers.get("x-request-id") === header;
}

async function dispatchKit(
  path: string,
  headers: Record<string, string>,
  status: number,
  contentType = "text/html",
  body = "<html>kit</html>",
) {
  const request = kitRequest(path, headers);
  const event: HookEventLike = { request, url: new URL(request.url), route: { id: "/about" } };
  const seen: Seen = {};
  const resolveFn = vi.fn(async (renderEvent: HookEventLike) => {
    // Shallow snapshot: the id is a top-level string, and later dispatch steps
    // must not be able to backfill what the render saw.
    seen.locals =
      renderEvent.locals && typeof renderEvent.locals === "object"
        ? { ...(renderEvent.locals as Record<string, unknown>) }
        : renderEvent.locals;
    seen.request = renderEvent.request;
    return new Response(body, { status, headers: { "content-type": contentType } });
  });
  const res = await dispatchHookRequest(event, {
    appUrl: APP_URL,
    manifest: [{ method: "GET", path: "/about", enabled: true, reads: "public" }],
    honoFetch: async () => new Response("must not hono", { status: 500 }),
    resolve: resolveFn,
  });
  return { res, seen, resolveFn };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("request correlation fixtures must remain offline");
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kit error shell support-reference markup", () => {
  it("ErrorShell carries the Hono support-reference block, rendered only when a reference exists", () => {
    const shell = read("web/src/lib/ErrorShell.svelte");
    // Hono conventions (src/error-pages.tsx SupportReference): the paragraph
    // class, the visible copy, and the code element carrying the testid.
    expect(shell).toContain("error-support-reference");
    expect(shell).toContain("Support reference");
    expect(shell).toContain("support-reference");
    expect(shell).toContain("<code");
    // Blank-safe by construction: without a reference the block renders nothing.
    expect(shell).toMatch(/\{#if[\s\S]*error-support-reference/);
    // Recovery still offers itself with no session, DB or network reads.
    expect(shell).not.toMatch(/dbFor|getSignedCookie|readSession|fetch\(/);
    expect(shell).not.toContain("{@html");
  });

  it("every error boundary rendering ErrorShell threads a page-derived reference", () => {
    const boundaries = errorBoundaries();
    expect(boundaries.length).toBeGreaterThan(0);
    for (const path of boundaries) {
      const source = readFileSync(path, "utf8");
      if (source.includes("<ErrorShell")) {
        expectThreadsPageReference(source, path);
      } else {
        // A boundary with its own chrome (no shared shell) still owes the
        // reference the moderator guide promises.
        expect(source, `${path} shows a support reference`).toContain("error-support-reference");
      }
    }
  });
});

describe("Kit error shell rendered reference", () => {
  it.each(CORRELATED)("%i shell shows the admitted reference in Hono conventions", (code) => {
    const html = renderErrorShell(code, { [referenceProp]: RAY });
    expect(referenceOf(html)).toBe(RAY);
    expect(html).toContain("Support reference");
    expect(html).toContain('class="support-reference"');
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain(code === 503 ? 'data-testid="error-retry"' : 'data-testid="error-home"');
    expect(html).not.toContain("undefined");
    assertNoLeak(html);
  });

  it("renders a generated ULID reference verbatim", () => {
    expect(ULID_SAMPLE).toMatch(ULID);
    const html = renderErrorShell(500, { [referenceProp]: ULID_SAMPLE });
    expect(referenceOf(html)).toBe(ULID_SAMPLE);
    assertNoLeak(html);
  });

  it("omits the reference block blank-safe when no id exists", () => {
    // Presence first: without the feature this whole contract is unmet.
    expect(referenceOf(renderErrorShell(500, { [referenceProp]: RAY }))).toBe(RAY);
    for (const code of ALL_STATUSES) {
      const html = renderErrorShell(code);
      expect(html, `${code} omits the block`).not.toContain("error-support-reference");
      expect(html, `${code} renders no placeholder`).not.toContain("undefined");
      assertNoLeak(html);
      // Recovery links stay offerable with no id.
      expect(html, `${code} keeps recovery links`).toMatch(/data-testid="error-(home|retry|join)/);
    }
  });
});

describe("Kit dispatch x-request-id", () => {
  it("admits a valid cf-ray as x-request-id and exposes it to the render", async () => {
    const { res, seen, resolveFn } = await dispatchKit("/about", { "cf-ray": RAY }, 200);
    expect(resolveFn).toHaveBeenCalledOnce();
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    expect(safeRequestId(header)).toBe(RAY);
    expect(exposedToRender(seen, header)).toBe(true);
    expect(res.headers.get("x-two-renderer")).toBe("kit");
  });

  it("generates a ULID x-request-id when no cf-ray is sent", async () => {
    const { res, seen } = await dispatchKit("/about", {}, 200);
    const header = res.headers.get("x-request-id");
    expectGeneratedRequestId(header);
    expect(exposedToRender(seen, header)).toBe(true);
  });

  it.each(HOSTILE_RAYS)("replaces hostile cf-ray %s with a generated id", async (ray) => {
    const { res, seen } = await dispatchKit("/about", { "cf-ray": ray }, 200);
    const header = res.headers.get("x-request-id");
    expect(header).not.toBe(ray);
    expectGeneratedRequestId(header);
    expect(exposedToRender(seen, header)).toBe(true);
    expect(await res.text()).not.toContain(ray);
  });

  it("ignores a forged client x-request-id", async () => {
    const { res, seen } = await dispatchKit("/about", { "x-request-id": "client-forged" }, 200);
    const header = res.headers.get("x-request-id");
    expect(header).not.toBe("client-forged");
    expectGeneratedRequestId(header);
    expect(exposedToRender(seen, header)).toBe(true);
  });

  it.each(CORRELATED)("Kit %i responses carry the id the page will show", async (code) => {
    const { res, seen } = await dispatchKit("/about", { "cf-ray": RAY }, code);
    expect(res.status).toBe(code);
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    expect(exposedToRender(seen, header)).toBe(true);
    // The served shell renders exactly this value (pinned above per status).
    expect(referenceOf(renderErrorShell(code, { [referenceProp]: header! }))).toBe(header);
  });

  it("Kit member-read responses carry x-request-id for admin pages", async () => {
    const request = kitRequest("/admin/join-attempts", { "cf-ray": RAY });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin/join-attempts" },
    };
    const seen: Seen = {};
    const res = await dispatchHookRequest(event, {
      appUrl: APP_URL,
      manifest: [
        {
          method: "GET",
          path: "/admin/join-attempts",
          enabled: true,
          reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
        },
      ],
      honoFetch: async () => new Response("must not hono", { status: 500 }),
      resolve: async (renderEvent) => {
        seen.locals = { ...(renderEvent.locals as Record<string, unknown>) };
        seen.request = renderEvent.request;
        return new Response("<html>admin</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      accessSink: async () => async () => true,
    });
    expect(res.status).toBe(200);
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    expect(exposedToRender(seen, header)).toBe(true);
    expect(res.headers.get("x-two-renderer")).toBe("kit");
  });

  it("leaves Hono-fallback responses untouched while Kit responses gain the header", async () => {
    const hostile = new Request(new URL("/about", APP_URL).href, {
      headers: { host: "evil.example" },
    });
    const refused = await dispatchHookRequest(
      { request: hostile, url: new URL(hostile.url), route: { id: "/about" } },
      {
        appUrl: APP_URL,
        honoFetch: async () => new Response("hono-404", { status: 404 }),
        resolve: async () => new Response("must not resolve", { status: 500 }),
      },
    );
    // Hono owns this response (its middleware sets the header in production);
    // the Kit dispatch must neither mark nor tag it.
    expect(refused.headers.get("x-two-renderer")).toBeNull();
    expect(refused.headers.get("x-request-id")).toBeNull();

    const { res } = await dispatchKit("/about", { "cf-ray": RAY }, 200);
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });
});

describe("Kit error contracts unchanged", () => {
  it("feed and machine contracts stay non-HTML while Kit responses gain the header", async () => {
    const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(isFeedPath("/events/abc.ics")).toBe(true);
    expect(
      negotiateKitError(
        new Request("https://next.example.test/events/abc.ics", {
          headers: { accept: browserAccept },
        }),
      ),
    ).toBe("text");
    expect(
      negotiateKitError(
        new Request("https://next.example.test/events", {
          method: "POST",
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe("json");
    expect(negotiateKitError(new Request("https://next.example.test/about"))).toBe("html");

    // Data requests follow their page (still answered by SvelteKit, never the
    // branded shell): only the header is new, the bytes are untouched.
    const payload = '{"type":"data","nodes":[]}';
    const { res } = await dispatchKit(
      "/about/__data.json",
      { "cf-ray": RAY },
      200,
      "application/json",
      payload,
    );
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(payload);

    // The HTML shell gains no JSON envelope: the reference stays page markup.
    const html = renderErrorShell(503, { [referenceProp]: RAY });
    expect(referenceOf(html)).toBe(RAY);
    expect(html).not.toContain('"request_id"');
  });
});
