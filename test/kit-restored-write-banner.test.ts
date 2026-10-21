// Builder suite for the Kit restored-write banner. The paired acceptance
// (test/kit-restored-write-banner-acceptance.test.ts, owned by the Test
// Author and never edited here) pins the bridge discipline and the hook
// consumption journeys; this suite pins the builder's own seams: the shared
// render/consume eligibility gates, the hook's uncacheable-banner headers,
// the read-only oracle's call discipline, the twin banner bytes in every Kit
// shell, and the SSR placement (first inside <main>, ahead of the join
// banner) through the real Svelte views.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aboutPageData } from "../src/about-content";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { isRestoredBannerEligible, type KitLocals } from "../src/kit-session";
import type { MemberView } from "../src/profiles/store";
import {
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";

const BANNER =
  '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';

const APP_URL = "https://next.example.test";
const SECRET = "kit-restored-write-banner-builder-32b";
const ALICE = "100000000000000001";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const pair = async (value: string) =>
  (await serializeSigned(EXPIRED_WRITE_COOKIE, value, SECRET, { path: "/", secure: true })).split(
    ";",
  )[0]!;

const journeyWith = (restoredWrite: string | null): KitLocals => ({
  status: "guest",
  session: null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
  restoredWrite,
});

function eventFor(
  path: string,
  init: { cookie?: string | null; method?: string; headers?: Record<string, string> } = {},
): HookEventLike {
  const request = new Request(new URL(path, APP_URL).href, {
    method: init.method ?? "GET",
    headers: {
      host: "next.example.test",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { request, url: new URL(request.url), route: { id: path } };
}

describe("isRestoredBannerEligible request gates", () => {
  const requestFor = (path: string, headers: Record<string, string> = {}) =>
    new Request(new URL(path, APP_URL).href, { headers });

  it.each(["/about", "/profile", "/events", "/", "/leaderboards/members"])(
    "admits ordinary Kit page %s",
    (path) => {
      expect(isRestoredBannerEligible(requestFor(path))).toBe(true);
    },
  );

  it.each(["/auth/recover", "/auth/discord", "/auth/discord/callback"])(
    "excludes the Hono-parity journey path %s",
    (path) => {
      expect(isRestoredBannerEligible(requestFor(path))).toBe(false);
    },
  );

  it("excludes island fragments, which have no banner slot", () => {
    expect(
      isRestoredBannerEligible(requestFor("/events", { "x-two-island": "events-calendar" })),
    ).toBe(false);
  });

  it("fails closed on an unparseable request URL", () => {
    const malformed = { url: "http://[", headers: new Headers() } as unknown as Request;
    expect(isRestoredBannerEligible(malformed)).toBe(false);
  });
});

describe("hook restored-write consumption headers and oracle discipline", () => {
  const htmlResponse = (headers: Record<string, string> = {}) =>
    new Response("<main><h1>About</h1></main>", {
      headers: { "content-type": "text/html", ...headers },
    });

  it("marks a consumed banner response uncacheable, Hono-parity", async () => {
    const sessionFor = vi.fn(async () => journeyWith("/profile"));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () =>
        htmlResponse({ "cache-control": "public, max-age=3600", vary: "Accept" }),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`))).toBe(
      true,
    );
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
  });

  it("leaves cache headers untouched when the notice stays pending", async () => {
    const sessionFor = vi.fn(async () => journeyWith(null));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () => htmlResponse({ "cache-control": "public, max-age=3600" }),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", { cookie: await pair("pending|/profile") }),
      deps,
    );

    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("vary")).toBeNull();
  });

  it("never consults the oracle without the cookie, even a lying bridge", async () => {
    const sessionFor = vi.fn(async () => journeyWith("/profile"));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(eventFor("/about", { cookie: "unrelated=1" }), deps);

    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("ignores a bridge predating the restoredWrite field", async () => {
    const stale = {
      status: "guest",
      session: null,
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    } as unknown as KitLocals;
    const sessionFor = vi.fn(async () => stale);
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(sessionFor).toHaveBeenCalledOnce();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a throwing oracle preserves the notice instead of failing the render", async () => {
    const sessionFor = vi.fn(async (): Promise<KitLocals> => {
      throw new Error("store down");
    });
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an absent bridge on a public read preserves the notice", async () => {
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("excludes /auth/* even when the oracle would consume", async () => {
    const sessionFor = vi.fn(async () => journeyWith("/profile"));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      manifest: [{ method: "GET", path: "/auth/recover", enabled: true, reads: "public" as const }],
      sessionFor,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(
      eventFor("/auth/recover", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("excludes island fragments even when the oracle would consume", async () => {
    const sessionFor = vi.fn(async () => journeyWith("/profile"));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      resolve: async () =>
        new Response("<div>fragment</div>", { headers: { "content-type": "text/html" } }),
    };
    const res = await dispatchHookRequest(
      eventFor("/about", {
        cookie: await pair("restored|/profile"),
        headers: { "x-two-island": "events-calendar" },
      }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("member reads consume from the bridged locals without a second peek", async () => {
    const sessionFor = vi.fn(
      async (): Promise<KitLocals> => ({
        status: "authenticated",
        session: { userId: ALICE, username: "alice", avatar: null, member: true, moderator: false },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
        restoredWrite: "/profile",
      }),
    );
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      accessSink: async () => async () => true,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(
      eventFor("/leaderboards/members", { cookie: await pair("restored|/profile") }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`))).toBe(
      true,
    );
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    // The pre-resolve bridge only: the render saw these locals, so a fresh
    // post-response peek could only consume a banner the render did not show.
    expect(sessionFor).toHaveBeenCalledOnce();
  });

  it("member reads without the notice never peek twice", async () => {
    const sessionFor = vi.fn(async () => journeyWith(null));
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      sessionFor,
      accessSink: async () => async () => true,
      resolve: async () => htmlResponse(),
    };
    const res = await dispatchHookRequest(eventFor("/leaderboards/members"), deps);

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionFor).toHaveBeenCalledOnce();
  });

  it("member reads consume from preset locals with no bridge at all", async () => {
    const deps: HookDispatchDeps = {
      appUrl: APP_URL,
      honoFetch: async () => new Response("hono"),
      accessSink: async () => async () => true,
      resolve: async () => htmlResponse(),
    };
    const event = eventFor("/leaderboards/members", { cookie: await pair("restored|/profile") });
    event.locals = journeyWith("/profile");
    const res = await dispatchHookRequest(event, deps);

    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`))).toBe(
      true,
    );
  });
});

describe("twin banner bytes across Kit shells", () => {
  it.each([
    "web/src/lib/Shell.svelte",
    "web/src/lib/ProfileView.svelte",
    "web/src/lib/AdminShell.svelte",
    "src/kit-events-html.tsx",
  ])("%s carries the byte-identical banner behind the restoredWrite prop", (rel) => {
    const source = read(rel);
    expect(source).toContain(BANNER);
    expect(source).toContain("restoredWrite");
  });

  it("EventDetail forwards the notice to the shared shell", () => {
    const source = read("web/src/lib/EventDetail.svelte");
    expect(source).toContain("restoredWrite");
    expect(source).toContain("{restoredWrite}");
  });

  it("no Kit page load touches the notice cookie (consumption stays post-release)", () => {
    for (const rel of [
      "web/src/routes/about/+page.server.ts",
      "web/src/routes/faq/+page.server.ts",
      "web/src/routes/profile/+page.server.ts",
      "web/src/routes/members/[user]/+page.server.ts",
      "web/src/routes/+page.server.ts",
      "web/src/routes/join/+page.server.ts",
    ]) {
      const source = read(rel);
      expect(source).not.toContain("EXPIRED_WRITE_COOKIE");
      expect(source).not.toContain("expired_write");
    }
  });
});

describe("restored banner SSR placement", () => {
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };

  async function bundle<Render>(entrySource: (worktree: string) => string): Promise<Render> {
    const worktree = root;
    const scratch = mkdtempSync(join(tmpdir(), "kit-restored-banner-"));
    try {
      const entry = join(scratch, "entry.mjs");
      writeFileSync(entry, entrySource(worktree));
      const outfile = join(scratch, "bundle.mjs");
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
            name: "kit-restored-banner-svelte-ssr",
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
      return (await import(pathToFileURL(outfile).href)) as Render;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  let renderAbout: (data: Record<string, unknown>) => string;
  let renderProfileView: (props: Record<string, unknown>) => string;

  const member: MemberView = {
    id: ALICE,
    username: "alice",
    avatar: null,
    bio: null,
    games: [],
    timezone: null,
  };

  beforeAll(async () => {
    ({ renderAbout } = await bundle<{ renderAbout: typeof renderAbout }>(
      (worktree) => `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/about/+page.svelte"))};
export function renderAbout(data) {
  const { head, body } = render(Page, { props: { data } });
  return head + body;
}
`,
    ));
    ({ renderProfileView } = await bundle<{ renderProfileView: typeof renderProfileView }>(
      (worktree) => `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderProfileView(props) {
  const { body, head } = render(View, { props });
  return head + body;
}
`,
    ));
  }, 120000);

  const aboutData = (restoredWrite: unknown, includeKey = true) => ({
    ...aboutPageData(APP_URL),
    leafCss: LEAF_CRITICAL_CSS,
    ...(includeKey ? { restoredWrite } : {}),
  });

  it("renders the banner bytes first inside <main> on the about page", () => {
    const html = renderAbout(aboutData("/profile"));

    expect(html).toContain(BANNER);
    expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(html.indexOf("<main"));
    expect(html.indexOf('data-testid="auth-error"')).toBeLessThan(
      html.indexOf('data-testid="about-facts"'),
    );
    expect(html).not.toContain("/profile");
  });

  it("renders no banner marker bytes without the notice, null or absent alike", () => {
    const nulled = renderAbout(aboutData(null));
    const absent = renderAbout(aboutData(null, false));

    expect(nulled).not.toContain('data-testid="auth-error"');
    expect(absent).not.toContain('data-testid="auth-error"');
    expect(absent).toBe(nulled);
  });

  it("renders the banner ahead of the join banner on the profile view", () => {
    const html = renderProfileView({
      member,
      stats: null,
      isOwner: true,
      isModerator: false,
      appUrl: APP_URL,
      joinResult: "added",
      restoredWrite: "/profile",
    });

    expect(html).toContain(BANNER);
    const main = html.indexOf("<main");
    expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(main);
    expect(html.indexOf('data-testid="auth-error"')).toBeLessThan(
      html.indexOf('data-testid="join-result"'),
    );
    expect(html).toContain('data-testid="join-result"');
  });

  it("renders no banner on the profile view without the notice", () => {
    const html = renderProfileView({
      member,
      stats: null,
      isOwner: true,
      isModerator: false,
      appUrl: APP_URL,
      joinResult: "added",
      restoredWrite: null,
    });

    expect(html).not.toContain('data-testid="auth-error"');
    expect(html).toContain('data-testid="join-result"');
  });
});
