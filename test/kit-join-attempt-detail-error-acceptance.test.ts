// Acceptance: Kit join-attempt detail failures stay in admin chrome.
//
// Today the detail load (web/src/routes/admin/join-attempts/[id]/+page.server.ts)
// throws error(404) for a missing/invalid id and error(503) when the database
// is down, and with no +error.svelte under web/src/routes/admin/ both render
// through the ROOT boundary: the public ErrorShell with "Join with Discord"
// and Discord-invite recovery, outside any moderator chrome. A moderator who
// follows a stale detail bookmark or hits an outage is bounced out of admin
// into member recovery.
//
// Locked contract (paired Builder satisfies without editing this file):
// - An admin-scoped +error.svelte covers GET /admin/join-attempts/:id (at the
//   [id] level following the web/src/routes/e/[key]/+error.svelte precedent,
//   or higher under web/src/routes/admin/). It renders inside AdminShell with
//   the list back link, handles the load's 404 and 503 distinctly with branded
//   copy, never echoes the failure or trace identifiers, and reads no session,
//   database or network to offer recovery.
// - The member-read boundary releases those 404/503 renders with their status
//   intact and private, no-store, writing no audit row (an error declares no
//   subjects).
// - Unchanged controls: the layout guard still bounces guests to OAuth and
//   forbids signed non-moderators; the root +error.svelte still serves the
//   public shell; the load still throws the same 404/503; the Hono detail
//   still 404s invalid ids in its ErrorPage and 503s without a database.
//
// Hermetic: source pins, an SSR render of the real boundary (the
// kit-rsvp-refusal-render harness shape) with a stubbed $app/state, the
// framework-free hook boundary with stubbed resolve, and the Hono app against
// memory sessions. No live database, no network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { decideKitAdminGuard } from "../src/admin/kit-guard";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import {
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  type OwnedRoute,
  ROUTE_MANIFEST,
} from "../src/route-ownership";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// Nearest-first: SvelteKit renders the closest +error.svelte above the
// erroring load, so the [id] level wins when present and the admin group
// level covers every admin child otherwise.
const BOUNDARY_CANDIDATES = [
  "web/src/routes/admin/join-attempts/[id]/+error.svelte",
  "web/src/routes/admin/join-attempts/+error.svelte",
  "web/src/routes/admin/+error.svelte",
] as const;

type Boundary = { path: string; source: string };

function findDetailErrorBoundary(): Boundary | null {
  for (const candidate of BOUNDARY_CANDIDATES) {
    const absolute = join(root, candidate);
    if (existsSync(absolute)) return { path: candidate, source: readFileSync(absolute, "utf8") };
  }
  return null;
}

function requireDetailErrorBoundary(): Boundary {
  const found = findDetailErrorBoundary();
  if (!found) {
    throw new Error(
      `no admin-scoped +error.svelte covers GET /admin/join-attempts/:id (looked for ${BOUNDARY_CANDIDATES.join(", ")})`,
    );
  }
  return found;
}

describe("acceptance: an admin error boundary covers the join-attempt detail", () => {
  it("exists under web/src/routes/admin/ (today nothing does, so the root public shell answers)", () => {
    expect(
      findDetailErrorBoundary(),
      `expected one of ${BOUNDARY_CANDIDATES.join(", ")} to exist`,
    ).not.toBeNull();
  });

  it("renders inside AdminShell, never the public ErrorShell or its recovery", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, `${path} imports the admin chrome`).toContain("AdminShell.svelte");
    expect(source, `${path} renders the admin chrome`).toContain("<AdminShell");
    for (const leaked of [
      "ErrorShell",
      "error-join",
      "error-invite",
      "error-home",
      "error-retry",
      "error-events",
      "error-all-events",
      "/auth/discord",
      "FALLBACK_INVITE",
      "discord.gg",
      "Join with Discord",
    ]) {
      expect(
        source,
        `${path} must not carry public recovery ${JSON.stringify(leaked)}`,
      ).not.toContain(leaked);
    }
  });

  it("offers the list back link, like the detail page it replaces", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, path).toContain('href="/admin/join-attempts"');
    expect(source, path).toContain("Back to join attempts");
  });

  it("handles the load's 404 and 503 distinctly, driven by the thrown status", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, `${path} reads the thrown status`).toContain("page.status");
    expect(source, `${path} handles the missing-id 404`).toContain("404");
    expect(source, `${path} handles the outage 503`).toContain("503");
    expect(source, `${path} names the missing attempt`).toMatch(/not found|cannot find|no such/i);
    expect(source, `${path} names the outage`).toMatch(/unavailable|right back/i);
  });

  it("never echoes the failure: no page.error interpolation, no raw HTML", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, `${path} must not read the thrown failure`).not.toContain("page.error");
    expect(source, `${path} must not interpolate raw HTML`).not.toContain("{@html");
  });

  it("reads no session, database or network merely to offer recovery", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, path).not.toMatch(
      /dbFor|getSignedCookie|readSession|SESSION_STORE|cookies\.|fetch\(/,
    );
  });

  it("ships no client recovery script: server-rendered links only", () => {
    const { path, source } = requireDetailErrorBoundary();
    expect(source, path).not.toContain("<script src");
    expect(source, path).not.toMatch(/on:click|onClick|addEventListener|islands\//);
  });
});

describe("acceptance: the rendered boundary keeps moderators in admin chrome", () => {
  const CANARY = "canary-<b>7f3a9e</b>-trace";
  const ADMIN_CHROME = [
    "TWO admin",
    'aria-label="Administration"',
    'href="/admin/join-attempts"',
    "moderators only",
  ];

  type RenderDetailError = (status: number, message: string) => { head: string; body: string };
  let renderDetailError: RenderDetailError | null = null;
  let boundaryError: unknown = null;

  beforeAll(async () => {
    try {
      await initBoundaryRender();
    } catch (error) {
      // Stored, not thrown: each render test rethrows it so the missing
      // boundary reads as explicit failures, never silent skips.
      boundaryError = error;
    }
  });

  function requireRender(): RenderDetailError {
    if (boundaryError) throw boundaryError;
    if (!renderDetailError) throw new Error("boundary render harness did not initialize");
    return renderDetailError;
  }

  async function initBoundaryRender(): Promise<void> {
    const { path } = requireDetailErrorBoundary();
    const worktree = `${root}/`;
    const scratch = mkdtempSync(join(tmpdir(), "kit-join-attempt-detail-error-"));
    const entry = join(scratch, "kit-join-attempt-detail-error-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Boundary from ${JSON.stringify(join(worktree, path))};
export function renderDetailError(status, message) {
  globalThis.__kitDetailErrorPage = {
    status,
    error: { message },
    url: new URL("https://next.example.test/admin/join-attempts/7"),
    params: {},
    route: { id: "/admin/join-attempts/[id]" },
  };
  const { head, body } = render(Boundary);
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-join-attempt-detail-error.mjs");
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
          name: "kit-join-attempt-detail-error-svelte-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
              path: "app-state",
              namespace: "kit-detail-error-acceptance",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "kit-detail-error-acceptance" }, () => ({
              // Live getters: each render sets the stub page before rendering,
              // so status/error/url follow the case under test.
              contents: `export const page = {
                get status() { return globalThis.__kitDetailErrorPage.status; },
                get error() { return globalThis.__kitDetailErrorPage.error; },
                get url() { return globalThis.__kitDetailErrorPage.url; },
                get params() { return globalThis.__kitDetailErrorPage.params; },
                get route() { return globalThis.__kitDetailErrorPage.route; },
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
    ({ renderDetailError } = (await import(pathToFileURL(outfile).href)) as {
      renderDetailError: RenderDetailError;
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

  it("missing id: 404 in admin chrome with the list back link and no public CTAs", () => {
    const rendered = requireRender()(404, CANARY);
    expectAdminChrome(rendered, "404");
    expectNoLeak(rendered, "404");
    expect(rendered.body, "404 names the missing attempt").toMatch(/404|not found|cannot find/i);
  });

  it("database down: branded 503 in admin chrome with no trace identifiers", () => {
    const rendered = requireRender()(503, CANARY);
    expectAdminChrome(rendered, "503");
    expectNoLeak(rendered, "503");
    expect(rendered.body, "503 names the outage").toMatch(/503|unavailable|right back/i);
  });

  it("404 and 503 render distinctly: one static page is not a boundary", () => {
    const render = requireRender();
    const missing = render(404, CANARY);
    const outage = render(503, CANARY);
    expect(missing.body).not.toBe(outage.body);
  });
});

describe("acceptance: the hook boundary releases error renders with their status and private bytes", () => {
  const APP_URL = "https://next.example.test";
  const VIEWER = "100000000000000101";

  const detailEntry = (): OwnedRoute => {
    const entry = ROUTE_MANIFEST.find((r) => r.path === "/admin/join-attempts/:id");
    expect(entry, "shipped manifest must register the join-attempt detail route").toBeDefined();
    return entry!;
  };

  const eventFor = (path: string): HookEventLike => {
    const request = new Request(new URL(path, APP_URL).href, {
      headers: { host: "next.example.test" },
    });
    return { request, url: new URL(request.url), route: { id: "/admin/join-attempts/[id]" } };
  };

  const depsFor = (
    status: number,
    html: string,
  ): HookDispatchDeps & { sink: ReturnType<typeof vi.fn> } => {
    const sink = vi.fn(async (_entry: AccessEntry) => true);
    return {
      appUrl: APP_URL,
      featuredImageHosts: "",
      honoFetch: vi.fn(async () => new Response("hono")),
      // SvelteKit converts the load's thrown error() into exactly this: the
      // boundary's HTML with the thrown status. The audit captures no subjects
      // on an error render, so the release writes no audit row.
      resolve: vi.fn(
        async () => new Response(html, { status, headers: { "content-type": "text/html" } }),
      ),
      manifest: [{ ...detailEntry(), enabled: true }],
      sessionFor: vi.fn(
        async (): Promise<KitLocals> => ({
          status: "authenticated",
          session: { userId: VIEWER, username: "Mod", avatar: null, member: true, moderator: true },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
        }),
      ),
      accessSink: async () => sink,
      sink,
    };
  };

  it.each([
    [404, "<main>TWO admin — Join attempt not found</main>"],
    [503, "<main>TWO admin — Admin temporarily unavailable</main>"],
  ] as const)(
    "a %d error render is released with its status, private no-store and the Kit marker",
    async (status, html) => {
      const { sink, ...deps } = depsFor(status, html);
      const res = await dispatchHookRequest(eventFor("/admin/join-attempts/7"), deps);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
      expect(await res.text()).toBe(html);
      expect(sink, "an error render audits nothing").not.toHaveBeenCalled();
    },
  );
});

describe("controls: guard, root boundary, load pairing and Hono output stay unchanged", () => {
  const read = (p: string): string => readFileSync(join(root, p), "utf8");

  it("guest still bounces to OAuth with the detail page as a safe next", () => {
    expect(
      decideKitAdminGuard({ status: "guest", session: null }, "/admin/join-attempts/7"),
    ).toEqual({
      kind: "guest",
      location: "/auth/discord?next=%2Fadmin%2Fjoin-attempts%2F7",
    });
  });

  it("signed non-moderator is still forbidden and an indeterminate session still refuses to decide", () => {
    expect(
      decideKitAdminGuard(
        {
          status: "authenticated",
          session: {
            userId: "100000000000000201",
            username: "Member",
            avatar: null,
            member: true,
            moderator: false,
          },
        },
        "/admin/join-attempts/7",
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      decideKitAdminGuard({ status: "unknown", session: null }, "/admin/join-attempts/7"),
    ).toEqual({
      kind: "unavailable",
    });
    expect(decideKitAdminGuard(undefined, "/admin/join-attempts/7")).toEqual({
      kind: "unavailable",
    });
  });

  it("admin layout still converts guard decisions to the same 302/403/503 with no session writes", () => {
    const layout = read("web/src/routes/admin/+layout.server.ts");
    expect(layout).toContain("csr = false");
    expect(layout).toContain("decideKitAdminGuard");
    expect(layout).toContain("redirect(302, decision.location)");
    expect(layout).toContain('error(403, "Forbidden")');
    expect(layout).toContain('error(503, "Admin temporarily unavailable")');
    expect(layout).not.toMatch(/cookies\.set|SESSION_STORE|recordAccess/);
  });

  it("root boundary still serves the public shell for every other Kit route", () => {
    const page = read("web/src/routes/+error.svelte");
    expect(page).toContain(
      "const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);",
    );
    // The throttled-admin-write way back and the served support reference
    // both survive the merge; non-admin paths keep the public recovery links.
    expect(page).toContain(
      "<ErrorShell code={status} inviteUrl={FALLBACK_INVITE} supportReference={page.data.requestId} adminBack={adminBack} />",
    );
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toContain("AdminShell");
    expect(page).not.toMatch(/page\.error/);
  });

  it("detail load still throws the paired 404/503 the boundary handles", () => {
    const load = read("web/src/routes/admin/join-attempts/[id]/+page.server.ts");
    expect(load).toContain("await parent()");
    expect(load).toContain('error(404, "Join attempt not found")');
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
    expect(load).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("Hono detail still 404s an invalid id in its own ErrorPage", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request(
      "/join-attempts/not-an-id",
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Join attempt not found");
    expect(body).toContain("TWO admin");
    expect(body).toContain("Back to the dashboard");
  });

  it("Hono detail still 503s without a database, never a render", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request("/join-attempts/7", { headers: { cookie } }, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Admin temporarily unavailable");
  });
});
