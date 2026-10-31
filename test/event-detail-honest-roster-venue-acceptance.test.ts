// Acceptance: honest roster and venue states on event detail (V2).
//
// Fail-first for the V2 build: guests, signed-in non-members and members on
// an empty roster see named states instead of hidden sections, and a
// venue-less detail renders an honest Where fallback. Both twins (Hono
// `EventPage` and Kit `EventDetail.svelte`) share this contract.
//
// Owned by the Test Author. The Builder builds on this branch and never edits
// this file. Behavior-pinned: assertions target visible copy, links and leak
// absence, not implementation structure.
//
// New-state contract (failing at the pinned base):
// - Guest on an event with RSVPs: `event-roster-guest-nudge` with a sign-in
//   link carrying the event path as `?next=`.
// - Signed-in non-member: `event-roster-members-only` explainer with a join
//   link carrying the event path as `?next=`.
// - Member on an empty page-1 roster: `event-roster-empty` with the neutral
//   "No one is listed as going yet." state. Page>1 "no more attendees" copy
//   is unchanged.
// - Correction (review blockers on the rebuilt feature head): an empty
//   named-going roster never claims there are no RSVP responses and never
//   invites a first going RSVP the adjacent control cannot grant (a
//   nameless seat can fill the event while the named count is 0; maybe /
//   waitlisted answers can exist with zero named going rows; paused and
//   closed states included). Guest sign-in and non-member join roster links
//   keep only bounded, validated archive/attendee context in `next`.
// - Venue-less detail: a Where row with `event-venue-tbd` fallback plus a
//   Discord pointer. Venue-less list cards stay clean (no TBD there).
// - No attendee names/ids leak to any non-member HTML or Kit `__data.json`
//   (the serialized load model).
//
// Hermetic: pg-proxy fakes for Hono, in-memory store fakes for Kit, plus the
// compiled Svelte SSR bundle for the Kit presentation. No DATABASE_URL, no
// live Discord, local fixtures only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { MAX_RETURN_DESTINATION_BYTES, safeNext } from "../src/join/service";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import { archiveContext } from "../src/events/archive-context";
import { parseAttendeePageParam } from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER_ID = "100000000000000001";
const OUTSIDER_ID = "100000000000000099";
const ANN_ID = "100000000000000003";
const BOB_ID = "100000000000000004";
const NOW = new Date("2030-01-10T19:00:00Z");

// Keep open RSVP controls and session expiry deterministic without faking
// the async timers used by the real route and compiled Svelte fixtures.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const ATTENDEES: EventAttendee[] = [
  { id: ANN_ID, name: "ann" },
  { id: BOB_ID, name: "bob" },
];

const NEIGHBORS: EventNeighbors = { previous: null, next: null };
const RELATED: EventLink[] = [];
const SUGGESTIONS: SuggestedEvent[] = [];

// ---------------------------------------------------------------------------
// Hono fixture (pg-proxy, no database connection)
// ---------------------------------------------------------------------------

type HonoFixtureOptions = {
  location?: string | null;
  attendeeRows?: EventAttendee[];
  goingCount?: number;
  goingOccupancy?: number;
  capacity?: number;
  status?: string;
  rsvpOpen?: boolean;
  answer?: ViewerRsvp | null;
};

function honoRow(over: Partial<typeof events.$inferSelect> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  } as typeof events.$inferSelect;
}

function honoFixture(options: HonoFixtureOptions = {}) {
  const attendeeRows = options.attendeeRows ?? ATTENDEES;
  const goingCount = options.goingCount ?? attendeeRows.length;
  const goingOccupancy = options.goingOccupancy ?? goingCount;
  const row = honoRow({
    location: options.location === undefined ? "The lobby" : options.location,
    capacity: options.capacity ?? 10,
    status: options.status ?? "published",
    rsvpOpen: options.rsvpOpen ?? true,
  });
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const toRow = () =>
    columns.map((key) => (row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]));
  const db = drizzle(async (sql, params) => {
    // Waitlist line rank is empty in this fixture (position fallback).
    if (sql.includes("row_number()")) return { rows: [] };
    // Roster projection: named going rows for the member read.
    if (
      sql.includes('from "rsvps"') &&
      sql.includes('inner join "users"') &&
      !sql.includes("group by")
    ) {
      return { rows: attendeeRows.map((a) => [a.id, a.name]) };
    }
    if (sql.includes('from "rsvps"')) {
      if (sql.includes("count(*)")) {
        // Two aggregates leave the reads: the named going count joins users,
        // seat occupancy counts every going row (nameless included). They
        // diverge exactly when a nameless row holds a seat.
        const n = sql.includes('inner join "users"') ? goingCount : goingOccupancy;
        return { rows: [[row.id, n]] };
      }
      // The viewer's own current answer (maybe / waitlisted / going).
      const answer = options.answer ?? null;
      if (!answer || params[0] !== row.id || String(params[1]) !== MEMBER_ID) return { rows: [] };
      const synced = answer.syncedToDiscordAt?.toISOString() ?? null;
      return {
        rows: [
          Object.assign([MEMBER_ID, answer.status, synced], {
            userId: MEMBER_ID,
            status: answer.status,
            syncedToDiscordAt: synced,
          }),
        ],
      };
    }
    if (sql.includes('"event_key" =')) return { rows: [toRow()] };
    return { rows: [] };
  });
  // The member-read boundary audits through a transaction; pg-proxy cannot
  // open one, so run the callback directly on the fake handle.
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const cookieFor = async (userId: string, member: boolean) => {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId,
      username: member ? "member" : "outsider",
      avatar: null,
      member,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };
  return {
    env,
    memberCookie: () => cookieFor(MEMBER_ID, true),
    outsiderCookie: () => cookieFor(OUTSIDER_ID, false),
    request: (cookie?: string, path = PATH) =>
      app.request(path, cookie ? { headers: { cookie } } : {}, env),
  };
}

// ---------------------------------------------------------------------------
// Kit fixture (in-memory store + compiled Svelte SSR)
// ---------------------------------------------------------------------------

const GUEST: KitRequestSession = { status: "guest", session: null };
const memberKitSession = (): KitRequestSession => ({
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "member", avatar: null, member: true, moderator: false },
});
const outsiderKitSession = (): KitRequestSession => ({
  status: "authenticated",
  session: {
    userId: OUTSIDER_ID,
    username: "outsider",
    avatar: null,
    member: false,
    moderator: false,
  },
});

type KitFixtureOptions = {
  location?: string | null;
  attendees?: EventAttendee[];
  goingCount?: number;
  goingOccupancy?: number;
  capacity?: number;
  status?: string;
  rsvpOpen?: boolean;
  answer?: ViewerRsvp | null;
};

function kitRow(over: Partial<typeof events.$inferSelect> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

function kitStore(options: KitFixtureOptions = {}): KitEventDetailStore {
  const attendees = options.attendees ?? ATTENDEES;
  const goingCount = options.goingCount ?? attendees.length;
  const event = {
    ...kitRow({
      location: options.location === undefined ? "The lobby" : options.location,
      capacity: options.capacity ?? 10,
      status: options.status ?? "published",
      rsvpOpen: options.rsvpOpen ?? true,
    }),
    goingCount,
    goingOccupancy: options.goingOccupancy ?? goingCount,
  } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => NEIGHBORS,
    relatedFn: async () => RELATED,
    attendeesFn: async () => attendees,
    viewerRsvpFn: async () => (options.answer !== undefined ? options.answer : null),
    waitlistFn: async () => null,
    suggestionsFn: async () => SUGGESTIONS,
  };
}

const kitEnv = { APP_URL } as unknown as Env;

async function kitResolve(store: KitEventDetailStore, session: KitRequestSession, search = "") {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search,
    path: PATH,
    env: kitEnv,
    session,
    joinResult: null,
    setHeaders: (headers) => seen.push(headers),
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.model;
}

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally (same shape as the Kit detail
// parity bundle).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitDetailBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-honest-roster-"));
  try {
    const entry = join(scratch, "kit-honest-roster-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-honest-roster.mjs");
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
          name: "kit-honest-roster-svelte-ssr",
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
    const { renderDetail } = (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
    };
    return { renderDetail };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function kitHtml(
  render: (model: Record<string, unknown>) => string,
  store: KitEventDetailStore,
  session: KitRequestSession,
  search = "",
) {
  const model = await kitResolve(store, session, search);
  return {
    html: render(model as unknown as Record<string, unknown>),
    model,
  };
}

// ---------------------------------------------------------------------------
// Shared copy helpers (apostrophes escape differently per twin)
// ---------------------------------------------------------------------------

/** Hono escapes `'` as `&#39;`; Svelte renders it raw. Match either. */
const nudgeCopy = /sign in to see who(&#39;|')s in/i;
const membersOnlyCopy = /members.only/i;
// The roster lists named going rows only, so its empty state may describe
// only the absence of listed going attendees — never the absence of all
// RSVP responses, and never a first going seat that cannot be taken.
const neutralEmptyCopy = "No one is listed as going yet.";
const noResponsesClaim = /no rsvps(\.| yet)/i;
const firstGoingClaim = /rsvp to start the list|sign in to be the first/i;
const tbdCopy = /tbd|to be (decided|announced)/i;
const stalePageCopy = "There are no more attendees on this page.";

/** The roster shell's own markup, from its testid to the section close. */
function rosterSection(html: string, testid: string): string {
  const start = html.indexOf(`data-testid="${testid}"`);
  expect(start, `roster section ${testid}`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

function expectNeutralEmptyRoster(html: string, testid: string) {
  const section = rosterSection(html, testid);
  expect(section).toContain(neutralEmptyCopy);
  expect(section).not.toMatch(noResponsesClaim);
  expect(section).not.toMatch(firstGoingClaim);
}

/** Decode the shell's actual href and apply the production auth boundary. */
function rosterJoinDestination(html: string, testid: string, joinPath: string) {
  const section = rosterSection(html, testid);
  const match = /href="([^"]+)"/.exec(section);
  expect(match, `${testid} link`).not.toBeNull();
  const href = match![1]!;
  expect(href.startsWith(`${joinPath}?next=`), `${testid} href ${href}`).toBe(true);
  const next = new URL(href, APP_URL).searchParams.get("next");
  expect(next, `${testid} next`).not.toBeNull();
  expect(next!.startsWith("//")).toBe(false);
  const nextBytes = new TextEncoder().encode(next!).byteLength;
  expect(safeNext(next), `${testid} next (${nextBytes} UTF-8 bytes) must survive auth`).toBe(next);
  expect(nextBytes).toBeLessThanOrEqual(MAX_RETURN_DESTINATION_BYTES);
  const url = new URL(next!, APP_URL);
  expect(url.origin).toBe(APP_URL);
  expect(url.pathname).toBe(PATH);
  return url;
}

/** Query order is the renderer's choice; landed context is not. */
function rosterJoinContext(html: string, testid: string, joinPath: string) {
  const url = rosterJoinDestination(html, testid, joinPath);
  return {
    archive: archiveContext(url.search),
    page: parseAttendeePageParam(url.searchParams.get("attendees")),
  };
}

const guestNext = `/join/discord?next=${encodeURIComponent(PATH)}`;
const joinNext = `/join?next=${encodeURIComponent(PATH)}`;

describe("honest roster: guest nudge per twin (?next= preserved)", () => {
  it("Hono: guest on an event with RSVPs sees the nudge, not a hidden roster", async () => {
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    const res = await source.request();
    expect(res.status).toBe(200);
    const html = await res.text();
    // The lineup count still renders; the roster is named, not hidden.
    expect(html).toContain("2 of 10 going");
    expect(html).toContain('data-testid="event-roster-guest-nudge"');
    expect(html).toMatch(nudgeCopy);
    expect(html).toContain(`href="${guestNext}"`);
    // Member names never leak into the guest render.
    expect(html).not.toContain(">ann<");
    expect(html).not.toContain(">bob<");
    expect(html).not.toContain(ANN_ID);
    expect(html).not.toContain(BOB_ID);
  });

  it("Kit: guest on an event with RSVPs sees the nudge, not a hidden roster", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const { html, model } = await kitHtml(renderDetail, kitStore(), GUEST);
    expect(html).toContain("2 of 10 going");
    expect(html).toContain('data-testid="event-roster-guest-nudge"');
    expect(html).toMatch(nudgeCopy);
    expect(html).toContain(`href="${guestNext}"`);
    expect(html).not.toContain(">ann<");
    expect(html).not.toContain(">bob<");
    expect(html).not.toContain(ANN_ID);
    expect(html).not.toContain(BOB_ID);
    // The Kit __data.json payload is the serialized load model: no identities.
    // (Bare "ann" collides with data-announcement/canonical; pin the identity
    // shapes instead: profile links, rendered names and Discord IDs.)
    const serialized = JSON.stringify({ model });
    expect(serialized).not.toContain('"name":"ann"');
    expect(serialized).not.toContain('"name":"bob"');
    expect(serialized).not.toContain(ANN_ID);
    expect(serialized).not.toContain(BOB_ID);
  });
});

describe("honest roster: signed-in non-member explainer + join path per twin", () => {
  it("Hono: non-member sees the members-only explainer with the join path", async () => {
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    const res = await source.request(await source.outsiderCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-roster-members-only"');
    expect(html).toMatch(membersOnlyCopy);
    expect(html).toContain(`href="${joinNext}"`);
    expect(html).not.toContain(">ann<");
    expect(html).not.toContain(ANN_ID);
    expect(html).not.toContain(BOB_ID);
  });

  it("Kit: non-member sees the members-only explainer with the join path", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const { html, model } = await kitHtml(renderDetail, kitStore(), outsiderKitSession());
    expect(html).toContain('data-testid="event-roster-members-only"');
    expect(html).toMatch(membersOnlyCopy);
    expect(html).toContain(`href="${joinNext}"`);
    expect(html).not.toContain(">ann<");
    expect(html).not.toContain(ANN_ID);
    expect(html).not.toContain(BOB_ID);
    const serialized = JSON.stringify({ model });
    expect(serialized).not.toContain('"name":"ann"');
    expect(serialized).not.toContain(ANN_ID);
    expect(serialized).not.toContain(BOB_ID);
  });
});

describe("honest roster: member empty page-1 state per twin; page>1 unchanged", () => {
  it("Hono: member on an empty page-1 roster sees an honest empty state", async () => {
    const source = honoFixture({ attendeeRows: [], goingCount: 0 });
    const res = await source.request(await source.memberCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-roster-empty"');
    expectNeutralEmptyRoster(html, "event-roster-empty");
  });

  it("Kit: member on an empty page-1 roster sees an honest empty state", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const { html } = await kitHtml(
      renderDetail,
      kitStore({ attendees: [], goingCount: 0 }),
      memberKitSession(),
    );
    expect(html).toContain('data-testid="event-roster-empty"');
    expectNeutralEmptyRoster(html, "event-roster-empty");
  });

  it("Hono: member on an empty page>1 keeps the existing copy byte-stable", async () => {
    const source = honoFixture({ attendeeRows: [], goingCount: 0 });
    const res = await source.request(await source.memberCookie(), `${PATH}?attendees=2`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(stalePageCopy);
    expect(html).not.toContain("event-roster-empty");
  });

  it("Kit: member on an empty page>1 keeps the existing copy byte-stable", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const { html } = await kitHtml(
      renderDetail,
      kitStore({ attendees: [], goingCount: 0 }),
      memberKitSession(),
      "?attendees=2",
    );
    expect(html).toContain(stalePageCopy);
    expect(html).not.toContain("event-roster-empty");
  });
});

describe("correction: a full event never invites the first going RSVP", () => {
  // Divergent counts from the going-count/roster agreement contract: one
  // nameless going row occupies the only seat, so the named roster and
  // goingCount are 0 while goingOccupancy is 1 at capacity 1. The adjacent
  // action is Join the waitlist; roster copy must not offer a going seat.
  const fullByNamelessSeat = { capacity: 1, goingCount: 0, goingOccupancy: 1 } as const;

  it("Hono member: waitlist action beside a neutral empty roster", async () => {
    const source = honoFixture({ attendeeRows: [], ...fullByNamelessSeat });
    const res = await source.request(await source.memberCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("0 of 1 going");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
    expectNeutralEmptyRoster(html, "event-roster-empty");
  });

  it("Hono guest: no be-the-first invite on a full event", async () => {
    const source = honoFixture({ attendeeRows: [], ...fullByNamelessSeat });
    const res = await source.request();
    expect(res.status).toBe(200);
    const html = await res.text();
    expectNeutralEmptyRoster(html, "event-roster-guest-nudge");
  });

  it("Kit member + guest: waitlist verdict and neutral roster agree", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const member = await kitHtml(
      renderDetail,
      kitStore({ attendees: [], answer: null, ...fullByNamelessSeat }),
      memberKitSession(),
    );
    expect(member.html).toContain("0 of 1 going");
    expect(member.html).toContain('data-testid="waitlist-join"');
    expect(member.html).not.toContain('data-testid="rsvp-going"');
    expectNeutralEmptyRoster(member.html, "event-roster-empty");
    const guest = await kitHtml(
      renderDetail,
      kitStore({ attendees: [], ...fullByNamelessSeat }),
      GUEST,
    );
    expectNeutralEmptyRoster(guest.html, "event-roster-guest-nudge");
  });
});

describe("correction: empty named-going roster describes listed going, not responses", () => {
  const maybeAnswer: ViewerRsvp = { status: "maybe", syncedToDiscordAt: null };
  const waitlistedAnswer: ViewerRsvp = { status: "waitlisted", syncedToDiscordAt: null };

  it.each([
    ["a maybe answer", maybeAnswer, {}, /down as a maybe/i],
    ["a waitlisted answer", waitlistedAnswer, {}, "waitlist-leave"],
    ["a maybe answer with RSVPs paused", maybeAnswer, { rsvpOpen: false }, /RSVPs are paused/],
    ["a maybe answer on a past event", maybeAnswer, { status: "past" }, /has been and gone/],
  ])(
    "Hono member with %s sees no listed going, never 'no RSVPs'",
    async (_label, answer, over, stateProof) => {
      const source = honoFixture({
        attendeeRows: [],
        goingCount: 0,
        goingOccupancy: 0,
        answer,
        ...over,
      });
      const res = await source.request(await source.memberCookie());
      expect(res.status).toBe(200);
      const html = await res.text();
      // Proof the discriminating viewer/state input really rendered.
      if (typeof stateProof === "string") expect(html).toContain(`data-testid="${stateProof}"`);
      else expect(html).toMatch(stateProof);
      expectNeutralEmptyRoster(html, "event-roster-empty");
    },
  );

  it("Kit member: maybe, waitlisted, paused and past all read as no listed going", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const cases: [string, ViewerRsvp, Partial<KitFixtureOptions>, RegExp | string][] = [
      ["maybe", maybeAnswer, {}, /down as a maybe/i],
      ["waitlisted", waitlistedAnswer, {}, "waitlist-leave"],
      ["paused maybe", maybeAnswer, { rsvpOpen: false }, /RSVPs are paused/],
      ["past maybe", maybeAnswer, { status: "past" }, /has been and gone/],
    ];
    for (const [label, answer, over, stateProof] of cases) {
      const { html } = await kitHtml(
        renderDetail,
        kitStore({ attendees: [], goingCount: 0, goingOccupancy: 0, answer, ...over }),
        memberKitSession(),
      );
      if (typeof stateProof === "string")
        expect(html, label).toContain(`data-testid="${stateProof}"`);
      else expect(html, label).toMatch(stateProof);
      expectNeutralEmptyRoster(html, "event-roster-empty");
    }
  });
});

describe("correction: roster join links keep bounded validated return context", () => {
  const contextCases: [string, string, { page: number; q: string } | null, number][] = [
    [
      "valid archive and attendee page",
      "?archivePage=2&archiveQuery=raid&attendees=2",
      { page: 2, q: "raid" },
      2,
    ],
    [
      "duplicate archive page rejected, attendee page kept",
      "?archivePage=2&archivePage=3&archiveQuery=raid&attendees=2",
      null,
      2,
    ],
    [
      "invalid attendee page falls back to page one, archive kept",
      "?archivePage=2&archiveQuery=raid&attendees=0",
      { page: 2, q: "raid" },
      1,
    ],
    [
      "oversized archive query rejected, attendee page kept",
      `?archivePage=2&archiveQuery=${"x".repeat(256)}&attendees=2`,
      null,
      2,
    ],
  ];

  it("Hono: guest sign-in and non-member join roster links return with context", async () => {
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    const outsider = await source.outsiderCookie();
    for (const [label, search, archive, page] of contextCases) {
      const guestHtml = await (await source.request(undefined, `${PATH}${search}`)).text();
      expect(
        rosterJoinContext(guestHtml, "event-roster-guest-nudge", "/join/discord"),
        `guest ${label}`,
      ).toEqual({ archive, page });
      const outsiderHtml = await (await source.request(outsider, `${PATH}${search}`)).text();
      expect(
        rosterJoinContext(outsiderHtml, "event-roster-members-only", "/join"),
        `non-member ${label}`,
      ).toEqual({ archive, page });
      // Canonical/share destinations never absorb return context.
      expect(guestHtml).toContain(`rel="canonical" href="${APP_URL}${PATH}"`);
    }
  });

  it("Kit: guest sign-in and non-member join roster links return with context", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    for (const [label, search, archive, page] of contextCases) {
      const guest = await kitHtml(renderDetail, kitStore(), GUEST, search);
      expect(
        rosterJoinContext(guest.html, "event-roster-guest-nudge", "/join/discord"),
        `guest ${label}`,
      ).toEqual({ archive, page });
      const outsider = await kitHtml(renderDetail, kitStore(), outsiderKitSession(), search);
      expect(
        rosterJoinContext(outsider.html, "event-roster-members-only", "/join"),
        `non-member ${label}`,
      ).toEqual({ archive, page });
      expect(guest.model.canonical).toBe(`${APP_URL}${PATH}`);
      expect(guest.model.copyLink).toBe(`${APP_URL}${PATH}`);
    }
  });
});

describe.each([
  {
    audience: "guest sign-in",
    testid: "event-roster-guest-nudge",
    joinPath: "/join/discord",
    session: GUEST,
  },
  {
    audience: "non-member join",
    testid: "event-roster-members-only",
    joinPath: "/join",
    session: outsiderKitSession(),
  },
])("boundary: $audience roster next survives auth", ({ audience, testid, joinPath, session }) => {
  // Both are valid archive searches, but forwarding the whole request URL
  // crosses auth's byte limit. Dropping everything loses useful context;
  // truncating the Unicode search changes its meaning. Neither is a fix.
  const returnCases = [
    {
      label: "omits Unicode archive; keeps attendee 2",
      search: `?archivePage=2&archiveQuery=${encodeURIComponent("棋".repeat(80))}&attendees=2`,
      inputArchive: { page: 2, q: "棋".repeat(80) },
      expectedParams: [["attendees", "2"]],
    },
    {
      label: "omits tracking; keeps archive + page 2",
      search: `?archivePage=2&archiveQuery=raid&attendees=2&tracking=${"x".repeat(600)}`,
      inputArchive: { page: 2, q: "raid" },
      expectedParams: [
        ["archivePage", "2"],
        ["archiveQuery", "raid"],
        ["attendees", "2"],
      ],
    },
  ];

  it.each(returnCases)("Hono: $label", async ({ search, inputArchive, expectedParams }) => {
    expect(archiveContext(search)).toEqual(inputArchive);
    expect(new TextEncoder().encode(`${PATH}${search}`).byteLength).toBeGreaterThan(
      MAX_RETURN_DESTINATION_BYTES,
    );
    expect(safeNext(`${PATH}${search}`)).toBeNull();
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    const cookie = audience === "guest sign-in" ? undefined : await source.outsiderCookie();
    const response = await source.request(cookie, `${PATH}${search}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const destination = rosterJoinDestination(html, testid, joinPath);
    // Inspect the actual admitted destination, not just a parser that could
    // silently ignore raw tracking, duplicate keys or a shortened search.
    expect([...destination.searchParams.entries()].sort()).toEqual(expectedParams);
    expect(html).toContain(`rel="canonical" href="${APP_URL}${PATH}"`);
  });

  it.each(returnCases)("Kit: $label", async ({ search, inputArchive, expectedParams }) => {
    expect(archiveContext(search)).toEqual(inputArchive);
    expect(new TextEncoder().encode(`${PATH}${search}`).byteLength).toBeGreaterThan(
      MAX_RETURN_DESTINATION_BYTES,
    );
    expect(safeNext(`${PATH}${search}`)).toBeNull();
    const { renderDetail } = await buildKitDetailBundle();
    const { html, model } = await kitHtml(renderDetail, kitStore(), session, search);
    const destination = rosterJoinDestination(html, testid, joinPath);
    expect([...destination.searchParams.entries()].sort()).toEqual(expectedParams);
    expect(model.canonical).toBe(`${APP_URL}${PATH}`);
    expect(model.copyLink).toBe(`${APP_URL}${PATH}`);
  });
});

describe("honest venue: Where TBD fallback + Discord pointer per twin", () => {
  it("Hono: venue-less detail renders a Where row with TBD + Discord pointer", async () => {
    const source = honoFixture({ location: null });
    const res = await source.request();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<dt>Where</dt>");
    expect(html).toContain('data-testid="event-venue-tbd"');
    expect(html).toMatch(tbdCopy);
    expect(html).toContain('href="/discord"');
  });

  it("Kit: venue-less detail renders a Where row with TBD + Discord pointer", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    const { html } = await kitHtml(renderDetail, kitStore({ location: null }), GUEST);
    expect(html).toContain("<dt>Where</dt>");
    expect(html).toContain('data-testid="event-venue-tbd"');
    expect(html).toMatch(tbdCopy);
    expect(html).toContain('href="/discord"');
  });

  it("Hono: venue-less list cards stay clean (no TBD, no venue row)", async () => {
    const { Hono } = await import("hono");
    const { CalCard } = await import("../src/events/pages-calendar-card");
    const cardApp = new Hono();
    cardApp.get("/card", (c) => {
      const row = {
        startsAt: new Date("2030-01-10T20:00:00Z"),
        endsAt: new Date("2030-01-10T22:00:00Z"),
        eventKey: KEY,
        title: "Chess night",
        game: "Chess",
        description: null,
        status: "published",
        location: null,
        goingCount: 2,
        goingOccupancy: 2,
        capacity: 10,
        timezone: "UTC",
      };
      return c.html(
        CalCard({
          e: row as never,
          zone: "UTC",
          isPast: false,
          member: false,
          inviteUrl: "/discord",
          loginReturnTo: "/events",
        }) as never,
      );
    });
    const html = await (await cardApp.request("/card")).text();
    expect(html).not.toMatch(tbdCopy);
    expect(html).not.toContain("event-venue");
  });

  it("Kit: venue-less list cards stay clean (no TBD, no venue row)", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    // The Kit detail with a venue-less related event renders the related link
    // without any location text or TBD fallback (cards stay clean).
    const store = kitStore({ location: "The lobby" });
    const model = await kitResolve(store, GUEST);
    const withRelated = {
      ...model,
      related: [
        {
          key: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
          title: "Chess finals",
          whenText: "1 February 2030",
          datetime: "2030-02-01T19:00:00.000Z",
          location: null,
        },
      ],
    };
    const html = renderDetail(withRelated as unknown as Record<string, unknown>);
    expect(html).toContain("Chess finals");
    expect(html).not.toMatch(tbdCopy);
    expect(html).not.toContain("event-venue-tbd");
  });
});

describe("leak assertions: no attendee names/ids in non-member renders", () => {
  // Bare "ann" collides with data-announcement/canonical; pin the identity
  // shapes instead: rendered names, profile links and Discord IDs.
  const htmlSecrets = [
    ">ann<",
    ">bob<",
    `/members/${ANN_ID}`,
    `/members/${BOB_ID}`,
    ANN_ID,
    BOB_ID,
  ];
  const jsonSecrets = [`"name":"ann"`, `"name":"bob"`, ANN_ID, BOB_ID];

  it("Hono: guest and non-member HTML carry no attendee identity", async () => {
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    for (const cookie of [undefined, await source.outsiderCookie()]) {
      const res = await source.request(cookie);
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const secret of htmlSecrets) {
        expect(html).not.toContain(secret);
      }
    }
  });

  it("Kit: guest and non-member HTML + __data.json carry no attendee identity", async () => {
    const { renderDetail } = await buildKitDetailBundle();
    for (const session of [GUEST, outsiderKitSession()]) {
      const { html, model } = await kitHtml(renderDetail, kitStore(), session);
      for (const secret of htmlSecrets) {
        expect(html).not.toContain(secret);
      }
      const serialized = JSON.stringify({ model });
      for (const secret of jsonSecrets) {
        expect(serialized).not.toContain(secret);
      }
      expect(model.attendees).toEqual([]);
    }
  });

  it("control: members still see the linked roster on both twins", async () => {
    const source = honoFixture({ attendeeRows: ATTENDEES, goingCount: 2 });
    const honoHtml = await (await source.request(await source.memberCookie())).text();
    expect(honoHtml).toContain(`<a href="/members/${ANN_ID}">ann</a>`);
    const { renderDetail } = await buildKitDetailBundle();
    const { html: kitHtmlText } = await kitHtml(renderDetail, kitStore(), memberKitSession());
    expect(kitHtmlText).toContain(`href="/members/${ANN_ID}"`);
    expect(kitHtmlText).toContain(">ann<");
  });
});
