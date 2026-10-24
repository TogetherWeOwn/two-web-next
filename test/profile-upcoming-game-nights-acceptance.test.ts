// Acceptance: your upcoming game nights on your profile (S4).
//
// Paired independent tests for the self-profile upcoming section. RED on
// unmodified main: neither renderer has an upcoming section, so every render
// assertion below fails until the paired build lands. The Builder branches
// from this test-only branch and MUST NOT edit this file.
//
// Contract the Builder implements (Hono + Kit, same copy/testids):
// - Own `/profile` self-view renders `<section data-testid="profile-upcoming">`
//   headed exactly "Your upcoming game nights", listing the viewer's own
//   `going` answers plus `waitlisted` answers with their position. Each item
//   carries `data-testid="profile-upcoming-item"`, links its title to
//   `/e/<eventKey>`, shows when in a `<time datetime>`, and shows the venue
//   (location) text. Waitlisted items additionally render the decimal position
//   in `data-testid="profile-upcoming-position"` next to the word "Waitlist"
//   (case-insensitive; exact surrounding copy is the Builder's choice).
// - Items are soonest-first by starts_at (SQL ORDER BY, id tie-break). The
//   read is ONE statement capped at PROFILE_UPCOMING_LIMIT (10, pinned here):
//   seed 12 upcoming and exactly the soonest 10 render.
// - Excluded: cancelled events, past (ended) events, and the viewer's own
//   `maybe` / `not_going` answers. The ongoing edge (started, not ended) is
//   deliberately unpinned; matching the feed scope (ends_at >= now) is
//   suggested. Null-location rendering is the Builder's choice.
// - Empty state: the section and heading still render, with
//   `data-testid="profile-upcoming-empty"` linking to `/events`.
// - Strictly self-only: other-member `/members/[user]` never renders the
//   section (byte-identical with or without viewer upcoming rows), guests keep
//   the 302 bounce, non-members the 403, and the audit-failure 503 is
//   unchanged. Other-member reads still audit exactly one row; own reads
//   (profile + upcoming) stay unaudited. Cache stays private, no-store.
// - Seam (recommended, mirrors the stats wiring): add
//   `upcoming?: (memberId: string) => Promise<UpcomingGameNight[]>` to
//   ProfileDeps, resolve it in profileStores (default: one joined SELECT of
//   own answers + published upcoming, LIMIT 10, position via the existing
//   waitlist window helper), pass rows to ProfilePage, and mirror through
//   kitProfileDeps/resolveKitProfile into the Kit loads + ProfileView. Fetch
//   only when viewer == member: other-member/guest/non-member/audit-failure
//   paths must not call it.
// - position for `going` rows is null; waitlisted rows carry the 1-based FIFO
//   position (created_at, coalesce(legacy_id, id), id) among waitlisted rows.
//
// Hermetic suites run without a database; the SQL pin (LIMIT, exclusion,
// ordering, position, unaudited) runs against the disposable test database via
// createMemberDataFixture and is skipped without DATABASE_URL. Never point
// these at production or staging data.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import type { KitLocals } from "../src/kit-session";
import { resolveKitProfile } from "../src/profiles/kit";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { profiles, users } from "../src/db/schema";
import { ORIGIN, OWNER, VIEWER } from "./helpers/profile-participation";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

/** Pinned upcoming-list cap: one bounded read, exactly this many rows max. */
export const PROFILE_UPCOMING_LIMIT = 10;

/** One row the upcoming seam resolves for the viewing member. */
export type UpcomingGameNight = {
  eventKey: string;
  title: string;
  startsAt: Date;
  timezone: string;
  location: string | null;
  status: "going" | "waitlisted";
  /** 1-based FIFO position; set iff status is waitlisted, else null. */
  waitlistPosition: number | null;
};

export type UpcomingSource = (memberId: string) => Promise<UpcomingGameNight[]>;

type Renderer = "Hono" | "Kit";
const renderers: Renderer[] = ["Hono", "Kit"];

const SECRET = "test-session-secret-at-least-32-bytes-long";
const HEADING = "Your upcoming game nights";

let compiledView: Promise<(props: Record<string, unknown>) => string> | undefined;
function compileView() {
  compiledView ??= (async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler");
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "profile-upcoming-",
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
            name: "upcoming-real-svelte",
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

type LoadCookies = {
  get: (name: string) => string | undefined;
  set: (name: string, value: string, options?: Record<string, unknown>) => void;
};
type LoadEvent = {
  locals: KitLocals;
  params: { user: string };
  url: HookEventLike["url"];
  cookies: LoadCookies;
  setHeaders: (headers: Record<string, string>) => void;
};
type LoadSeam = {
  resolveKitProfile: typeof resolveKitProfile;
  storeFor: () => Promise<ReturnType<typeof createMemoryProfileStore>>;
  statsFor: (id: string) => Promise<null>;
  upcomingFor: UpcomingSource;
};
type Loader = (event: LoadEvent, seam: LoadSeam) => Promise<Record<string, unknown>>;
const loaders = new Map<boolean, Promise<Loader>>();
function compileLoader(own: boolean): Promise<Loader> {
  let pending = loaders.get(own);
  if (!pending) {
    pending = (async () => {
      const root = fileURLToPath(new URL("../", import.meta.url));
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
            name: "upcoming-load-externals",
            setup(plugin) {
              plugin.onResolve(
                {
                  filter:
                    /(?:profiles\/kit$|^acceptance:profile-deps$|^@sveltejs\/kit$|^cloudflare:workers$)/,
                },
                (args) => ({
                  path: args.path.includes("profiles/kit") ? "acceptance:profile-deps" : args.path,
                  namespace: "upcoming",
                }),
              );
              plugin.onLoad({ filter: /.*/, namespace: "upcoming" }, (args) => ({
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

async function upcomingFixture(
  viewer: "owner" | "other",
  rows: UpcomingGameNight[],
  options: { auditOk?: boolean; member?: boolean; guest?: boolean } = {},
) {
  const isOwner = viewer === "owner";
  const userId = isOwner ? OWNER : VIEWER;
  const session = {
    userId,
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
      bio: "A member who likes board games.",
      games: ["Chess"],
      timezone: "Europe/London",
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
  const upcomingCalls: string[] = [];
  const upcoming: UpcomingSource = async (memberId) => {
    upcomingCalls.push(memberId);
    return rows;
  };
  const audit: AccessEntry[] = [];
  const accessLog = async (entry: AccessEntry) => {
    audit.push(entry);
    return options.auditOk ?? true;
  };
  // `upcoming` is the new seam: ignored on unmodified main (RED), resolved by
  // the paired build. The cast keeps this compiling before and after.
  const app = profilesApp({
    sessionStore: sessions,
    store: countedStore,
    accessLog,
    throttle: async () => ({ limited: false }),
    upcoming,
  } as unknown as ProfileDeps);
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
          resolveKitProfile,
          storeFor: async () => countedStore,
          statsFor: async (id) => {
            statsReads.push(id);
            return null;
          },
          upcomingFor: upcoming,
        },
      );
      const render = await compileView();
      return new Response(render(props), { headers });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };
  async function request(
    input: string = path,
    init: RequestInit = {},
    renderer: Renderer = "Hono",
  ) {
    const url = new URL(input, ORIGIN);
    const req = new Request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
    });
    const rememberSession = (response: Response) => {
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
  return { request, path, operations, statsReads, upcomingCalls, audit, store };
}

/** Event keys linked from the page, in document order. */
function eventLinksInOrder(html: string): string[] {
  return [...html.matchAll(/href="\/e\/([^"]+)"/g)].map((match) => match[1]!);
}

/** The item chunk starting at the nth upcoming item marker. */
function itemChunk(html: string, key: string): string {
  const chunks = html.split('data-testid="profile-upcoming-item"').slice(1);
  const found = chunks.find((chunk) => chunk.includes(`/e/${key}`));
  if (!found) throw new Error(`no upcoming item links /e/${key}`);
  return found;
}

const BETA: UpcomingGameNight = {
  eventKey: "01J0000000000000000000B01",
  title: "Beta Night Beta Night",
  startsAt: new Date("2070-05-01T18:00:00Z"),
  timezone: "Europe/London",
  location: "Beta Hall",
  status: "waitlisted",
  waitlistPosition: 2,
};
const ALPHA: UpcomingGameNight = {
  eventKey: "01J0000000000000000000A01",
  title: "Alpha Night",
  startsAt: new Date("2070-06-01T18:00:00Z"),
  timezone: "Europe/London",
  location: "Alpha Hall",
  status: "going",
  waitlistPosition: null,
};
const GAMMA: UpcomingGameNight = {
  eventKey: "01J0000000000000000000C01",
  title: "Gamma Night",
  startsAt: new Date("2070-07-01T18:00:00Z"),
  timezone: "Europe/London",
  location: "Gamma Hall",
  status: "going",
  waitlistPosition: null,
};
// Reader order (soonest first); the view preserves it.
const THREE = [BETA, ALPHA, GAMMA];

for (const renderer of renderers) {
  describe(`${renderer} profile upcoming game nights`, () => {
    it("renders the self-view section with going + waitlisted answers", async () => {
      const fixture = await upcomingFixture("owner", THREE);
      const response = await fixture.request(fixture.path, {}, renderer);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="profile-upcoming"');
      expect(html).toContain(HEADING);
      // Each item links its title to the event detail page, in reader order.
      expect(eventLinksInOrder(html)).toEqual([BETA.eventKey, ALPHA.eventKey, GAMMA.eventKey]);
      expect(html).toContain("Alpha Night");
      // When + venue render per item.
      expect(html).toContain("2070-05-01");
      expect(html).toContain("Beta Hall");
      expect(html).toContain("Alpha Hall");
      expect(html).toContain("<time");
      // Waitlisted position copy on the waitlisted item only.
      const beta = itemChunk(html, BETA.eventKey);
      expect(beta).toContain('data-testid="profile-upcoming-position"');
      expect(beta).toMatch(/waitlist/i);
      expect(beta).toContain("2");
      expect(itemChunk(html, ALPHA.eventKey)).not.toContain("profile-upcoming-position");
      // One bounded read for the viewer's own answers; the profile read,
      // stats reads and cache posture are unchanged; own reads stay unaudited.
      expect(fixture.upcomingCalls).toEqual([OWNER]);
      expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(fixture.statsReads).toEqual(renderer === "Kit" ? [OWNER] : []);
      expect(fixture.audit).toEqual([]);
      expect(response.headers.get("cache-control")).toContain("private");
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("renders an empty state linking the schedule when nothing is upcoming", async () => {
      const fixture = await upcomingFixture("owner", []);
      const response = await fixture.request(fixture.path, {}, renderer);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="profile-upcoming"');
      expect(html).toContain(HEADING);
      expect(html).toContain('data-testid="profile-upcoming-empty"');
      expect(html).toContain('href="/events"');
      expect(html).not.toContain("profile-upcoming-item");
      // The read still happens once (bounded even when empty); still unaudited.
      expect(fixture.upcomingCalls).toEqual([OWNER]);
      expect(fixture.audit).toEqual([]);
    });

    it("escapes hostile event titles and venues", async () => {
      const hostile: UpcomingGameNight = {
        eventKey: "01J0000000000000000000H01",
        title: '<script>alert("x")</script>',
        startsAt: new Date("2070-08-01T18:00:00Z"),
        timezone: "Europe/London",
        location: '"><img src=x onerror=alert(1)>',
        status: "going",
        waitlistPosition: null,
      };
      const fixture = await upcomingFixture("owner", [hostile]);
      const html = await (await fixture.request(fixture.path, {}, renderer)).text();
      expect(html).toContain(`/e/${hostile.eventKey}`);
      expect(html).not.toContain('<script>alert("x")</script>');
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<img src=x onerror");
    });

    it("keeps other-member renders self-only and byte-identical", async () => {
      const seeded = await upcomingFixture("other", THREE);
      const seededRes = await seeded.request(seeded.path, {}, renderer);
      expect(seededRes.status).toBe(200);
      const seededHtml = await seededRes.text();
      // No section, no heading, no event titles leak into another member view.
      expect(seededHtml).not.toContain("profile-upcoming");
      expect(seededHtml).not.toContain(HEADING);
      expect(seededHtml).not.toContain("Alpha Night");
      expect(seededHtml).not.toContain("Beta Night");
      expect(seededHtml).toContain("Fixture member");
      // The viewer's own upcoming rows change not one byte of that page, and
      // the upcoming read never runs for another member's page.
      const empty = await upcomingFixture("other", []);
      const emptyHtml = await (await empty.request(empty.path, {}, renderer)).text();
      expect(seededHtml).toBe(emptyHtml);
      expect(seeded.upcomingCalls).toEqual([]);
      // Reads, stats, audit and cache posture are exactly as today.
      expect(seeded.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(seeded.statsReads).toEqual(renderer === "Kit" ? [OWNER] : []);
      expect(seeded.audit).toHaveLength(1);
      expect(seeded.audit[0]).toMatchObject({ viewerUserId: VIEWER, subjectUserIds: [OWNER] });
      expect(seededRes.headers.get("cache-control")).toContain("private");
      expect(seededRes.headers.get("cache-control")).toContain("no-store");
    });

    it("bounces guests and refuses non-members without reading upcoming", async () => {
      const guest = await upcomingFixture("owner", THREE, { guest: true });
      const guestRes = await guest.request(guest.path, {}, renderer);
      expect(guestRes.status).toBe(302);
      expect(guest.upcomingCalls).toEqual([]);
      expect(guest.operations).toEqual([]);

      const outsider = await upcomingFixture("owner", THREE, { member: false });
      const outsiderRes = await outsider.request(outsider.path, {}, renderer);
      expect(outsiderRes.status).toBe(403);
      expect(outsider.upcomingCalls).toEqual([]);
      expect(outsider.operations).toEqual([]);
    });

    it("keeps the audit-failure refusal without reading upcoming", async () => {
      const fixture = await upcomingFixture("other", THREE, { auditOk: false });
      const response = await fixture.request(fixture.path, {}, renderer);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("Fixture member");
      expect(fixture.upcomingCalls).toEqual([]);
    });
  });
}

const dbUrl = process.env.DATABASE_URL;
describe.skipIf(!dbUrl)("profile upcoming game nights SQL pin (disposable test DB)", () => {
  let fixture: MemberDataFixture;
  let ownerCookie: string;
  const db = (): Db => fixture.db;
  const keyOf = (n: number) => `01J0000000000000000000U${String(n).padStart(2, "0")}`;
  const W1_KEY = "01J0000000000000000000UW1";

  beforeAll(async () => {
    fixture = await createMemberDataFixture(dbUrl!);
    await fixture.reset();
    await db()
      .insert(users)
      .values([
        { id: OWNER, username: "alice", member: true },
        { id: "100000000000000011", username: "waiter-one", member: true },
        { id: "100000000000000012", username: "waiter-two", member: true },
      ]);
    await db()
      .insert(profiles)
      .values({
        userId: OWNER,
        bio: "A member who likes board games.",
        games: ["Chess"],
        timezone: "Europe/London",
      });
    const eventIds = new Map<string, number>();
    const addEvent = async (init: {
      key: string;
      title: string;
      startsAt: string;
      endsAt: string;
      status?: string;
      location?: string;
    }) => {
      const [row] = await db()
        .insert(events)
        .values({
          eventKey: init.key,
          title: init.title,
          startsAt: new Date(init.startsAt),
          endsAt: new Date(init.endsAt),
          timezone: "Europe/London",
          location: init.location ?? "Main Hall",
          status: init.status ?? "published",
        })
        .returning({ id: events.id });
      eventIds.set(init.key, row!.id);
    };
    // Twelve upcoming going answers: the LIMIT pin keeps the soonest 10.
    for (let day = 1; day <= 12; day++) {
      const date = `2070-01-${String(day).padStart(2, "0")}`;
      await addEvent({
        key: keyOf(day),
        title: `Going Night ${String(day).padStart(2, "0")}`,
        startsAt: `${date}T18:00:00Z`,
        endsAt: `${date}T20:00:00Z`,
      });
    }
    // Waitlisted night between nights 05 and 06; two earlier waitlist rows put
    // the owner third in line.
    await addEvent({
      key: W1_KEY,
      title: "Waitlisted Night",
      startsAt: "2070-01-05T19:00:00Z",
      endsAt: "2070-01-05T21:00:00Z",
      location: "Side Room",
    });
    await addEvent({
      key: "01J0000000000000000000UCX",
      title: "Cancelled Night",
      startsAt: "2070-02-01T18:00:00Z",
      endsAt: "2070-02-01T20:00:00Z",
      status: "cancelled",
    });
    await addEvent({
      key: "01J0000000000000000000UPT",
      title: "Past Night",
      startsAt: "2020-05-01T18:00:00Z",
      endsAt: "2020-05-01T20:00:00Z",
    });
    await addEvent({
      key: "01J0000000000000000000UMB",
      title: "Maybe Night",
      startsAt: "2070-03-01T18:00:00Z",
      endsAt: "2070-03-01T20:00:00Z",
    });
    await addEvent({
      key: "01J0000000000000000000UNO",
      title: "Not Going Night",
      startsAt: "2070-03-02T18:00:00Z",
      endsAt: "2070-03-02T20:00:00Z",
    });
    const idOf = (key: string) => eventIds.get(key)!;
    for (let day = 1; day <= 12; day++) {
      await db()
        .insert(rsvps)
        .values({ eventId: idOf(keyOf(day)), userId: OWNER, status: "going" });
    }
    // Another member's going answer on night 01: the list stays own-answers.
    await db()
      .insert(rsvps)
      .values({ eventId: idOf(keyOf(1)), userId: "100000000000000011", status: "going" });
    await db()
      .insert(rsvps)
      .values([
        {
          eventId: idOf(W1_KEY),
          userId: "100000000000000011",
          status: "waitlisted",
          createdAt: new Date("2026-10-01T10:00:00Z"),
        },
        {
          eventId: idOf(W1_KEY),
          userId: "100000000000000012",
          status: "waitlisted",
          createdAt: new Date("2026-10-01T11:00:00Z"),
        },
        {
          eventId: idOf(W1_KEY),
          userId: OWNER,
          status: "waitlisted",
          createdAt: new Date("2026-10-01T12:00:00Z"),
        },
      ]);
    await db()
      .insert(rsvps)
      .values({ eventId: idOf("01J0000000000000000000UCX"), userId: OWNER, status: "going" });
    await db()
      .insert(rsvps)
      .values({ eventId: idOf("01J0000000000000000000UPT"), userId: OWNER, status: "going" });
    await db()
      .insert(rsvps)
      .values({ eventId: idOf("01J0000000000000000000UMB"), userId: OWNER, status: "maybe" });
    await db()
      .insert(rsvps)
      .values({ eventId: idOf("01J0000000000000000000UNO"), userId: OWNER, status: "not_going" });

    const sessions = createMemorySessionStore();
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: OWNER,
      username: "alice",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    ownerCookie = (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const app = profilesApp({
      sessionStore: sessions,
      throttle: async () => ({ limited: false }),
    });
    const env = {
      APP_URL: ORIGIN,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: SECRET,
      ADMIN_DB: db(),
    } satisfies EnvWithAdminDb as Env;
    const response = await app.request("/profile", { headers: { cookie: ownerCookie } }, env);
    dbHtml = await response.text();
    dbCache = response.headers.get("cache-control");
    dbStatus = response.status;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  let dbHtml = "";
  let dbCache: string | null = null;
  let dbStatus = 0;

  it("serves the self-view with the soonest 10 of 12 upcoming answers", () => {
    expect(dbStatus).toBe(200);
    expect(dbHtml).toContain('data-testid="profile-upcoming"');
    expect(dbHtml).toContain(HEADING);
    const expected = [
      keyOf(1),
      keyOf(2),
      keyOf(3),
      keyOf(4),
      keyOf(5),
      W1_KEY,
      keyOf(6),
      keyOf(7),
      keyOf(8),
      keyOf(9),
    ];
    expect(eventLinksInOrder(dbHtml)).toEqual(expected);
    expect(dbHtml.match(/data-testid="profile-upcoming-item"/g)).toHaveLength(
      PROFILE_UPCOMING_LIMIT,
    );
  });

  it("excludes cancelled, past, maybe and not-going answers", () => {
    for (const title of ["Cancelled Night", "Past Night", "Maybe Night", "Not Going Night"]) {
      expect(dbHtml).not.toContain(title);
    }
    // Truncation cuts the three latest, not the waitlisted night between them.
    for (const day of [10, 11, 12]) {
      expect(dbHtml).not.toContain(`Going Night ${String(day).padStart(2, "0")}`);
    }
    expect(dbHtml).toContain("Waitlisted Night");
  });

  it("shows the waitlist position with title, when and venue", () => {
    const waitlisted = itemChunk(dbHtml, W1_KEY);
    expect(waitlisted).toContain('data-testid="profile-upcoming-position"');
    expect(waitlisted).toMatch(/waitlist/i);
    expect(waitlisted).toContain("3");
    expect(waitlisted).toContain("2070-01-05");
    expect(waitlisted).toContain("Side Room");
  });

  it("leaves the self-view unaudited with private no-store caching", async () => {
    expect(await db().select().from(memberDataAccessLogs)).toEqual([]);
    expect(dbCache).toContain("private");
    expect(dbCache).toContain("no-store");
  });
});
