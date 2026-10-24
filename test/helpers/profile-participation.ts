// Synthetic route fixtures shared by the participation acceptance cases.
// Keep the real admission, audited read, render and shared Hono write paths.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { AccessEntry } from "../../src/access-log";
import type { Env } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";
import { resolveKitProfile } from "../../src/profiles/kit";
import { profilesApp } from "../../src/profiles/routes";
import { createMemoryProfileStore } from "../../src/profiles/store";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const OWNER = "100000000000000001";
export const VIEWER = "100000000000000002";
export const ORIGIN = "https://next.example.test";
export type Presentation = "new owner" | "completed owner" | "other member" | "moderator";
export type Renderer = "Hono" | "Kit";
const SECRET = "test-session-secret-at-least-32-bytes-long";
export const FIXED_NOW = new Date("2026-10-20T12:00:00Z");

let compiled: Promise<(props: Record<string, unknown>) => string> | undefined;
function compileView() {
  compiled ??= (async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler");
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "profile-participation-",
      ),
    );
    try {
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "view.mjs");
      writeFileSync(
        entry,
        `import { render } from "svelte/server";
import View from ${JSON.stringify(join(root, "web/src/lib/ProfileView.svelte"))};
export function renderView(props) {
 const { body, head } = render(View, { props });
 return '<!doctype html><html lang="en"><head>' + head + '</head><body>' + body + '</body></html>';
}`,
      );
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        tsconfigRaw: {},
        absWorkingDir: root,
        nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
        plugins: [
          {
            name: "participation-real-svelte",
            setup(plugin) {
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
      return (await import(pathToFileURL(outfile).href)).renderView;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return compiled;
}

type LoadCookies = {
  get: (name: string) => string | undefined;
  set: (name: string, value: string, options?: Record<string, unknown>) => void;
};
type LoadEvent = {
  locals: KitLocals;
  params: { user: string };
  // Current Kit loads read url.href unconditionally; the cookies stub covers
  // the intended-cookie branch. Old loads ignore the extra keys. The hook
  // event's URL type, not the node:url import shadowed above.
  url: HookEventLike["url"];
  cookies: LoadCookies;
  setHeaders: (headers: Record<string, string>) => void;
};
type LoadSeam = {
  resolveKitProfile: typeof resolveKitProfile;
  storeFor: () => Promise<ReturnType<typeof createMemoryProfileStore>>;
  statsFor: (id: string) => Promise<null>;
  // No-attendance twin: the participation matrix never seeds events, so the
  // history section stays hidden and these renders pin the history-free bytes.
  historyFor: (id: string) => Promise<null>;
};
type Loader = (event: LoadEvent, seam: LoadSeam) => Promise<Record<string, unknown>>;
const loaders = new Map<boolean, Promise<Loader>>();
function compileLoader(own: boolean): Promise<Loader> {
  let pending = loaders.get(own);
  if (!pending) {
    pending = (async () => {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const route = own ? "profile" : "members/[user]";
      const result = await build({
        stdin: {
          contents: `import { load } from ${JSON.stringify(join(root, `web/src/routes/${route}/+page.server.ts`))};
import { configure } from "acceptance:profile-deps";
export async function runLoad(event, seam) { configure(seam); return load(event); }`,
          resolveDir: root,
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        tsconfigRaw: {},
        plugins: [
          {
            name: "profile-load-externals",
            setup(plugin) {
              plugin.onResolve(
                {
                  filter:
                    /(?:profiles\/kit$|^acceptance:profile-deps$|^@sveltejs\/kit$|^cloudflare:workers$)/,
                },
                (args) => ({
                  path: args.path.includes("profiles/kit") ? "acceptance:profile-deps" : args.path,
                  namespace: "participation",
                }),
              );
              plugin.onLoad({ filter: /.*/, namespace: "participation" }, (args) => ({
                contents:
                  args.path === "@sveltejs/kit"
                    ? `export function error(status,message){throw new Response(message,{status})}; export function redirect(status,location){throw new Response(null,{status,headers:{location}})};`
                    : args.path === "cloudflare:workers"
                      ? `export const env={APP_URL:${JSON.stringify(ORIGIN)}};`
                      : `let seam; export function configure(value){seam=value}; export function kitProfileDeps(){return seam}; export function resolveKitProfile(...args){return seam.resolveKitProfile(...args)};`,
                loader: "js",
              }));
            },
          },
        ],
      });
      return (
        await import(
          `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
        )
      ).runLoad;
    })();
    loaders.set(own, pending);
  }
  return pending;
}

export async function participationFixture(
  presentation: Presentation,
  options: { auditOk?: boolean; member?: boolean; guest?: boolean } = {},
) {
  const isOwner = presentation.endsWith("owner");
  const userId = isOwner ? OWNER : VIEWER;
  const session = {
    userId,
    username: "Private viewer marker",
    avatar: null,
    member: options.member ?? true,
    moderator: presentation === "moderator",
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
  const store = createMemoryProfileStore([
    {
      id: OWNER,
      username: "Fixture member",
      avatar: null,
      bio: presentation === "completed owner" ? "A member who likes board games." : null,
      games: presentation === "completed owner" ? ["Chess"] : [],
      timezone: presentation === "completed owner" ? "Europe/London" : null,
      leaderboardOptOut: true,
    },
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
  const audit: AccessEntry[] = [];
  const accessLog = async (entry: AccessEntry) => {
    audit.push(entry);
    return options.auditOk ?? true;
  };
  const app = profilesApp({
    sessionStore: sessions,
    store: countedStore,
    accessLog,
    throttle: async () => ({ limited: false }),
  });
  const env = { APP_URL: ORIGIN, SESSION_SECRET: SECRET } as Env;
  const path = isOwner ? "/profile" : `/members/${OWNER}`;
  const locals: KitLocals = {
    ...(options.guest
      ? { status: "guest" as const, session: null }
      : {
          status: "authenticated" as const,
          session,
        }),
    joinResult: null,
    returnTo: null,
    expiredWrite: null,
  };
  const statsReads: string[] = [];
  const renderKit = async (event: HookEventLike) => {
    const load = await compileLoader(event.url.pathname === "/profile");
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    try {
      const props = await load(
        {
          locals: event.locals as KitLocals,
          params: { user: event.url.pathname.split("/")[2]! },
          url: event.url,
          cookies: { get: () => undefined, set: () => {} },
          setHeaders: (values) => {
            for (const [key, value] of Object.entries(values)) headers.set(key, value);
          },
        },
        {
          // One real resolver instance shares the dispatch audit context.
          resolveKitProfile,
          storeFor: async () => countedStore,
          statsFor: async (id) => {
            statsReads.push(id);
            return null;
          },
          historyFor: async () => null,
        },
      );
      const render = await compileView();
      return new Response(render(props), { headers });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };
  async function request(renderer: Renderer, input: string = path, init: RequestInit = {}) {
    const url = new URL(input, ORIGIN);
    const req = new Request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
    });
    const rememberSession = (response: Response) => {
      // Replay the real rotated pair, not the stale initial bearer. Browser
      // cookie expiry uses wall time even when its JavaScript clock is fixed.
      const rotated = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-two_session="));
      if (rotated) cookie = rotated.split(";")[0]!;
      return response;
    };
    if (renderer === "Hono") return rememberSession(await app.request(req, undefined, env));
    const deps: HookDispatchDeps = {
      appUrl: ORIGIN,
      manifest: ROUTE_MANIFEST.map((entry) =>
        entry.path === "/profile" || entry.path === "/members/:user"
          ? { ...entry, enabled: true }
          : entry,
      ),
      sessionFor: async () => locals,
      accessSink: async () => accessLog,
      resolve: renderKit,
      // Mutations retain their real Hono owner. No Kit-only write endpoint.
      honoFetch: async (request) => app.request(request, undefined, env),
    };
    return rememberSession(
      await dispatchHookRequest(
        {
          request: req,
          url,
          route: { id: url.pathname === "/profile" ? "/profile" : "/members/[user]" },
        },
        deps,
      ),
    );
  }
  return { request, path, cookie, operations, statsReads, audit, store, app };
}

export async function navigationLinks(html: string) {
  const primary = html.match(/<nav\b[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? "";
  const matches = [...primary.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
  // Read parser text tokens, never a regex-rewritten HTML fragment. Text remains
  // serialized (including entities), as in the existing navigation assertions.
  const parser = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-09-29",
      outboundService: async () => {
        throw new Error("External network forbidden in label parser");
      },
      script: `export default {
        async fetch(request) {
          const labels = [];
          for (const fragment of await request.json()) {
            let text = "";
            const parsed = new HTMLRewriter().onDocument({
              text(chunk) { text += chunk.text; }
            }).transform(new Response(fragment));
            await parsed.text();
            labels.push(text.trim());
          }
          return Response.json(labels);
        }
      };`,
    }),
  );
  try {
    const response = await parser.dispatchFetch("https://label.example.test", {
      method: "POST",
      body: JSON.stringify(matches.map((match) => match[2]!)),
    });
    const labels = (await response.json()) as string[];
    return matches.map((match, index) => ({
      href: match[1]!.match(/\bhref="([^"]*)"/)?.[1],
      label: labels[index]!,
      attributes: match[1]!,
    }));
  } finally {
    await parser.dispose();
  }
}
