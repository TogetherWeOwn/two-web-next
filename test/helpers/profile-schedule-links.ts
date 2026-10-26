// Fresh offline fixture: real profile admission, catalog SQL, route loaders,
// route components and shipped island. Only external stores/env are replaced.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { parse } from "parse5";
import type { AccessEntry } from "../../src/access-log";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";
import { memberReadActive } from "../../src/member-reads";
import { kitProfileDeps, resolveKitProfile } from "../../src/profiles/kit";
import { profilesApp } from "../../src/profiles/routes";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { dispatchHookRequest, ROUTE_MANIFEST, type HookEventLike } from "../../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import { scheduleGameCases, scheduleGameCatalog } from "./profile-schedule-links-cases";

export const SCHEDULE_PROFILE_ORIGIN = "https://next.example.test";
export const SCHEDULE_PROFILE_OWNER = "100000000000000001";
const VIEWER = "100000000000000002";
const SECRET = "test-session-secret-at-least-32-bytes-long";
export type ScheduleProfileRenderer = "Hono" | "Kit";
type Options = {
  own?: boolean;
  ownAlias?: boolean;
  games?: string[];
  catalog?: string[];
  catalogUnavailable?: boolean;
  guest?: boolean;
  member?: boolean;
  auditOk?: boolean;
};
type LoaderEvent = {
  locals: KitLocals;
  params: { user: string };
  url: URL;
  cookies: { get: () => undefined; set: () => void };
  setHeaders: (headers: Record<string, string>) => void;
};
type KitSeam = { deps: () => object; resolveKitProfile: typeof resolveKitProfile };
type KitRender = (event: LoaderEvent, seam: KitSeam) => Promise<string>;
const compiled = new Map<boolean, Promise<KitRender>>();

function kitRenderer(own: boolean): Promise<KitRender> {
  let pending = compiled.get(own);
  if (!pending) {
    pending = (async () => {
      const root = fileURLToPath(new URL("../../", import.meta.url).href);
      const scratch = mkdtempSync(
        join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "profile-game-links-"),
      );
      const route = own ? "profile" : "members/[user]";
      const webRequire = createRequire(new URL("../../web/package.json", import.meta.url).href);
      const { compile } = webRequire("svelte/compiler");
      try {
        const entry = join(scratch, "entry.mjs");
        const outfile = join(scratch, "render.mjs");
        writeFileSync(
          entry,
          `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, `web/src/routes/${route}/+page.svelte`))};
import { load } from ${JSON.stringify(join(root, `web/src/routes/${route}/+page.server.ts`))};
import { configure } from "acceptance:profile-schedule-deps";
export async function renderProfile(event, seam) {
 configure(seam);
 const data = await load(event);
 const { body, head } = render(Page, { props: { data } });
 return '<!doctype html><html lang="en"><head>' + head + '</head><body>' + body + '</body></html>';
}`,
        );
        await build({
          entryPoints: [entry],
          bundle: true,
          platform: "node",
          format: "esm",
          outfile,
          absWorkingDir: root,
          tsconfigRaw: {},
          logLevel: "warning",
          nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
          plugins: [
            {
              name: "profile-schedule-real-routes",
              setup(plugin) {
                plugin.onResolve(
                  {
                    filter:
                      /(?:^acceptance:profile-schedule-deps$|^cloudflare:workers$|^@sveltejs\/kit$)/,
                  },
                  (args) => ({ path: args.path, namespace: "profile-schedule" }),
                );
                plugin.onResolve({ filter: /\/src\/profiles\/kit$/ }, (args) =>
                  args.importer.endsWith("+page.server.ts")
                    ? { path: "acceptance:profile-schedule-deps", namespace: "profile-schedule" }
                    : undefined,
                );
                plugin.onLoad({ filter: /.*/, namespace: "profile-schedule" }, (args) => ({
                  contents:
                    args.path === "cloudflare:workers"
                      ? `export const env={APP_URL:${JSON.stringify(SCHEDULE_PROFILE_ORIGIN)}};`
                      : args.path === "@sveltejs/kit"
                        ? `export function error(status,message){throw new Response(message,{status})}; export function redirect(status,location){throw new Response(null,{status,headers:{location}})};`
                        : `let seam; export function configure(value){seam=value}; export function kitProfileDeps(){return seam.deps()}; export function resolveKitProfile(...args){return seam.resolveKitProfile(...args)};`,
                  loader: "js",
                  resolveDir: root,
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
        return (await import(pathToFileURL(outfile).href)).renderProfile;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })();
    compiled.set(own, pending);
  }
  return pending;
}

export async function profileScheduleFixture(options: Options = {}) {
  const own = options.own ?? false;
  const viewerId = own ? SCHEDULE_PROFILE_OWNER : VIEWER;
  const session = {
    userId: viewerId,
    username: "Fixture viewer",
    avatar: null,
    member: options.member ?? true,
    moderator: false,
  };
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    ...session,
    tokenHash: await hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  let cookie = options.guest
    ? ""
    : (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
  const games = options.games ?? scheduleGameCases.map(({ label }) => label);
  const store = createMemoryProfileStore([
    {
      id: SCHEDULE_PROFILE_OWNER,
      username: "Fixture member",
      avatar: null,
      bio: "Games I enjoy, not a booking.",
      games,
      timezone: "Europe/London",
      leaderboardOptOut: true,
    },
    ...(!own
      ? [
          {
            id: VIEWER,
            username: "Fixture viewer",
            avatar: null,
            bio: null,
            games: ["deep rock galactic", "Unlisted game"],
            timezone: null,
          },
        ]
      : []),
  ]);
  const operations: { method: string; args: unknown[] }[] = [];
  const countedStore = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: unknown[]) => {
            operations.push({ method: String(key), args });
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  });
  const queries: { sql: string; params: unknown[]; active: boolean }[] = [];
  const catalog = options.catalog ?? [...scheduleGameCatalog];
  const db = drizzle(async (sql, params) => {
    // dbFor applies the real memberReadDb adapter, which consumes/validates
    // the permit before this callback. Do not consume a second permit here.
    queries.push({
      sql: sql.replace(/\s+/g, " ").trim(),
      params: [...params],
      active: memberReadActive(),
    });
    if (!/\bfrom "events"(?:\s|$)/i.test(sql))
      throw new Error("Unexpected fixture SQL: only the public events catalog is available");
    if (options.catalogUnavailable) throw new Error("Synthetic catalog unavailable");
    // Do not sort, filter or cap here: the emitted SQL must carry those bounds.
    return { rows: catalog.map((game) => [game]) };
  }) as unknown as Db;
  const env: Env & { ADMIN_DB: Db } = {
    APP_URL: SCHEDULE_PROFILE_ORIGIN,
    SESSION_SECRET: SECRET,
    ADMIN_DB: db,
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_CLIENT_SECRET: "",
    DISCORD_BOT_TOKEN: "",
  };
  const audit: AccessEntry[] = [];
  const accessLog = async (entry: AccessEntry) => {
    audit.push(entry);
    return options.auditOk ?? true;
  };
  const app = profilesApp({
    sessionStore: sessions,
    store: countedStore,
    stats: async () => null,
    accessLog,
    throttle: async () => ({ limited: false }),
  });
  const locals: KitLocals = {
    status: options.guest ? "guest" : "authenticated",
    session: options.guest ? null : session,
    joinResult: null,
    returnTo: null,
    expiredWrite: null,
  };
  const path = own && !options.ownAlias ? "/profile" : `/members/${SCHEDULE_PROFILE_OWNER}`;
  const renderKit = async (event: HookEventLike) => {
    const render = await kitRenderer(event.url.pathname === "/profile");
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    try {
      const html = await render(
        {
          locals: event.locals as KitLocals,
          params: { user: SCHEDULE_PROFILE_OWNER },
          url: event.url,
          cookies: { get: () => undefined, set: () => {} },
          setHeaders(values) {
            for (const [key, value] of Object.entries(values)) headers.set(key, value);
          },
        },
        {
          resolveKitProfile,
          // Keep all production public-read wiring, including additions made by
          // the Builder. Replace only identity-store and stats dependencies.
          deps: () => ({
            ...kitProfileDeps(env),
            storeFor: async () => countedStore,
            statsFor: async () => null,
          }),
        },
      );
      return new Response(html, { headers });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };
  async function request(renderer: ScheduleProfileRenderer, input = path, init: RequestInit = {}) {
    const url = new URL(input, SCHEDULE_PROFILE_ORIGIN);
    const req = new Request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
    });
    const response =
      renderer === "Hono"
        ? await app.request(req, undefined, env)
        : await dispatchHookRequest(
            {
              request: req,
              url,
              route: { id: url.pathname === "/profile" ? "/profile" : "/members/[user]" },
            },
            {
              appUrl: SCHEDULE_PROFILE_ORIGIN,
              manifest: ROUTE_MANIFEST.map((row) =>
                row.path === "/profile" || row.path === "/members/:user"
                  ? { ...row, enabled: true }
                  : row,
              ),
              sessionFor: async () => locals,
              accessSink: async () => accessLog,
              resolve: renderKit,
              honoFetch: async (request) => app.request(request, undefined, env),
            },
          );
    const rotated = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-two_session="));
    if (rotated) cookie = rotated.split(";")[0]!;
    return response;
  }
  return { path, request, queries, operations, audit, store, catalog };
}

type HtmlNode = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
};
function nodes(node: HtmlNode): HtmlNode[] {
  return [node, ...(node.childNodes ?? []).flatMap(nodes)];
}
function attr(node: HtmlNode, name: string) {
  return node.attrs?.find((a) => a.name === name)?.value;
}
function text(node: HtmlNode): string {
  return node.nodeName === "#text"
    ? (node.value ?? "")
    : (node.childNodes ?? []).map(text).join("");
}
export function profileGameItems(html: string) {
  const root = parse(html) as HtmlNode;
  const block = nodes(root).find((node) => attr(node, "data-testid") === "profile-games");
  if (!block) throw new Error("Missing real profile Games block");
  return nodes(block)
    .filter((node) => node.nodeName === "li")
    .map((node) => {
      const descendants = nodes(node);
      const links = descendants.filter((child) => child.nodeName === "a");
      return {
        label: (node.childNodes ?? [])
          .filter((child) => attr(child, "data-testid") !== "profile-shared-marker")
          .map(text)
          .join(""),
        links: links.map((link) => ({ href: attr(link, "href"), label: text(link) })),
        shared: descendants
          .filter((child) => attr(child, "data-testid") === "profile-shared-marker")
          .map(text),
        unsafeTags: descendants
          .filter((child) => ["img", "script", "iframe"].includes(child.nodeName))
          .map((child) => child.nodeName),
      };
    });
}
