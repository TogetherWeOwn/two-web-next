// Attended-history acceptance fixtures (U3 Test Author owned).
// The paired builder starts from this branch/SHA and never edits this file.
//
// Contract under test: the owner's own `/profile` self-view, on both twins,
// shows an attended-history section — total count plus the most recent
// ATTENDED_HISTORY_LIMIT past nights (title/when/link each). Attended means
// a `going` answer on an ended event whose status is `published` or `past`.
// Excluded: cancelled/draft events, non-going answers (maybe, not_going,
// waitlisted), withdrawn answers (no row), and upcoming answers (not ended).
//
// Both twins run through REAL production wiring against a disposable W15
// schema: the Hono app uses a DB-backed profile store with ADMIN_DB set, and
// the Kit loads are the real +page.server.ts modules with only
// `@sveltejs/kit` and `cloudflare:workers` stubbed (the workers env carries
// the same ADMIN_DB). Whatever bounded read the builder adds must flow
// through that request DB — the stats-seam precedent — so these fixtures
// exercise it with zero test-side reimplementation of the predicate.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import type { AccessEntry } from "../../src/access-log";
import type { EnvWithAdminDb } from "../../src/admin/db";
import { adminSchema, schema } from "../../src/db/index";
import type { Env } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";
import { kitProfileDeps, resolveKitProfile } from "../../src/profiles/kit";
import { profilesApp } from "../../src/profiles/routes";
import { createDbProfileStore } from "../../src/profiles/store";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./member-data-db";

export const OWNER = "100000000000000001";
export const VIEWER = "100000000000000002";
export const EMPTY = "100000000000000003";
export const ORIGIN = "https://next.example.test";
const SECRET = "test-attended-history-secret-at-least-32b";

/** Contract: the self-view history list shows at most this many recent nights. */
export const ATTENDED_HISTORY_LIMIT = 5;

/** Distinctive seed titles; absence assertions match these whole strings. */
export const TITLES = {
  attendedNewest: "Attended Alpha Night",
  attendedSecond: "Attended Beta Night",
  attendedHostile: "Attended <script>alert(1)</script> Night",
  attendedThird: "Attended Gamma Night",
  attendedFourth: "Attended Delta Night",
  attendedFifthShown: "Attended Epsilon Night",
  attendedTruncated: "Attended Zeta Night",
  attendedPastStatus: "Attended Past-Status Night",
  cancelled: "Cancelled Past Night",
  draft: "Draft Past Night",
  maybe: "Maybe Past Night",
  declined: "Declined Past Night",
  waitlisted: "Waitlisted Past Night",
  withdrawn: "Withdrawn Past Night",
  upcomingOne: "Upcoming Future Night",
  upcomingTwo: "Upcoming Tomorrow Night",
  viewerOwn: "Viewer Attended Night",
} as const;

export type Renderer = "Hono" | "Kit";
export type Actor = "owner" | "viewer" | "empty" | "guest" | "outsider";

const ACTOR_ID: Record<Exclude<Actor, "guest">, string> = {
  owner: OWNER,
  viewer: VIEWER,
  empty: EMPTY,
  outsider: "100000000000000004",
};

const dayMs = 86_400_000;
const atDaysAgo = (days: number) => new Date(Date.now() - days * dayMs).toISOString();
const atDaysAhead = (days: number) => new Date(Date.now() + days * dayMs).toISOString();
const plusHours = (iso: string, hours: number) =>
  new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();

type SeedEvent = {
  key: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  answers: { userId: string; status: string }[];
};

/**
 * The attended/withdrawn/cancelled/past/upcoming matrix. Owner attends 8:
 * six published past nights (one hostile-titled), one sharing its start with
 * the fifth (tiebreak: higher id first), and one `past`-status row. Only the
 * five newest render; the count reads 8.
 */
function matrixSeeds(): SeedEvent[] {
  const tieStart = atDaysAgo(20);
  return [
    {
      key: "attended-alpha",
      title: TITLES.attendedNewest,
      startsAt: atDaysAgo(2),
      endsAt: plusHours(atDaysAgo(2), 2),
      status: "published",
      answers: [
        { userId: OWNER, status: "going" },
        { userId: VIEWER, status: "going" },
      ],
    },
    {
      key: "attended-beta",
      title: TITLES.attendedSecond,
      startsAt: atDaysAgo(5),
      endsAt: plusHours(atDaysAgo(5), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "attended-hostile",
      title: TITLES.attendedHostile,
      startsAt: atDaysAgo(8),
      endsAt: plusHours(atDaysAgo(8), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "attended-gamma",
      title: TITLES.attendedThird,
      startsAt: atDaysAgo(12),
      endsAt: plusHours(atDaysAgo(12), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    // Inserted after epsilon with the same start: the id-desc tiebreak keeps
    // delta (shown, 5th) ahead of epsilon (first truncated).
    {
      key: "attended-epsilon",
      title: TITLES.attendedFifthShown,
      startsAt: tieStart,
      endsAt: plusHours(tieStart, 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "attended-delta",
      title: TITLES.attendedFourth,
      startsAt: tieStart,
      endsAt: plusHours(tieStart, 3),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "attended-zeta",
      title: TITLES.attendedTruncated,
      startsAt: atDaysAgo(45),
      endsAt: plusHours(atDaysAgo(45), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "attended-past-status",
      title: TITLES.attendedPastStatus,
      startsAt: atDaysAgo(60),
      endsAt: plusHours(atDaysAgo(60), 2),
      status: "past",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "excluded-cancelled",
      title: TITLES.cancelled,
      startsAt: atDaysAgo(3),
      endsAt: plusHours(atDaysAgo(3), 2),
      status: "cancelled",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "excluded-draft",
      title: TITLES.draft,
      startsAt: atDaysAgo(4),
      endsAt: plusHours(atDaysAgo(4), 2),
      status: "draft",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "excluded-maybe",
      title: TITLES.maybe,
      startsAt: atDaysAgo(6),
      endsAt: plusHours(atDaysAgo(6), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "maybe" }],
    },
    {
      key: "excluded-declined",
      title: TITLES.declined,
      startsAt: atDaysAgo(7),
      endsAt: plusHours(atDaysAgo(7), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "not_going" }],
    },
    {
      key: "excluded-waitlisted",
      title: TITLES.waitlisted,
      startsAt: atDaysAgo(9),
      endsAt: plusHours(atDaysAgo(9), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "waitlisted" }],
    },
    {
      key: "excluded-withdrawn",
      title: TITLES.withdrawn,
      startsAt: atDaysAgo(10),
      endsAt: plusHours(atDaysAgo(10), 2),
      status: "published",
      answers: [],
    },
    {
      key: "excluded-upcoming-one",
      title: TITLES.upcomingOne,
      startsAt: atDaysAhead(1),
      endsAt: plusHours(atDaysAhead(1), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "excluded-upcoming-two",
      title: TITLES.upcomingTwo,
      startsAt: atDaysAhead(3),
      endsAt: plusHours(atDaysAhead(3), 2),
      status: "published",
      answers: [{ userId: OWNER, status: "going" }],
    },
    {
      key: "viewer-own",
      title: TITLES.viewerOwn,
      startsAt: atDaysAgo(15),
      endsAt: plusHours(atDaysAgo(15), 2),
      status: "published",
      answers: [{ userId: VIEWER, status: "going" }],
    },
  ];
}

let compiledView: Promise<(props: Record<string, unknown>) => string> | undefined;
function compileView() {
  compiledView ??= (async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler");
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "attended-history-view-",
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
            name: "attended-real-svelte",
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
  return compiledView;
}

type LoadSeam = {
  resolveKitProfile: typeof resolveKitProfile;
} & ReturnType<typeof kitProfileDeps>;
type Loader = (
  event: {
    locals: KitLocals;
    params: { user: string };
    url: HookEventLike["url"];
    cookies: {
      get: (name: string) => string | undefined;
      set: (name: string, value: string, options?: Record<string, unknown>) => void;
    };
    setHeaders: (headers: Record<string, string>) => void;
  },
  seam: LoadSeam,
) => Promise<Record<string, unknown>>;
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
            name: "attended-load-externals",
            setup(plugin) {
              // profiles/kit resolves to the OUTER realm's seam (never a
              // bundled copy): the member-read boundary's AsyncLocalStorage
              // lives in the outer module instance, so a bundled copy would
              // silently bypass keyed-read permits and audit capture. The
              // seam itself is the REAL kitProfileDeps + resolveKitProfile,
              // so the builder's history wiring flows through untouched.
              plugin.onResolve(
                {
                  filter:
                    /(?:profiles\/kit$|^acceptance:profile-deps$|^@sveltejs\/kit$|^cloudflare:workers$)/,
                },
                (args) => ({
                  path: args.path.includes("profiles/kit") ? "acceptance:profile-deps" : args.path,
                  namespace: "attended",
                }),
              );
              plugin.onLoad({ filter: /.*/, namespace: "attended" }, (args) => ({
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

/**
 * Volatile bytes pinned out of byte-parity comparisons (documented,
 * minimal). Kit additionally strips HTML comments: Svelte SSR emits
 * hydration-anchor comments for every {#if} branch, taken or not, so any
 * conditional section changes other-member comment bytes without changing
 * rendered content. The marker/title absence assertions (run on the raw
 * HTML) still pin non-exposure, including inside comments.
 */
export function normalizeProfileHtml(html: string, renderer: Renderer): string {
  const pinned = html.replace(/(name="formOpenedAt" value=")[^"]+/, "$1<pinned>");
  return renderer === "Kit" ? pinned.replace(/<!--[\s\S]*?-->/g, "") : pinned;
}

export async function createAttendedHistoryHarness() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("Attended-history acceptance needs DATABASE_URL");
  const fixture: MemberDataFixture = await createMemberDataFixture(raw);
  let statements = 0;
  const countedDb = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: {
      logQuery() {
        statements += 1;
      },
    },
  });
  const kitEnv = { APP_URL: ORIGIN, SESSION_SECRET: SECRET, ADMIN_DB: countedDb } as Env & {
    ADMIN_DB: typeof countedDb;
  };
  const honoEnv = { ...kitEnv } as EnvWithAdminDb;

  const sessions = createMemorySessionStore();
  const audit: AccessEntry[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store: createDbProfileStore(countedDb),
    stats: async () => null,
    accessLog: async (entry) => {
      audit.push(entry);
      return true;
    },
    throttle: async () => ({ limited: false }),
  });

  const cookies = new Map<string, string>();
  async function cookieFor(actor: Exclude<Actor, "guest">): Promise<string> {
    const cached = cookies.get(actor);
    if (cached) return cached;
    const userId = ACTOR_ID[actor];
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId,
      username: actor,
      avatar: null,
      member: actor !== "outsider",
      moderator: false,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    cookies.set(actor, cookie);
    return cookie;
  }

  async function seedUsers(): Promise<void> {
    // Fixed created_at keeps the "Joined <month>" line deterministic across runs.
    for (const [id, username] of [
      [OWNER, "owner-member"],
      [VIEWER, "viewer-member"],
      [EMPTY, "empty-member"],
      [ACTOR_ID.outsider, "outsider"],
    ] as const) {
      await fixture.client`
        insert into users (id, username, member, created_at)
        values (${id}, ${username}, ${id !== ACTOR_ID.outsider}, ${"2024-06-15T00:00:00Z"})
        on conflict (id) do nothing`;
    }
    for (const id of [OWNER, VIEWER, EMPTY]) {
      await fixture.client`
        insert into profiles (user_id, bio, games, timezone)
        values (${id}, ${null}, ${JSON.stringify([])}::jsonb, ${null})
        on conflict (user_id) do nothing`;
    }
  }

  async function seedEvents(seeds: SeedEvent[]): Promise<void> {
    for (const seed of seeds) {
      const [row] = await fixture.client<{ id: number }[]>`
        insert into events (event_key, title, starts_at, ends_at, status)
        values (${seed.key}, ${seed.title}, ${seed.startsAt}, ${seed.endsAt}, ${seed.status})
        returning id`;
      for (const answer of seed.answers) {
        await fixture.client`
          insert into rsvps (event_id, user_id, status)
          values (${row!.id}, ${answer.userId}, ${answer.status})`;
      }
    }
  }

  async function reset(): Promise<void> {
    await fixture.reset();
    audit.length = 0;
    statements = 0;
    await seedUsers();
  }

  /** N plain attended nights for the owner (LIMIT flatness probes). */
  async function seedAttendedOnly(n: number): Promise<void> {
    const seeds: SeedEvent[] = [];
    for (let i = 0; i < n; i += 1) {
      const start = atDaysAgo(2 + i * 3);
      seeds.push({
        key: `flat-attended-${i}`,
        title: `Flat Attended Night ${i}`,
        startsAt: start,
        endsAt: plusHours(start, 2),
        status: "published",
        answers: [{ userId: OWNER, status: "going" }],
      });
    }
    await seedEvents(seeds);
  }

  const localsFor = (actor: Actor): KitLocals =>
    actor === "guest"
      ? {
          status: "guest" as const,
          session: null,
          joinResult: null,
          returnTo: null,
          expiredWrite: null,
        }
      : {
          status: "authenticated" as const,
          session: {
            userId: ACTOR_ID[actor],
            username: actor,
            avatar: null,
            member: actor !== "outsider",
            moderator: false,
          },
          joinResult: null,
          returnTo: null,
          expiredWrite: null,
        };

  async function renderKit(event: HookEventLike): Promise<Response> {
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
        // The REAL production deps, outer-realm: the store reads the
        // fixture DB through the counted handle with the boundary's
        // permits and capture intact. Any history wiring the builder
        // adds to kitProfileDeps/resolveKitProfile arrives here as is.
        { ...kitProfileDeps(kitEnv), resolveKitProfile },
      );
      const render = await compileView();
      return new Response(render(props), { headers });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  }

  async function request(
    renderer: Renderer,
    actor: Actor,
    input?: string,
    init: RequestInit = {},
  ): Promise<Response> {
    // Default is the actor's own self-view; pass /members/:id explicitly for
    // other-member views. Guests land on the login bounce from /profile.
    const path = input ?? "/profile";
    const url = new URL(path, ORIGIN);
    const headers = new Headers(init.headers);
    if (actor !== "guest") headers.set("cookie", await cookieFor(actor));
    const req = new Request(url, { ...init, headers });
    if (renderer === "Hono") return app.request(req, undefined, honoEnv);
    const deps: HookDispatchDeps = {
      appUrl: ORIGIN,
      manifest: ROUTE_MANIFEST.map((entry) =>
        entry.path === "/profile" || entry.path === "/members/:user"
          ? { ...entry, enabled: true }
          : entry,
      ),
      sessionFor: async () => localsFor(actor),
      accessSink: async () => async (entry: AccessEntry) => {
        audit.push(entry);
        return true;
      },
      resolve: renderKit,
      honoFetch: async (request) => app.request(request, undefined, honoEnv),
    };
    return dispatchHookRequest(
      {
        request: req,
        url,
        route: { id: url.pathname === "/profile" ? "/profile" : "/members/[user]" },
      },
      deps,
    );
  }

  return {
    fixture,
    countedDb,
    audit,
    statements: () => statements,
    resetStatements: () => {
      statements = 0;
    },
    reset,
    seedMatrix: () => seedEvents(matrixSeeds()),
    seedAttendedOnly,
    request,
    dispose: () => fixture.dispose(),
  };
}

export type AttendedHistoryHarness = Awaited<ReturnType<typeof createAttendedHistoryHarness>>;
