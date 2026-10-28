// Acceptance-owned: run the unchanged route loaders and SSR-compile both real
// pages inside the real root layout. Only the external profile-store/stats
// factory and Cloudflare env are replaced with local fixtures. No sheets are
// injected by this harness. A missing, duplicate, reordered or body-only link
// must fail independently of the passing metadata/read/ownership controls.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KitLocals } from "../src/kit-session";
import type { MemberView } from "../src/profiles/store";
import { decideOwner, ROUTE_MANIFEST } from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const MEMBER_ID = "100000000000000101";
const VIEWER_ID = "100000000000000202";
const SHEETS = ["/styles.css", "/theme.css", "/profile-theme.css"];
const worktree = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type Route = "profile" | "member";
type Rendered = {
  head: string;
  body: string;
  headers: Record<string, string>;
  reads: string[];
  csr: boolean;
};
type RenderRoute = (route: Route, member: MemberView, locals: KitLocals) => Promise<Rendered>;
let renderRoute: RenderRoute;
let layoutCss: string;
let layoutCssIncluded: boolean;

const completed: MemberView = {
  id: MEMBER_ID,
  username: "Fixture Member",
  avatar: null,
  bio: "Chess and community nights.",
  games: ["Chess", "Go"],
  timezone: "Europe/London",
  joinedAt: new Date("2024-06-15T00:00:00Z"),
  leaderboardOptOut: true,
};
const newcomer: MemberView = {
  ...completed,
  username: "New Member",
  bio: null,
  games: [],
  timezone: null,
  leaderboardOptOut: false,
};
const presentations = [
  {
    name: "owner-new",
    member: newcomer,
    owner: true,
    moderator: false,
    title: "New Member — Member profile",
  },
  {
    name: "owner-completed",
    member: completed,
    owner: true,
    moderator: false,
    title: "Fixture Member — Member profile",
  },
  {
    name: "permitted-other-member",
    member: completed,
    owner: false,
    moderator: false,
    title: "Fixture Member — Member profile",
  },
  {
    name: "moderator",
    member: completed,
    owner: false,
    moderator: true,
    title: "Fixture Member — Member profile",
  },
] as const;

// /profile always targets the viewer. For its moderator presentation the
// moderator is therefore also the owner; another member is possible only on
// /members/:user. The table below excludes that impossible /profile case.
const cases = (["profile", "member"] as const).flatMap((route) =>
  presentations
    .filter((presentation) => route === "member" || presentation.name !== "permitted-other-member")
    .map((presentation) => ({
      route,
      ...presentation,
      owner: route === "profile" || presentation.owner,
    })),
);

const localsFor = (owner: boolean, moderator: boolean): KitLocals => ({
  status: "authenticated",
  session: {
    userId: owner ? MEMBER_ID : VIEWER_ID,
    username: "viewer-private-canary",
    avatar: null,
    member: true,
    moderator,
  },
  joinResult: null,
  returnTo: null,
  expiredWrite: null,
  restoredWrite: null,
});

// Parse tags from actual SSR output, never from source or a hand-written page.
const tags = (html: string, tag: string): Record<string, string>[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((match) =>
    Object.fromEntries(
      [...match[1]!.matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g)].map((attr) => [
        attr[1]!,
        attr[2] ?? attr[3] ?? "",
      ]),
    ),
  );
const stylesheetLinks = (html: string) =>
  tags(html, "link").filter((tag) => tag.rel?.split(/\s+/).includes("stylesheet"));

beforeAll(async () => {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "profile-sheets-"),
  );
  try {
    const wrapper = join(scratch, "RouteFixture.svelte");
    writeFileSync(
      wrapper,
      `
<script>
import Layout from ${JSON.stringify(join(worktree, "web/src/routes/+layout.svelte"))};
import Profile from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.svelte"))};
import Member from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.svelte"))};
let { route, data } = $props();
</script>
<Layout>{#if route === "profile"}<Profile {data} />{:else}<Member {data} />{/if}</Layout>
`,
    );
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Wrapper from ${JSON.stringify(wrapper)};
import * as profile from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.server.ts"))};
import * as memberPage from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.server.ts"))};
import { configure, reads } from "acceptance:profile-deps";
export async function renderRoute(route, member, locals) {
  configure(member);
  const page = route === "profile" ? profile : memberPage;
  const headers = {};
  const data = await page.load({
    locals,
    params: { user: member.id },
    url: new URL(route === "profile" ? "/profile" : "/members/" + member.id, ${JSON.stringify(APP_URL)}),
    setHeaders(value) { Object.assign(headers, value); },
  });
  const { head, body } = render(Wrapper, { props: { route, data } });
  return { head, body, headers, reads: [...reads], csr: page.csr };
}
`,
    );
    const outfile = join(scratch, "render.mjs");
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      metafile: true,
      logLevel: "warning",
      absWorkingDir: worktree,
      tsconfig: join(worktree, "tsconfig.json"),
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      plugins: [
        {
          name: "profile-stylesheet-local-route-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "env",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /^acceptance:profile-deps$/ }, () => ({
              path: "deps",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /\/src\/profiles\/kit$/ }, (args) =>
              args.importer.endsWith("+page.server.ts")
                ? { path: "deps", namespace: "fixture" }
                : undefined,
            );
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              resolveDir: worktree,
              contents:
                args.path === "env"
                  ? `export const env = { APP_URL: ${JSON.stringify(APP_URL)} };`
                  : `
export { resolveKitProfile } from ${JSON.stringify(join(worktree, "src/profiles/kit.ts"))};
import { createMemoryProfileStore } from ${JSON.stringify(join(worktree, "src/profiles/store.ts"))};
export const reads = [];
let store;
export function configure(member) {
  reads.length = 0;
  store = createMemoryProfileStore([member]);
}
export function kitProfileDeps() {
  return {
    async storeFor() {
      reads.push("storeFor");
      return { ...store, async find(id) { reads.push("find:" + id); return store.find(id); } };
    },
    async statsFor(id) { reads.push("stats:" + id); return null; },
  };
}
`,
            }));
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    layoutCssIncluded = Object.keys(result.metafile.inputs).some(
      (path) => path === "web/src/app.css",
    );
    layoutCss = readFileSync(join(scratch, "render.css"), "utf8");
    ({ renderRoute } = await import(pathToFileURL(outfile).href));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Profile SSR must not fetch external services");
    }),
  );
}, 120000);
afterAll(() => vi.unstubAllGlobals());

describe.each(cases)(
  "Kit $route / $name stylesheet attachment",
  ({ route, member, owner, moderator, title }) => {
    const render = () => renderRoute(route, member, localsFor(owner, moderator));

    it("attaches each existing profile sheet once in cascade order in the SSR head", async () => {
      const { head, body } = await render();
      const profileSheets = stylesheetLinks(head).filter((tag) => SHEETS.includes(tag.href ?? ""));
      expect(
        profileSheets.map((tag) => tag.href),
        "SSR head profile stylesheet cascade",
      ).toEqual(SHEETS);
      expect(stylesheetLinks(body).filter((tag) => SHEETS.includes(tag.href ?? ""))).toEqual([]);
      expect(stylesheetLinks(head).some((tag) => tag.href === "/theme-tokens.css")).toBe(false);
      for (const sheet of profileSheets) {
        expect(sheet.media === undefined || sheet.media === "all").toBe(true);
        expect(sheet.disabled).toBeUndefined();
      }
    });

    it("preserves the exact profile metadata rather than substituting the generic site head", async () => {
      const { head } = await render();
      expect([...head.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) => match[1])).toEqual([
        title,
      ]);
      const meta = tags(head, "meta");
      for (const tag of [
        { name: "robots", content: "noindex, nofollow" },
        { name: "description", content: "A member of Together We Own." },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Together We Own" },
        { property: "og:url", content: `${APP_URL}/members/${MEMBER_ID}` },
        { property: "og:title", content: title },
        { property: "og:description", content: "A member of Together We Own." },
        { name: "twitter:card", content: "summary" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: "A member of Together We Own." },
      ])
        expect(
          meta.filter((actual) => actual.name === tag.name && actual.property === tag.property),
        ).toEqual([tag]);
      const links = tags(head, "link");
      expect(links.filter((tag) => tag.rel === "canonical")).toEqual([
        { rel: "canonical", href: `${APP_URL}/members/${MEMBER_ID}` },
      ]);
      expect(links.filter((tag) => tag.rel === "alternate")).toEqual([
        {
          rel: "alternate",
          type: "application/rss+xml",
          title: "Together We Own Events",
          href: "/events.rss",
        },
      ]);
    });

    it("preserves native navigation and self-only Hono editor controls", async () => {
      const { body, csr } = await render();
      expect(csr).toBe(false);
      const anchors = tags(body, "a");
      for (const href of ["/", "/profile", "#main"])
        expect(anchors.some((tag) => tag.href === href)).toBe(true);
      // Additional native navigation (including Events) is compatible with this contract.
      for (const anchor of anchors) expect(anchor.href).not.toMatch(/^javascript:/i);
      expect(anchors.some((tag) => tag.href === "/admin")).toBe(moderator);
      expect(tags(body, "form").filter((tag) => tag.action === "/logout")).toEqual([
        expect.objectContaining({ method: "post" }),
      ]);
      const editors = tags(body, "form").filter((tag) => tag["data-testid"] === "profile-form");
      expect(editors).toHaveLength(owner ? 1 : 0);
      if (owner) {
        expect(editors[0]).toMatchObject({ method: "post", action: `/members/${MEMBER_ID}` });
        expect(tags(body, "input")).toContainEqual(
          expect.objectContaining({ type: "hidden", name: "_method", value: "PATCH" }),
        );
        expect(body).toContain('src="/islands/member-profile.js"');
        const panel = tags(body, "section").find(
          (tag) => tag["data-testid"] === "profile-new-member",
        );
        expect(panel).toBeDefined();
        // Svelte renders false/true boolean attributes by omission/presence.
        const rawPanel =
          body.match(/<section\b[^>]*data-testid="profile-new-member"[^>]*>/)?.[0] ?? "";
        expect(/\bhidden(?:[\s=>])/.test(rawPanel)).toBe(member === completed);
      } else {
        expect(body).not.toContain("leaderboard_opt_out");
        expect(body).not.toContain('src="/islands/member-profile.js"');
      }
      expect(body).not.toContain("viewer-private-canary");
      expect(body).toContain(member.username);
    });

    it("keeps the same bounded local reads and private cache policy", async () => {
      const result = await render();
      expect(result.reads).toEqual(
        owner
          ? ["storeFor", `find:${MEMBER_ID}`, `stats:${MEMBER_ID}`]
          : ["storeFor", `find:${MEMBER_ID}`, `stats:${MEMBER_ID}`, `find:${VIEWER_ID}`],
      );
      expect(result.headers).toEqual({ "cache-control": "private, no-store" });
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);

describe("stylesheet-only ownership and token controls", () => {
  it("keeps Kit app.css in the real root layout's CSS bundle", () => {
    expect(layoutCssIncluded).toBe(true);
    expect(layoutCss).toContain(".base-theme");
    expect(layoutCss).toContain("--color-lobby-surface");
  });

  it("leaves profile GET entries disabled and POST/PATCH writes Hono-owned", () => {
    for (const [path, manifestPath] of [
      ["/profile", "/profile"],
      [`/members/${MEMBER_ID}`, "/members/:user"],
    ]) {
      const entry = ROUTE_MANIFEST.find((entry) => entry.path === manifestPath);
      expect(entry).toMatchObject({ enabled: false, method: "GET" });
      for (const method of ["GET", "HEAD", "POST", "PATCH"]) {
        expect(decideOwner(new Request(`${APP_URL}${path}`, { method }))).toBe("hono");
      }
    }
  });
});
