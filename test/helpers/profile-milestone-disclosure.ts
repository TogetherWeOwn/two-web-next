// Independent acceptance fixture: real admission, audited reads, Kit loads and
// both renderers; only session/profile storage and the stats transport are local.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import type { AccessEntry } from "../../src/access-log";
import type { Env } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";
import { resolveKitProfile } from "../../src/profiles/kit";
import { profilesApp, type ProfileDeps } from "../../src/profiles/routes";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { dispatchHookRequest, ROUTE_MANIFEST, type HookEventLike } from "../../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const MILESTONE_ORIGIN = "https://profile.example.test";
export const MILESTONE_OWNER = "100000000000000001";
export const MILESTONE_VIEWER = "100000000000000002";
export type MilestoneRenderer = "Hono" | "Kit";
export type MilestoneState =
  | "complete"
  | "truncated"
  | "milestones unavailable"
  | "membership unavailable"
  | "partial";
type Stats = NonNullable<Awaited<ReturnType<NonNullable<ProfileDeps["stats"]>>>>;
const SECRET = "profile-disclosure-local-test-secret-32b";

export function milestoneStats(count: number, state: MilestoneState = "complete"): Stats {
  return {
    joinedAt: state === "membership unavailable" ? null : new Date("2025-01-01T00:00:00Z"),
    tenureDays: state === "membership unavailable" ? null : 637,
    rankKey: state === "membership unavailable" || state === "partial" ? null : "community_regular",
    isCurrentMember: state !== "membership unavailable",
    milestonesTruncated: state === "truncated",
    milestonesUnavailable: state === "milestones unavailable",
    membershipUnavailable: state === "membership unavailable",
    milestones: Array.from({ length: count }, (_, i) => ({
      type: `achievement_${String(i + 1).padStart(3, "0")}`,
      // Rows five and six share a timestamp across the disclosure boundary.
      occurredAt: new Date(Date.UTC(2026, 8, 30 - (i === 5 ? 4 : i), 12)),
      detail: `Loaded milestone ${String(i + 1).padStart(3, "0")} — ${i === 5 ? "long-detail-".repeat(45) : "Chess <script>not executable</script> & friends"}`,
    })),
  };
}

type KitRender = (own: boolean, event: unknown, seam: unknown) => Promise<string>;
let compiled: Promise<KitRender> | undefined;
async function kitRenderer(): Promise<KitRender> {
  compiled ??= (async () => {
    const root = fileURLToPath(new NodeURL("../../", import.meta.url));
    const webRequire = createRequire(new NodeURL("../../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler");
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "milestone-render-",
      ),
    );
    const styles: string[] = [];
    try {
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "render.mjs");
      writeFileSync(
        entry,
        `import { render } from "svelte/server";
import View from ${JSON.stringify(join(root, "web/src/lib/ProfileView.svelte"))};
import { load as ownerLoad } from ${JSON.stringify(join(root, "web/src/routes/profile/+page.server.ts"))};
import { load as memberLoad } from ${JSON.stringify(join(root, "web/src/routes/members/[user]/+page.server.ts"))};
import { configure } from "acceptance:milestone-deps";
export async function renderProfile(own, event, seam) {
  configure(seam);
  const props = await (own ? ownerLoad : memberLoad)(event);
  const { head, body } = render(View, { props });
  return '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">' + head + '</head><body>' + body + '</body></html>';
}`,
      );
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "warning",
        tsconfigRaw: {},
        absWorkingDir: root,
        nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
        plugins: [
          {
            name: "milestone-real-kit-render",
            setup(plugin) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
                const result = compile(readFileSync(args.path, "utf8"), {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                });
                if (result.css?.code) styles.push(result.css.code);
                return { contents: result.js.code, loader: "js", resolveDir: dirname(args.path) };
              });
              plugin.onResolve(
                {
                  filter:
                    /(?:profiles\/kit$|^acceptance:milestone-deps$|^@sveltejs\/kit$|^cloudflare:workers$)/,
                },
                (args) => ({
                  path: args.path.includes("profiles/kit")
                    ? "acceptance:milestone-deps"
                    : args.path,
                  namespace: "milestone",
                }),
              );
              plugin.onLoad({ filter: /.*/, namespace: "milestone" }, (args) => ({
                contents:
                  args.path === "@sveltejs/kit"
                    ? `export function error(status,message){throw new Response(message,{status})} export function redirect(status,location){throw new Response(null,{status,headers:{location}})}`
                    : args.path === "cloudflare:workers"
                      ? `export const env={APP_URL:${JSON.stringify(MILESTONE_ORIGIN)}}`
                      : `let seam; export function configure(value){seam=value} export function kitProfileDeps(){return seam} export function resolveKitProfile(...args){return seam.resolveKitProfile(...args)}`,
                loader: "js",
              }));
            },
          },
        ],
      });
      const { renderProfile } = await import(pathToFileURL(outfile).href);
      return async (own, event, seam) =>
        (await renderProfile(own, event, seam)).replace(
          "</head>",
          `<style>${styles.join("\n")}</style></head>`,
        );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return compiled;
}

export async function milestoneFixture(options: {
  count: number;
  owner?: boolean;
  state?: MilestoneState;
  auditOk?: boolean;
  guest?: boolean;
  member?: boolean;
}) {
  const owner = options.owner ?? true;
  const stats = milestoneStats(options.count, options.state);
  const operations: string[] = [];
  const statsReads: string[] = [];
  const audit: AccessEntry[] = [];
  const store = createMemoryProfileStore([
    {
      id: MILESTONE_OWNER,
      username: "Milestone fixture member",
      avatar: null,
      bio: "Member profile remains editable",
      games: ["Chess"],
      timezone: "UTC",
      leaderboardOptOut: true,
    },
  ]);
  const countedStore = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: unknown[]) => {
            operations.push(`${String(key)}:${args[0]}`);
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  });
  const accessLog = async (entry: AccessEntry) => {
    audit.push(entry);
    return options.auditOk ?? true;
  };
  const statsFor = async (id: string) => {
    statsReads.push(id);
    return stats;
  };
  const session = {
    userId: owner ? MILESTONE_OWNER : MILESTONE_VIEWER,
    username: "Private viewer marker",
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
  const cookie = options.guest
    ? ""
    : (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
  const app = profilesApp({
    sessionStore: sessions,
    store: countedStore,
    stats: statsFor,
    accessLog,
    throttle: async () => ({ limited: false }),
  });
  const env = { APP_URL: MILESTONE_ORIGIN, SESSION_SECRET: SECRET } as Env;
  const path = owner ? "/profile" : `/members/${MILESTONE_OWNER}`;
  const locals: KitLocals = {
    ...(options.guest
      ? { status: "guest" as const, session: null }
      : { status: "authenticated" as const, session }),
    joinResult: null,
    returnTo: null,
    expiredWrite: null,
  };
  async function request(renderer: MilestoneRenderer) {
    const url = new URL(path, MILESTONE_ORIGIN);
    const request = new Request(url, { headers: { cookie } });
    if (renderer === "Hono") return app.request(request, undefined, env);
    return dispatchHookRequest(
      { request, url, route: { id: owner ? "/profile" : "/members/[user]" } },
      {
        appUrl: MILESTONE_ORIGIN,
        manifest: ROUTE_MANIFEST.map((entry) =>
          entry.path === "/profile" || entry.path === "/members/:user"
            ? { ...entry, enabled: true }
            : entry,
        ),
        sessionFor: async () => locals,
        accessSink: async () => accessLog,
        honoFetch: async (req) => app.request(req, undefined, env),
        resolve: async (event: HookEventLike) => {
          try {
            const render = await kitRenderer();
            const html = await render(
              owner,
              {
                locals: event.locals,
                params: { user: MILESTONE_OWNER },
                url: event.url,
                cookies: { get: () => undefined, set: () => {} },
                setHeaders: () => {},
              },
              { resolveKitProfile, storeFor: async () => countedStore, statsFor },
            );
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
          } catch (error) {
            if (error instanceof Response) return error;
            throw error;
          }
        },
      },
    );
  }
  return { request, path, stats, operations, statsReads, audit };
}
