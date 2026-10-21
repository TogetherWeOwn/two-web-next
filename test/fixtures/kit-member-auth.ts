// Hermetic Kit dispatch + real Svelte SSR; only the database reads are replaced.
// No auth-status prop or controller is injected by this fixture.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import type { AccessEntry } from "../../src/access-log";
import type { Db } from "../../src/db/index";
import { kitAuthStatusCookieFor, kitSessionBridge, type KitLocals } from "../../src/kit-session";
import { loadMembersBoardData } from "../../src/kit-members";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../../src/member-reads";
import { resolveKitProfile } from "../../src/profiles/kit";
import { dispatchHookRequest, ROUTE_MANIFEST, type HookEventLike } from "../../src/route-ownership";
import { MEMBER, recoveryFixture } from "./session-recovery";

export { MEMBER, SECRET } from "./session-recovery";
export const OTHER = "100000000000000002";
export const BOARD = "/leaderboards/members";
export const SELF = "/profile?edit=1";
export const OTHER_PROFILE = `/members/${OTHER}`;
const root = fileURLToPath(new URL("../../", import.meta.url));
type Data = Record<string, unknown>;
export type MemberAuthRenderers = {
  board: (data: Data) => string;
  profile: (data: Data) => string;
  other: (data: Data) => string;
  admin: () => string;
  dispose: () => void;
};

export async function memberAuthRenderers(): Promise<MemberAuthRenderers> {
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "kit-member-auth-",
    ),
  );
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const admin = join(scratch, "Admin.svelte");
  writeFileSync(
    admin,
    `<script>import Shell from ${JSON.stringify(join(root, "web/src/lib/AdminShell.svelte"))};</script><Shell title="Fixture"><h1>Moderator control</h1></Shell>`,
  );
  const entry = join(scratch, "render.mjs");
  writeFileSync(
    entry,
    `
import { render } from 'svelte/server';
import Board from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
import Profile from ${JSON.stringify(join(root, "web/src/routes/profile/+page.svelte"))};
import Other from ${JSON.stringify(join(root, "web/src/routes/members/[user]/+page.svelte"))};
import Admin from ${JSON.stringify(admin)};
function documentFor(component, props) {
  const { head, body } = render(component, { props });
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">' + head + '</head><body>' + body + '</body></html>';
}
export const board = data => documentFor(Board, { data });
export const profile = data => documentFor(Profile, { data });
export const other = data => documentFor(Other, { data });
export const admin = () => documentFor(Admin, {});
`,
  );
  const outfile = join(scratch, "rendered.mjs");
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: root,
      logLevel: "warning",
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "member-auth-real-svelte",
          setup(plugin) {
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
    const rendered = await import(pathToFileURL(outfile).href);
    return { ...rendered, dispose: () => rmSync(scratch, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export function kitMemberAuthFixture(
  render: MemberAuthRenderers,
  origin = "https://next.example.test",
) {
  const clock = { offset: 0 };
  const f = recoveryFixture(origin, {}, () => Date.now() + clock.offset);
  const audit: AccessEntry[] = [];
  const state = { auditFails: false, readsFail: false, rendered: 0, sessionReads: 0 };
  const sessionFor = kitSessionBridge(f.env);
  const authStatusCookieFor = kitAuthStatusCookieFor(f.env);

  async function request(
    path: string,
    init: RequestInit = {},
    variant: "document" | "fragment" | "json" = "document",
  ) {
    const url = new URL(path, f.env.APP_URL);
    if (["/auth/status", "/logout", "/auth/recover"].includes(url.pathname))
      return f.request(path, init);
    const isBoard = url.pathname === BOARD;
    const isProfile = url.pathname === "/profile" || url.pathname.startsWith("/members/");
    const isAdmin = url.pathname === "/admin";
    const request = new Request(url, init);
    const event: HookEventLike = {
      request,
      url,
      route: {
        id: isBoard
          ? BOARD
          : url.pathname === "/profile"
            ? "/profile"
            : isProfile
              ? "/members/[user]"
              : url.pathname,
      },
    };
    return dispatchHookRequest(event, {
      appUrl: f.env.APP_URL,
      // Held profile/admin twins only: never mutate the shipped manifest or claim a rollout.
      ...(isProfile || isAdmin
        ? {
            manifest: ROUTE_MANIFEST.map((entry) =>
              ["/profile", "/members/:user", "/admin"].includes(entry.path)
                ? { ...entry, enabled: true }
                : entry,
            ),
          }
        : {}),
      honoFetch: async () =>
        new Response("Hono fallback", { headers: { "x-fixture-fallback": "1" } }),
      sessionFor: async (hookEvent) => {
        state.sessionReads++;
        return sessionFor(hookEvent);
      },
      authStatusCookieFor,
      accessSink: async () => async (entry) => {
        if (state.auditFails) throw new Error("fixture audit unavailable");
        audit.push(entry);
        return true;
      },
      resolve: async (hookEvent) => {
        state.rendered++;
        const locals = hookEvent.locals as KitLocals;
        const headers = new Headers({ "content-type": "text/html" });
        let html: string;
        try {
          if (isBoard) {
            const data = await loadMembersBoardData({
              env: f.env,
              session: {
                status: locals.status,
                userId: locals.session?.userId ?? null,
                username: locals.session?.username,
                member: locals.session?.member ?? false,
              },
              seasonParam: url.searchParams.get("season"),
              scopeParam: url.searchParams.get("scope"),
              activityParam: url.searchParams.get("activity"),
              setHeaders: (values) => {
                for (const [name, value] of Object.entries(values)) headers.set(name, value);
              },
              dbForFn: async () => ({}) as Db,
              loadRankingFn: async () =>
                keyedMemberRead(async () => {
                  memberQueryPermit();
                  if (state.readsFail)
                    throw Object.assign(new Error("fixture read unavailable"), { status: 503 });
                  declareMemberResult([MEMBER, OTHER]);
                  return [
                    { userId: MEMBER, username: "Fixture member", count: 4, rank: 1 },
                    { userId: OTHER, username: "Other member", count: 2, rank: 2 },
                  ];
                }),
            });
            html = render.board(data);
          } else if (isProfile) {
            const outcome = await resolveKitProfile(
              {
                session: locals,
                requestedId:
                  url.pathname === "/profile"
                    ? (locals.session?.userId ?? null)
                    : url.pathname.split("/").at(-1)!,
                joinResult: locals.joinResult,
              },
              { store: state.readsFail ? null : f.profiles },
            );
            if (outcome.kind !== "ok") {
              const status = { redirect: 302, unavailable: 503, forbidden: 403, notFound: 404 }[
                outcome.kind
              ];
              return new Response("Profile refused", {
                status,
                headers: {
                  "content-type": "text/html",
                  ...(outcome.kind === "redirect" ? { location: outcome.location } : {}),
                },
              });
            }
            headers.set("cache-control", "private, no-store");
            const data = { ...outcome, appUrl: f.env.APP_URL };
            html = url.pathname === "/profile" ? render.profile(data) : render.other(data);
          } else if (isAdmin) {
            if (locals?.status !== "authenticated" || !locals.session?.moderator)
              return new Response("Forbidden", { status: 403 });
            declareMemberResult([]);
            html = render.admin();
          } else {
            html =
              "<!doctype html><html><head><title>Public control</title></head><body>Public control</body></html>";
          }
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (!status) throw error;
          return new Response("Member document refused", {
            status,
            headers: {
              "content-type": "text/html",
              ...(status === 302 ? { location: "/auth/discord" } : {}),
            },
          });
        }
        if (variant === "json") {
          headers.set("content-type", "application/json");
          html = '{"ok":true}';
        }
        if (variant === "fragment") html = "<section>Member fragment</section>";
        return new Response(request.method === "HEAD" ? null : html, { headers });
      },
    });
  }
  return { ...f, referenceRequest: f.request, profileState: f.state, clock, request, audit, state };
}
