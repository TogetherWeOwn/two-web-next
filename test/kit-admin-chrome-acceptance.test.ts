// Acceptance: Kit admin failures stay inside moderator chrome (K5).
//
// Today six Kit admin loads throw branded 503/404 failures with no
// route-level boundary (dashboard web/src/routes/admin/+page.server.ts,
// events list, event edit, featured list, featured edit, activity-log), so
// they fall through to the public root +error.svelte: the guest ErrorShell
// with "Join with Discord" and "Use the Discord invite instead", outside any
// moderator chrome. A moderator who follows a stale edit bookmark or hits an
// outage is bounced out of admin into member recovery. Only join-attempts
// has an admin-scoped boundary; these six routes have none.
//
// Locked contract (paired Builder satisfies without editing this file):
// - Every route below resolves an admin-scoped +error.svelte by nearest
//   first: one web/src/routes/admin/+error.svelte covering all six (the
//   join-attempts precedent generalized), or per-route boundaries under
//   web/src/routes/admin/. Join-attempts keeps its own more-specific one.
// - Each boundary renders inside AdminShell (noindex travels via it) with a
//   "Back to the dashboard" link; edit routes also carry their list back
//   link ("Back to events" / "Back to featured"). No public recovery
//   anywhere: no join/invite CTAs, no OAuth hrefs, no invite URLs.
// - Outages render the Hono-matching "Admin temporarily unavailable"
//   heading; missing rows render "Event not found" / "Featured content not
//   found"; anything else renders the generic "Something went wrong"
//   fallback (same contract as the join-attempts boundary). Each status
//   renders distinctly. The failure itself is never echoed.
// - The boundary reads no session, database or network merely to offer
//   recovery, and ships no client script: server-rendered links only.
// - SSR harness constraint (same shape as the join-attempt-detail
//   acceptance): the boundary must render under svelte/server with a
//   stubbed $app/state exposing live status/error/url/params/route. A
//   single admin-level boundary branches on page.route.id or page.url for
//   its per-route back links; keep it dependency-free like the
//   join-attempts boundary (AdminShell + $app/state only).
// - Unchanged controls: the layout guard still bounces guests to OAuth and
//   forbids signed non-moderators from the layout load, so refusals still
//   serve from the root boundary (SvelteKit renders a layout failure above
//   the layout: nearest_error_pages walks strictly above the failing node);
//   the root +error.svelte still serves the public shell; each load still
//   throws its paired 404/503; Hono still 404s missing rows in its ErrorPage,
//   503s without a database (dashboard excepted: it degrades to a 200 with
//   widgets omitted), and the hook boundary still releases error
//   renders with their status, private no-store and no audit row.
//
// Hermetic: source pins, SSR renders of the real boundaries with a stubbed
// $app/state, the framework-free hook boundary with stubbed resolve, guard
// unit pins, and the Hono app against memory sessions (plus store spies and
// a fail-if-touched Db double for the missing-event 404). No live database,
// no network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { decideKitAdminGuard } from "../src/admin/kit-guard";
import { getEvent, recordAccess } from "../src/admin/store";
import type { AccessEntry } from "../src/access-log";
import type { Db } from "../src/db/index";
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

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getEvent: vi.fn(),
  recordAccess: vi.fn(),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type ListLink = { href: string; label: string };

type AdminRoute = {
  id: string;
  /** Request path for hook, guard and Hono pins. */
  path: string;
  /** SvelteKit route id handed to the stubbed page. */
  routeId: string;
  /** ROUTE_MANIFEST path for the hook release pins. */
  manifestPath: string;
  /** Nearest-first boundary candidates covering this route. */
  candidates: readonly string[];
  /** Hono-matching 404 heading, or null when the load never 404s. */
  missingHeading: string | null;
  /** List back link, or null when the route is not an edit form. */
  listLink: ListLink | null;
};

type EditRoute = AdminRoute & { missingHeading: string; listLink: ListLink };

const OUTAGE_HEADING = "Admin temporarily unavailable";
const GENERIC_HEADING = "Something went wrong";
const DASHBOARD_LINK: ListLink = { href: "/admin", label: "Back to the dashboard" };

const ROUTES: AdminRoute[] = [
  {
    id: "dashboard",
    path: "/admin",
    routeId: "/admin",
    manifestPath: "/admin",
    candidates: ["web/src/routes/admin/+error.svelte"],
    missingHeading: null,
    listLink: null,
  },
  {
    id: "events list",
    path: "/admin/events",
    routeId: "/admin/events",
    manifestPath: "/admin/events",
    candidates: ["web/src/routes/admin/events/+error.svelte", "web/src/routes/admin/+error.svelte"],
    missingHeading: null,
    listLink: null,
  },
  {
    id: "event edit",
    path: "/admin/events/no-such-key",
    routeId: "/admin/events/[key]",
    manifestPath: "/admin/events/:key",
    candidates: [
      "web/src/routes/admin/events/[key]/+error.svelte",
      "web/src/routes/admin/events/+error.svelte",
      "web/src/routes/admin/+error.svelte",
    ],
    missingHeading: "Event not found",
    listLink: { href: "/admin/events", label: "Back to events" },
  },
  {
    id: "featured list",
    path: "/admin/featured",
    routeId: "/admin/featured",
    manifestPath: "/admin/featured",
    candidates: [
      "web/src/routes/admin/featured/+error.svelte",
      "web/src/routes/admin/+error.svelte",
    ],
    missingHeading: null,
    listLink: null,
  },
  {
    id: "featured edit",
    path: "/admin/featured/999999",
    routeId: "/admin/featured/[id]",
    manifestPath: "/admin/featured/:id",
    candidates: [
      "web/src/routes/admin/featured/[id]/+error.svelte",
      "web/src/routes/admin/featured/+error.svelte",
      "web/src/routes/admin/+error.svelte",
    ],
    missingHeading: "Featured content not found",
    listLink: { href: "/admin/featured", label: "Back to featured" },
  },
  {
    id: "activity log",
    path: "/admin/activity-log",
    routeId: "/admin/activity-log",
    manifestPath: "/admin/activity-log",
    candidates: [
      "web/src/routes/admin/activity-log/+error.svelte",
      "web/src/routes/admin/+error.svelte",
    ],
    missingHeading: null,
    listLink: null,
  },
];

const EDIT_ROUTES: EditRoute[] = ROUTES.filter(
  (r): r is EditRoute => r.missingHeading !== null && r.listLink !== null,
);
const LIST_ROUTES: AdminRoute[] = ROUTES.filter((r) => r.missingHeading === null);

type Boundary = { path: string; source: string };

function findBoundary(route: AdminRoute): Boundary | null {
  for (const candidate of route.candidates) {
    const absolute = join(root, candidate);
    if (existsSync(absolute)) return { path: candidate, source: readFileSync(absolute, "utf8") };
  }
  return null;
}

function requireBoundary(route: AdminRoute): Boundary {
  const found = findBoundary(route);
  if (!found) {
    throw new Error(
      `no admin-scoped +error.svelte covers ${route.id} (looked for ${route.candidates.join(", ")})`,
    );
  }
  return found;
}

// Every public-recovery token the root ErrorShell can render. The href
// pins use the closing quote so /admin/join-attempts never false-positives
// on a "/join" prefix.
const PUBLIC_RECOVERY_TOKENS = [
  "ErrorShell",
  "error-join",
  "error-join-unlock",
  "error-invite",
  "error-home",
  "error-retry",
  "error-events",
  "error-all-events",
  'href="/auth/discord"',
  'href="/join"',
  "FALLBACK_INVITE",
  "inviteUrl",
  "discord.gg",
  "Join with Discord",
  "Join to unlock",
  "Use the Discord invite instead",
  "Back to the homepage",
  "Browse all events",
];

describe("acceptance: an admin error boundary covers every admin route", () => {
  it.each(ROUTES)(
    "$id resolves an admin-scoped +error.svelte (today the root public shell answers)",
    (route) => {
      expect(
        findBoundary(route),
        `expected one of ${route.candidates.join(", ")} to exist`,
      ).not.toBeNull();
    },
  );
});

describe("acceptance: the boundaries render admin chrome, never public recovery", () => {
  it.each(ROUTES)("$id renders inside AdminShell with dashboard recovery", (route) => {
    const { path, source } = requireBoundary(route);
    expect(source, `${path} imports the admin chrome`).toContain("AdminShell.svelte");
    expect(source, `${path} renders the admin chrome`).toContain("<AdminShell");
    expect(source, `${path} links back to the dashboard`).toContain(
      `href="${DASHBOARD_LINK.href}"`,
    );
    expect(source, `${path} labels the dashboard link`).toContain(DASHBOARD_LINK.label);
    if (route.listLink) {
      expect(source, `${path} links back to the list`).toContain(`href="${route.listLink.href}"`);
      expect(source, `${path} labels the list link`).toContain(route.listLink.label);
    }
  });

  it.each(ROUTES)("$id carries no public recovery tokens", (route) => {
    const { path, source } = requireBoundary(route);
    for (const leaked of PUBLIC_RECOVERY_TOKENS) {
      expect(
        source,
        `${path} must not carry public recovery ${JSON.stringify(leaked)}`,
      ).not.toContain(leaked);
    }
  });

  it.each(ROUTES)("$id handles its statuses distinctly, driven by the thrown status", (route) => {
    const { path, source } = requireBoundary(route);
    expect(source, `${path} reads the thrown status`).toContain("page.status");
    expect(source, `${path} handles the outage 503`).toContain("503");
    expect(source, `${path} names the outage like Hono`).toContain(OUTAGE_HEADING);
    if (route.missingHeading) {
      expect(source, `${path} handles the missing-row 404`).toContain("404");
      expect(source, `${path} names the missing row like Hono`).toContain(route.missingHeading);
    }
    expect(source, `${path} keeps the generic fallback`).toContain(GENERIC_HEADING);
  });

  it.each(ROUTES)("$id is static and read-free: no echo, no reads, no client script", (route) => {
    const { path, source } = requireBoundary(route);
    expect(source, `${path} must not read the thrown failure`).not.toContain("page.error");
    expect(source, `${path} must not interpolate raw HTML`).not.toContain("{@html");
    expect(source, `${path} must not read merely to offer recovery`).not.toMatch(
      /dbFor|getSignedCookie|readSession|SESSION_STORE|cookies\.|fetch\(/,
    );
    expect(source, `${path} ships no client recovery script`).not.toContain("<script src");
    expect(source, `${path} wires no client recovery handler`).not.toMatch(
      /on:click|onClick|addEventListener|islands\//,
    );
  });
});

describe("acceptance: the rendered boundaries keep moderators in admin chrome", () => {
  const CANARY = "canary-<b>7f3a9e</b>-trace";
  const APP_URL = "https://next.example.test";

  type RenderAdminError = (
    status: number,
    message: string,
    url: string,
    routeId: string,
  ) => { head: string; body: string };
  const renderers = new Map<string, RenderAdminError>();
  const resolveErrors = new Map<string, unknown>();
  const buildErrors = new Map<string, unknown>();

  beforeAll(async () => {
    const distinct = new Map<string, string>();
    for (const route of ROUTES) {
      try {
        distinct.set(requireBoundary(route).path, route.id);
      } catch (error) {
        // Stored, not thrown: each render test rethrows it so the missing
        // boundary reads as explicit failures, never silent skips.
        resolveErrors.set(route.id, error);
      }
    }
    await Promise.all(
      [...distinct.keys()].map(async (path) => {
        try {
          renderers.set(path, await buildBoundaryRender(path));
        } catch (error) {
          buildErrors.set(path, error);
        }
      }),
    );
  });

  function renderFor(route: AdminRoute): RenderAdminError {
    const unresolved = resolveErrors.get(route.id);
    if (unresolved) throw unresolved;
    const { path } = requireBoundary(route);
    const failed = buildErrors.get(path);
    if (failed) throw failed;
    const render = renderers.get(path);
    if (!render) throw new Error(`boundary render harness did not initialize for ${route.id}`);
    return render;
  }

  async function buildBoundaryRender(path: string): Promise<RenderAdminError> {
    const worktree = `${root}/`;
    const scratch = mkdtempSync(join(tmpdir(), "kit-admin-chrome-"));
    const entry = join(scratch, "kit-admin-chrome-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Boundary from ${JSON.stringify(join(worktree, path))};
export function renderBoundary(status, message, url, routeId) {
  globalThis.__kitAdminChromePage = {
    status,
    error: { message },
    url: new URL(url),
    params: {},
    route: { id: routeId },
  };
  const { head, body } = render(Boundary);
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-admin-chrome.mjs");
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
          name: "kit-admin-chrome-svelte-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
              path: "app-state",
              namespace: "kit-admin-chrome-acceptance",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "kit-admin-chrome-acceptance" }, () => ({
              // Live getters: each render sets the stub page before rendering,
              // so status/error/url/route follow the case under test.
              contents: `export const page = {
                get status() { return globalThis.__kitAdminChromePage.status; },
                get error() { return globalThis.__kitAdminChromePage.error; },
                get url() { return globalThis.__kitAdminChromePage.url; },
                get params() { return globalThis.__kitAdminChromePage.params; },
                get route() { return globalThis.__kitAdminChromePage.route; },
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
    const { renderBoundary } = (await import(pathToFileURL(outfile).href)) as {
      renderBoundary: RenderAdminError;
    };
    rmSync(scratch, { recursive: true, force: true });
    return renderBoundary;
  }

  const renderUrl = (route: AdminRoute): string => new URL(route.path, APP_URL).href;

  function dashboardLinkPattern(link: ListLink): RegExp {
    return new RegExp(`<a href="${link.href}">\\s*${link.label}\\s*</a>`);
  }

  function expectAdminChrome(
    rendered: { head: string; body: string },
    label: string,
    route: AdminRoute,
    heading: string,
  ) {
    expect(rendered.body, `${label} brands the admin panel`).toContain("TWO admin");
    expect(rendered.body, `${label} keeps the admin nav`).toContain('aria-label="Administration"');
    expect(rendered.body, `${label} keeps the moderator footer`).toContain("moderators only");
    expect(rendered.body, `${label} links back to the dashboard`).toMatch(
      dashboardLinkPattern(DASHBOARD_LINK),
    );
    if (route.listLink) {
      expect(rendered.body, `${label} links back to the list`).toMatch(
        dashboardLinkPattern(route.listLink),
      );
    } else {
      for (const editRoute of EDIT_ROUTES) {
        expect(
          rendered.body,
          `${label} ${route.id} must not offer ${editRoute.listLink.label} recovery`,
        ).not.toMatch(dashboardLinkPattern(editRoute.listLink));
      }
    }
    expect(rendered.head, `${label} titles the admin panel`).toContain("TWO admin");
    expect(
      rendered.head.match(/<title>[^<]*<\/title>/g),
      `${label} titles the status like Hono`,
    ).toEqual([`<title>${heading} — TWO admin</title>`]);
    expect(rendered.head, `${label} stays out of search indexes`).toContain("noindex");
  }

  function expectNoLeak(rendered: { head: string; body: string }, label: string) {
    expect(rendered.body, `${label} echoes no failure`).not.toContain("canary-");
    for (const leaked of PUBLIC_RECOVERY_TOKENS) {
      // The boundary source carries none of these; the render must not
      // reintroduce them through the chrome either.
      if (leaked === "ErrorShell" || leaked === "FALLBACK_INVITE" || leaked === "inviteUrl")
        continue;
      expect(
        rendered.body,
        `${label} must not leak public recovery ${JSON.stringify(leaked)}`,
      ).not.toContain(leaked);
    }
  }

  it.each(ROUTES)("$id outage: branded 503 in admin chrome with no public CTAs", (route) => {
    const rendered = renderFor(route)(503, CANARY, renderUrl(route), route.routeId);
    expectAdminChrome(rendered, "503", route, OUTAGE_HEADING);
    expectNoLeak(rendered, "503");
    expect(rendered.body, "503 names the outage like Hono").toMatch(
      new RegExp(`<h1[^>]*>${OUTAGE_HEADING}</h1>`),
    );
  });

  it.each(EDIT_ROUTES)(
    "$id missing row: Hono-matching 404 with list + dashboard links",
    (route) => {
      const rendered = renderFor(route)(404, CANARY, renderUrl(route), route.routeId);
      expectAdminChrome(rendered, "404", route, route.missingHeading);
      expectNoLeak(rendered, "404");
      expect(rendered.body, "404 names the missing row like Hono").toMatch(
        new RegExp(`<h1[^>]*>${route.missingHeading}</h1>`),
      );
    },
  );

  it.each(ROUTES)(
    "$id unexpected failure: generic admin-chrome fallback, never the public shell",
    (route) => {
      const rendered = renderFor(route)(500, CANARY, renderUrl(route), route.routeId);
      expectAdminChrome(rendered, "500", route, GENERIC_HEADING);
      expectNoLeak(rendered, "500");
      expect(rendered.body, "500 stays generic").toMatch(/something went wrong/i);
    },
  );

  it.each(EDIT_ROUTES)("$id renders 404, 503 and 500 distinctly", (route) => {
    const render = renderFor(route);
    const bodies = [404, 503, 500].map(
      (status) => render(status, CANARY, renderUrl(route), route.routeId).body,
    );
    expect(new Set(bodies).size, "one static page is not a boundary").toBe(3);
  });

  it.each(LIST_ROUTES)("$id renders 503 and 500 distinctly", (route) => {
    const render = renderFor(route);
    const bodies = [503, 500].map(
      (status) => render(status, CANARY, renderUrl(route), route.routeId).body,
    );
    expect(new Set(bodies).size, "one static page is not a boundary").toBe(2);
  });
});

describe("acceptance: the hook boundary releases error renders with their status and private bytes", () => {
  const APP_URL = "https://next.example.test";
  const VIEWER = "100000000000000101";

  const RELEASE_CASES = ROUTES.flatMap((route) =>
    (route.missingHeading === null ? [503] : [404, 503]).map((status) => ({ route, status })),
  );

  const manifestEntry = (route: AdminRoute): OwnedRoute => {
    const entry = ROUTE_MANIFEST.find((r) => r.path === route.manifestPath);
    expect(entry, `shipped manifest must register ${route.manifestPath}`).toBeDefined();
    return entry!;
  };

  const eventFor = (route: AdminRoute): HookEventLike => {
    const request = new Request(new URL(route.path, APP_URL).href, {
      headers: { host: "next.example.test" },
    });
    return { request, url: new URL(request.url), route: { id: route.routeId } };
  };

  const depsFor = (
    route: AdminRoute,
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
      manifest: [{ ...manifestEntry(route), enabled: true }],
      sessionFor: vi.fn(
        async (): Promise<KitLocals> => ({
          status: "authenticated",
          session: { userId: VIEWER, username: "Mod", avatar: null, member: true, moderator: true },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
          restoredWrite: null,
        }),
      ),
      accessSink: async () => sink,
      sink,
    };
  };

  it.each(RELEASE_CASES)(
    "$route.id $status error render is released with its status, private no-store and the Kit marker",
    async ({ route, status }) => {
      const heading = status === 404 ? (route.missingHeading ?? "Not found") : OUTAGE_HEADING;
      const html = `<main>TWO admin — ${heading}</main>`;
      const { sink, ...deps } = depsFor(route, status, html);
      const res = await dispatchHookRequest(eventFor(route), deps);
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

  it.each(ROUTES)("guest still bounces to OAuth with $path as a safe next", (route) => {
    expect(decideKitAdminGuard({ status: "guest", session: null }, route.path)).toEqual({
      kind: "guest",
      location: `/auth/discord?next=${encodeURIComponent(route.path)}`,
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
        "/admin",
      ),
    ).toEqual({ kind: "forbidden" });
    expect(decideKitAdminGuard({ status: "unknown", session: null }, "/admin")).toEqual({
      kind: "unavailable",
    });
    expect(decideKitAdminGuard(undefined, "/admin")).toEqual({
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

  it("dashboard load still throws the paired 503 the boundary handles", () => {
    const load = read("web/src/routes/admin/+page.server.ts");
    expect(load).toContain("await parent()");
    expect(load).toContain("resolveDashboardWidgets");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
  });

  it("events list load still throws the paired 503 the boundary handles", () => {
    const load = read("web/src/routes/admin/events/+page.server.ts");
    expect(load).toContain("csr = false");
    expect(load).toContain("await parent()");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
    expect(load).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("event edit load still throws the paired 404/503 the boundary handles", () => {
    const load = read("web/src/routes/admin/events/[key]/+page.server.ts");
    expect(load).toContain("csr = false");
    expect(load).toContain("await parent()");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
    expect(load).toContain('error(404, "Event not found")');
    expect(load).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("featured list load still throws the paired 503 the boundary handles", () => {
    const load = read("web/src/routes/admin/featured/+page.server.ts");
    expect(load).toContain("await parent()");
    expect(load).toContain("resolveKitFeaturedList");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
    expect(load).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("featured edit load still throws the paired 404/503 the boundary handles", () => {
    const load = read("web/src/routes/admin/featured/[id]/+page.server.ts");
    expect(load).toContain("csr = false");
    expect(load).toContain("await parent()");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
    expect(load).toContain('error(404, "Featured content not found")');
    expect(load).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("activity-log load still throws the paired 503 the boundary handles", () => {
    const load = read("web/src/routes/admin/activity-log/+page.server.ts");
    expect(load).toContain("csr = false");
    expect(load).toContain("await parent()");
    expect(load).toContain("loadActivityLogPage");
    expect(load).toContain('error(503, "Admin temporarily unavailable")');
  });

  it.each(["/events", "/events/no-such-key", "/featured", "/featured/1", "/activity-log"])(
    "Hono /admin%s still 503s without a database, never a render",
    async (suffix) => {
      const sessions = createMemorySessionStore();
      const cookie = await cookieFor(sessions, MODERATOR);
      const res = await adminApp(sessions).request(suffix, { headers: { cookie } }, env);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("Admin temporarily unavailable");
    },
  );

  it("Hono dashboard still degrades without a database: 200, never the outage copy", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("TWO admin");
    expect(body).not.toContain("Admin temporarily unavailable");
  });

  it("Hono featured edit still 404s a non-canonical id in its own ErrorPage", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request(
      "/featured/not-an-id",
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Featured content not found");
    expect(body).toContain("TWO admin");
    expect(body).toContain("Back to the dashboard");
  });

  it("Hono event edit still 404s a missing row in its own ErrorPage", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    vi.mocked(getEvent).mockResolvedValue(null);
    const res = await adminApp({ sessionStore: sessions, db }).request(
      "/events/01J0000000000000000000000A",
      { headers: { cookie } },
      { ...env, ADMIN_DB: db },
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Event not found");
    expect(body).toContain("TWO admin");
    expect(body).toContain("Back to the dashboard");
    expect(getEvent).toHaveBeenCalledOnce();
    expect(
      dbTouched,
      "the missing row 404s through the store spy, never the database",
    ).not.toHaveBeenCalled();
  });
});

// Any property access is a store read/write the fixture must never perform
// (the getEvent spy above is the only sanctioned store seam).
const dbTouched = vi.fn(() => {
  throw new Error("fixture must not query a DB");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(null);
  vi.mocked(recordAccess).mockResolvedValue(true);
});
