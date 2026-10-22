// route-inventory: GET /e/:key
// X1 acceptance: past-event detail stops saying "Save the date".
//
// Failing-first contract for the paired build. The Builder builds on this
// branch and MUST NEVER EDIT this file — if a test is wrong, return it to
// the Test Author instead of changing it.
//
// RED (fail on unmodified main, pass after the build):
//   H1/H2/H4/H5 + K1/K2/K4/K5 + P1/P2/P3/P4 — past share heading, calendar
//   actions and way-forward, per twin plus parity. H5/K5/P4 cover an elapsed
//   published row (status published, January 2020 dates).
// GREEN controls (pass before and after; guard what must not change):
//   H3/K3 — past share keeps Copy link + toast.
//   S1/S2 — live/upcoming share box byte-stable per twin.
//   S3/S4 — cancelled 410 branch stable per twin (separate gone page).
//   S5/S6 — draft branch stable per twin (moderators keep the live share box).
//
// Local fixtures only; no live Discord, no staging/prod DB.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { EventAttendee, ViewerRsvp } from "../src/events/reads";
import type { PublicEvent } from "../src/events/reads";
import type { EventLink, EventNeighbors } from "../src/events/reads";
import type { KitRequestSession } from "../src/kit-session";
import type { JoinResult } from "../src/return-journey";
import type { SuggestedEvent } from "../src/events/suggestions";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const CANONICAL = `${APP_URL}${PATH}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER_ID = "100000000000000001";
const MOD_ID = "100000000000000002";

const LIVE_START = new Date("2030-01-10T20:00:00Z");
const LIVE_END = new Date("2030-01-10T22:00:00Z");
const PAST_START = new Date("2020-01-10T20:00:00Z");
const PAST_END = new Date("2020-01-10T22:00:00Z");

// ---------------------------------------------------------------------------
// Hono fixture (same seams as test/event-page-share.test.ts, plus a moderator
// cookie for the draft branch).
// ---------------------------------------------------------------------------

type Answer = { status: string; syncedToDiscordAt: Date | null };

function honoFixture(
  over: Partial<typeof events.$inferSelect> = {},
  opts: { going?: number; answers?: Record<string, Answer>; attendees?: EventAttendee[] } = {},
) {
  const { going = 3, answers = {}, attendees = [] } = opts;
  const start = LIVE_START;
  const row: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: LIVE_END,
    timezone: "UTC",
    location: "The lobby & voice channel",
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
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes("row_number()")) return { rows: [] };
    if (
      sql.includes('from "rsvps"') &&
      sql.includes('inner join "users"') &&
      !sql.includes("group by")
    ) {
      return {
        rows: attendees.map((a) => Object.assign([a.id, a.name], { id: a.id, name: a.name })),
      };
    }
    if (sql.includes('from "rsvps"')) {
      if (sql.includes("count(*)") || sql.includes("group by")) return { rows: [[row.id, going]] };
      const answer = (answers as Record<string, ViewerRsvp | Answer>)[String(params[1])];
      if (params[0] !== row.id || !answer) return { rows: [] };
      const userId = String(params[1]);
      const synced = answer.syncedToDiscordAt?.toISOString() ?? null;
      return {
        rows: [
          Object.assign([userId, answer.status, synced], {
            userId,
            status: answer.status,
            syncedToDiscordAt: synced,
          }),
        ],
      };
    }
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    env,
    async sessionCookie(
      userId: string,
      flags: { member: boolean; moderator: boolean },
      sessionStore: SessionStore = store,
    ) {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId,
        username: flags.moderator ? "mod" : "member",
        avatar: null,
        member: flags.member,
        moderator: flags.moderator,
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
    },
    request(cookie?: string, path = PATH) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

export async function honoHtml(
  over: Partial<typeof events.$inferSelect> = {},
  cookie?: string,
): Promise<{ status: number; html: string; headers: Headers }> {
  const source = honoFixture(over);
  const response = await source.request(cookie);
  return { status: response.status, html: await response.text(), headers: response.headers };
}

// ---------------------------------------------------------------------------
// Kit helpers (same seams as test/kit-event-detail.test.ts).
// ---------------------------------------------------------------------------

function kitRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const start = LIVE_START;
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: LIVE_END,
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

const KIT_NEIGHBORS: EventNeighbors = { previous: null, next: null };
const KIT_RELATED: EventLink[] = [];
const KIT_ATTENDEES: EventAttendee[] = [];
const KIT_SUGGESTIONS: SuggestedEvent[] = [];

const KIT_GUEST: KitRequestSession = { status: "guest", session: null };
const kitMemberSession = (userId = MEMBER_ID, moderator = false): KitRequestSession => ({
  status: "authenticated",
  session: { userId, username: "member", avatar: null, member: true, moderator },
});

function kitFakeStore(
  over: Partial<{
    event: PublicEvent | null;
    neighbors: EventNeighbors;
    related: EventLink[];
    attendees: EventAttendee[];
    answer: ViewerRsvp | null;
    waitlist: number | null;
    suggestions: SuggestedEvent[];
  }> = {},
): KitEventDetailStore {
  const event = { ...kitRow(), goingCount: 3 } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (over.event === undefined ? event : over.event),
    neighborsFn: async () => over.neighbors ?? KIT_NEIGHBORS,
    relatedFn: async () => over.related ?? KIT_RELATED,
    attendeesFn: async () => over.attendees ?? KIT_ATTENDEES,
    viewerRsvpFn: async () => (over.answer !== undefined ? over.answer : null),
    waitlistFn: async () => over.waitlist ?? null,
    suggestionsFn: async () => over.suggestions ?? KIT_SUGGESTIONS,
  };
}

const kitEnv = { APP_URL } as unknown as Env;

async function kitResolve(
  key: string,
  store: KitEventDetailStore,
  session: KitRequestSession = KIT_GUEST,
  joinResult: JoinResult | null = null,
) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key,
    search: "",
    path: `/e/${key}`,
    env: kitEnv,
    session,
    joinResult,
    setHeaders: (headers) => seen.push(headers),
    store,
  });
  return { outcome, seen };
}

// The real Kit presentation, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as the kit-event-detail
// suite: #lib/* resolves through the web alias).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitEventDetailBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
  renderGone: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-past-share-"));
  try {
    const entry = join(scratch, "kit-past-share-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderGone(model) {
  const { head, body } = render(Gone, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-past-share.mjs");
    const result = await build({
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
          name: "kit-past-share-svelte-ssr",
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
    void result;
    const { renderDetail, renderGone } = (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
      renderGone: (model: Record<string, unknown>) => string;
    };
    return { renderDetail, renderGone };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function kitHtml(
  over: Partial<typeof events.$inferSelect> = {},
  session: KitRequestSession = KIT_GUEST,
): Promise<string> {
  const { outcome } = await kitResolve(
    KEY,
    kitFakeStore({
      event: { ...kitRow(over), goingCount: 3 } as PublicEvent,
    }),
    session,
  );
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  const { renderDetail } = await buildKitEventDetailBundle();
  return renderDetail(outcome.model as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Share-section assertions (one bar for both twins; twin parity is explicit).
// ---------------------------------------------------------------------------

export function shareSection(html: string): string {
  const match = html.match(/<section class="event-share"[\s\S]*?<\/section>/);
  if (!match) throw new Error("share section missing");
  return match[0];
}

function shareHeading(share: string): string {
  const match = share.match(/<h2 id="event-share-heading">([^<]*)<\/h2>/);
  if (!match) throw new Error("share heading missing");
  return match[1]!;
}

/** Exact `/events/past` return inside the share box, if any. */
function shareWayForward(share: string): string | null {
  const match = share.match(/href="(\/events\/past)"/);
  return match ? match[1]! : null;
}

/** The honest past share box: heading, calendar actions, kept controls, way on. */
function expectHonestPastShare(share: string, twin: string) {
  // An honest heading, never "Save the date" for an event that already happened.
  expect(shareHeading(share), `${twin}: past share heading`).toBe("Share this event");
  expect(share, `${twin}: no future framing`).not.toContain("Save the date");
  // The "Add to calendar" actions go, or are honestly relabelled as
  // record-keeping (either path satisfies the roadmap).
  expect(share, `${twin}: no add-to-calendar wording`).not.toContain("Add to calendar");
  const keepsCalendarLinks =
    share.includes('data-testid="event-ics"') ||
    share.includes('data-testid="event-google-calendar"');
  if (keepsCalendarLinks) {
    expect(share, `${twin}: kept calendar links read as record-keeping`).toMatch(
      /record|download|keepsake|memento/i,
    );
  }
  // Copy link and its toast stay.
  expect(share, `${twin}: copy link kept`).toContain('data-testid="event-copy-link"');
  expect(share, `${twin}: copy toast kept`).toContain('data-testid="event-copy-toast"');
  // A way forward: the past archive, exactly.
  expect(share, `${twin}: browse past events link text`).toContain("Browse past events");
  const wayForward = shareWayForward(share);
  expect(wayForward, `${twin}: past share way forward present`).not.toBeNull();
  expect(wayForward, `${twin}: past share way forward destination`).toBe("/events/past");
}

const PAST_OVER = { status: "past", startsAt: PAST_START, endsAt: PAST_END } as const;
const ELAPSED_PUBLISHED_OVER = {
  status: "published",
  startsAt: PAST_START,
  endsAt: PAST_END,
} as const;

describe("past-event share acceptance (Hono)", () => {
  it("H1: past detail renders an honest share heading instead of Save the date", async () => {
    const { status, html } = await honoHtml({ ...PAST_OVER });
    expect(status).toBe(200);
    expect(html).toContain('data-testid="event-past"');
    const share = shareSection(html);
    expect(shareHeading(share)).toBe("Share this event");
    expect(share).not.toContain("Save the date");
  });

  it("H2: past share drops the Add-to-calendar actions or relabels them as record-keeping", async () => {
    const { html } = await honoHtml({ ...PAST_OVER });
    const share = shareSection(html);
    expect(share).not.toContain("Add to calendar");
    const keepsCalendarLinks =
      share.includes('data-testid="event-ics"') ||
      share.includes('data-testid="event-google-calendar"');
    if (keepsCalendarLinks) {
      expect(share).toMatch(/record|download|keepsake|memento/i);
    }
  });

  it("H3: past share keeps Copy link and the toast", async () => {
    const { html } = await honoHtml({ ...PAST_OVER });
    const share = shareSection(html);
    expect(share).toContain(
      `href="${CANONICAL}" data-copy-link="${CANONICAL}" data-testid="event-copy-link">Copy link</a>`,
    );
    expect(share).toContain('data-testid="event-copy-toast"');
  });

  it("H4: past share offers a way forward to the past archive", async () => {
    const { html } = await honoHtml({ ...PAST_OVER });
    const share = shareSection(html);
    expect(share, "Hono: browse past events link text").toContain("Browse past events");
    const wayForward = shareWayForward(share);
    expect(wayForward, "Hono past share way forward present").not.toBeNull();
    expect(wayForward, "Hono past share way forward destination").toBe("/events/past");
  });

  it("H5: elapsed published detail renders the honest past share box", async () => {
    const { status, html } = await honoHtml({ ...ELAPSED_PUBLISHED_OVER });
    expect(status).toBe(200);
    expectHonestPastShare(shareSection(html), "Hono elapsed");
  });
});

describe("past-event share acceptance (Kit)", () => {
  it("K1: past detail renders an honest share heading instead of Save the date", async () => {
    const html = await kitHtml({ ...PAST_OVER });
    expect(html).toContain('data-testid="event-past"');
    const share = shareSection(html);
    expect(shareHeading(share)).toBe("Share this event");
    expect(share).not.toContain("Save the date");
  });

  it("K2: past share drops the Add-to-calendar actions or relabels them as record-keeping", async () => {
    const share = shareSection(await kitHtml({ ...PAST_OVER }));
    expect(share).not.toContain("Add to calendar");
    const keepsCalendarLinks =
      share.includes('data-testid="event-ics"') ||
      share.includes('data-testid="event-google-calendar"');
    if (keepsCalendarLinks) {
      expect(share).toMatch(/record|download|keepsake|memento/i);
    }
  });

  it("K3: past share keeps Copy link and the toast", async () => {
    const share = shareSection(await kitHtml({ ...PAST_OVER }));
    expect(share).toContain('data-testid="event-copy-link"');
    expect(share).toContain(`data-copy-link="${CANONICAL}"`);
    expect(share).toContain('data-testid="event-copy-toast"');
  });

  it("K4: past share offers a way forward to the past archive", async () => {
    const share = shareSection(await kitHtml({ ...PAST_OVER }));
    expect(share, "Kit: browse past events link text").toContain("Browse past events");
    const wayForward = shareWayForward(share);
    expect(wayForward, "Kit past share way forward present").not.toBeNull();
    expect(wayForward, "Kit past share way forward destination").toBe("/events/past");
  });

  it("K5: elapsed published detail renders the honest past share box", async () => {
    expectHonestPastShare(
      shareSection(await kitHtml({ ...ELAPSED_PUBLISHED_OVER })),
      "Kit elapsed",
    );
  });
});

describe("past share twin parity", () => {
  it("P1: both twins agree on the honest past share heading", async () => {
    const hono = shareHeading(shareSection((await honoHtml({ ...PAST_OVER })).html));
    const kit = shareHeading(shareSection(await kitHtml({ ...PAST_OVER })));
    expect(hono).toBe("Share this event");
    expect(kit).toBe(hono);
  });

  it("P2: both twins agree on the past share way-forward destination", async () => {
    const honoShare = shareSection((await honoHtml({ ...PAST_OVER })).html);
    const kitShare = shareSection(await kitHtml({ ...PAST_OVER }));
    expect(honoShare, "Hono: browse past events link text").toContain("Browse past events");
    expect(kitShare, "Kit: browse past events link text").toContain("Browse past events");
    const hono = shareWayForward(honoShare);
    const kit = shareWayForward(kitShare);
    expect(hono, "Hono past share way forward present").not.toBeNull();
    expect(hono, "Hono past share way forward destination").toBe("/events/past");
    expect(kit).toBe(hono);
  });

  it("P3: the full honest past share bar holds on both twins", async () => {
    expectHonestPastShare(shareSection((await honoHtml({ ...PAST_OVER })).html), "Hono");
    expectHonestPastShare(shareSection(await kitHtml({ ...PAST_OVER })), "Kit");
  });

  it("P4: both twins agree on the honest past share box for an elapsed published row", async () => {
    expectHonestPastShare(
      shareSection((await honoHtml({ ...ELAPSED_PUBLISHED_OVER })).html),
      "Hono elapsed",
    );
    expectHonestPastShare(
      shareSection(await kitHtml({ ...ELAPSED_PUBLISHED_OVER })),
      "Kit elapsed",
    );
  });
});

// Byte-stability pins below. Captured at base (unmodified main): the live
// share box must stay byte-identical through the X1 build.
const HONO_LIVE_SHARE_AT_BASE = `<section class="event-share" aria-labelledby="event-share-heading"><h2 id="event-share-heading">Save the date</h2><p><a href="/events/01ARZ3NDEKTSV4RRFFQ69G5FAV.ics" data-testid="event-ics">Add to calendar (.ics)</a> · <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Chess%20night&amp;dates=20300110T200000Z%2F20300110T220000Z&amp;details=Bring%20a%20friend%20%26%20a%20board.&amp;location=The%20lobby%20%26%20voice%20channel" data-testid="event-google-calendar" rel="noopener">Google Calendar</a> · <a href="https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV" data-copy-link="https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV" data-testid="event-copy-link">Copy link</a></p><p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast="true"></p></section>`;
const KIT_LIVE_SHARE_AT_BASE = `<section class="event-share" aria-labelledby="event-share-heading"><h2 id="event-share-heading">Save the date</h2> <p><a href="/events/01ARZ3NDEKTSV4RRFFQ69G5FAV.ics" data-testid="event-ics">Add to calendar (.ics)</a> <!--[0--> ·  <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Chess%20night&amp;dates=20300110T200000Z%2F20300110T220000Z&amp;details=Bring%20a%20friend%20%26%20a%20board.&amp;location=The%20lobby" data-testid="event-google-calendar" rel="noopener">Google Calendar</a><!--]-->  ·  <a href="https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV" data-copy-link="https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV" data-testid="event-copy-link">Copy link</a></p> <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast=""></p></section>`;

describe("live/upcoming share byte-stability", () => {
  it("S1: Hono live share box is byte-stable", async () => {
    const { status, html } = await honoHtml({});
    expect(status).toBe(200);
    const share = shareSection(html);
    expect(share).toContain('<h2 id="event-share-heading">Save the date</h2>');
    expect(share).toContain(`href="/events/${KEY}.ics" data-testid="event-ics"`);
    expect(share).toContain("Add to calendar (.ics)");
    expect(share).toContain('data-testid="event-google-calendar"');
    expect(share).toContain("calendar.google.com");
    expect(share).toContain(
      `href="${CANONICAL}" data-copy-link="${CANONICAL}" data-testid="event-copy-link">Copy link</a>`,
    );
    expect(share).toContain('data-testid="event-copy-toast"');
    expect(share).toBe(HONO_LIVE_SHARE_AT_BASE);
  });

  it("S2: Kit live share box is byte-stable", async () => {
    const share = shareSection(await kitHtml({}));
    expect(share).toContain('<h2 id="event-share-heading">Save the date</h2>');
    expect(share).toContain(`href="/events/${KEY}.ics" data-testid="event-ics"`);
    expect(share).toContain("Add to calendar (.ics)");
    expect(share).toContain('data-testid="event-google-calendar"');
    expect(share).toContain("calendar.google.com");
    expect(share).toContain('data-testid="event-copy-link"');
    expect(share).toContain(`data-copy-link="${CANONICAL}"`);
    expect(share).toContain('data-testid="event-copy-toast"');
    expect(share).toBe(KIT_LIVE_SHARE_AT_BASE);
  });
});

describe("cancelled/draft branch stability", () => {
  it("S3: Hono cancelled branch stays a 410 with the upcoming way back and no share box", async () => {
    const { status, html, headers } = await honoHtml({ status: "cancelled" });
    expect(status).toBe(410);
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain('data-testid="event-cancelled"');
    expect(html).toContain('href="/events"');
    expect(html).toContain("See upcoming events");
    expect(html).not.toContain("event-share-heading");
    expect(html).not.toContain('data-testid="event-ics"');
    expect(html).not.toContain('data-testid="event-copy-link"');
  });

  it("S4: Kit cancelled branch stays a 410 with the upcoming way back and no share box", async () => {
    const { outcome } = await kitResolve(
      KEY,
      kitFakeStore({ event: { ...kitRow({ status: "cancelled" }), goingCount: 3 } as PublicEvent }),
    );
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    const { renderGone } = await buildKitEventDetailBundle();
    const html = renderGone(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-cancelled"');
    expect(html).toContain('href="/events"');
    expect(html).not.toContain("event-share-heading");
    expect(html).not.toContain('data-testid="event-ics"');
  });

  it("S5: Hono draft keeps the live share box for moderators and stays 403 for guests", async () => {
    const source = honoFixture({ status: "draft" });
    const guest = await source.request();
    expect(guest.status).toBe(403);
    const modCookie = await source.sessionCookie(MOD_ID, { member: true, moderator: true });
    const response = await source.request(modCookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="event-draft"');
    const share = shareSection(html);
    expect(share).toContain('<h2 id="event-share-heading">Save the date</h2>');
    expect(share).toContain(`href="/events/${KEY}.ics" data-testid="event-ics"`);
    expect(share).toContain('data-testid="event-google-calendar"');
    expect(share).toContain('data-testid="event-copy-link"');
    expect(share).toContain('data-testid="event-copy-toast"');
  });

  it("S6: Kit draft keeps the live share box for moderators and stays forbidden for guests", async () => {
    const draft = { ...kitRow({ status: "draft" }), goingCount: 0 } as PublicEvent;
    const guest = await kitResolve(KEY, kitFakeStore({ event: draft }), KIT_GUEST);
    expect(guest.outcome.kind).toBe("forbidden");
    if (guest.outcome.kind !== "forbidden") throw new Error("unreachable");
    expect(guest.outcome.status).toBe(403);
    const { outcome } = await kitResolve(
      KEY,
      kitFakeStore({ event: draft }),
      kitMemberSession(MOD_ID, true),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.isDraft).toBe(true);
    const { renderDetail } = await buildKitEventDetailBundle();
    const share = shareSection(renderDetail(outcome.model as unknown as Record<string, unknown>));
    expect(share).toContain('<h2 id="event-share-heading">Save the date</h2>');
    expect(share).toContain(`href="/events/${KEY}.ics" data-testid="event-ics"`);
    expect(share).toContain('data-testid="event-google-calendar"');
    expect(share).toContain('data-testid="event-copy-link"');
    expect(share).toContain('data-testid="event-copy-toast"');
  });
});
