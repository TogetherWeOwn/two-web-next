// route-inventory: GET /e/:key
// route-inventory: GET /events/:file{.+\.ics}
// Failing-first acceptance: the Hono cancelled-event page offers the same
// alternatives and calendar download as Kit (roadmap Q1).
//
// Owned by the Test Author; the Builder builds on this branch and never edits
// this file. Hermetic pg-proxy fixture: no DATABASE_URL, no network, no
// session reads on the cancelled branch. RED tests fail on current main
// (Hono renders no alternatives and no ICS link); CONTROL tests pass before
// and after, proving the fixture is live and the preserved contract holds.
//
// The Hono block must mirror the Kit gone block at build HEAD
// (web/src/lib/EventGone.svelte + src/kit-event-states.ts):
// data-testid="event-cancelled-alternatives" for the list and
// data-testid="event-cancelled-ics" for the per-event .ics download href.
// Forward-compatible with the Kit-only heading/datetime/testid extension that
// is still in review: an extra heading, <time datetime> and per-link testids
// are allowed on either twin, never required here.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { EventLink, PublicEvent } from "../src/events/reads";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const CANCELLED_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FA9";

type CancelledRow = typeof events.$inferSelect;

function cancelledRow(): CancelledRow {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: CANCELLED_KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "cancelled",
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
  };
}

// Two upcoming same-game siblings: one with a venue, one without, so the
// location conditional is pinned without pinning the Kit-only extension.
const RELATED: EventLink[] = [
  {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    endsAt: new Date("2030-02-01T21:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    game: null,
    rsvpOpen: true,
  },
  {
    id: 11,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Chess open",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    endsAt: new Date("2030-03-01T21:00:00Z"),
    timezone: "UTC",
    location: null,
    game: null,
    rsvpOpen: true,
  },
];

// Served Hono answers through a disposable pg-proxy fixture. The SQL dispatch
// mirrors the reads the cancelled branch performs: a single-row lookup by key
// (getPublicEvent, no status predicate), the status-filtered sibling lookup
// (listRelatedEvents) and the going-count aggregates. Everything else finds
// nothing, as in the Kit event-state suite.
function honoFixture(opts: { related?: EventLink[]; relatedError?: Error } = {}) {
  const row = cancelledRow();
  const columns = Object.keys(getTableColumns(events)) as (keyof CancelledRow)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) {
      return sql.includes("count(*)") ? { rows: [[row.id, 0]] } : { rows: [] };
    }
    if (sql.includes('from "events"')) {
      // Predicate dispatch, not bare column names: the single-row lookup
      // selects every column (including "status"), so only a status predicate
      // identifies the sibling lookup.
      if (sql.includes('"event_key" =') && !sql.includes('"status" =')) {
        if (!Array.isArray(params) || !params.includes(CANCELLED_KEY)) return { rows: [] };
        return {
          rows: [
            columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
          ],
        };
      }
      if (sql.includes('"status" =')) {
        if (opts.relatedError) throw opts.relatedError;
        const links = opts.related ?? RELATED;
        return {
          rows: links.map((link) => [
            link.id,
            link.eventKey,
            link.title,
            link.startsAt.toISOString(),
            link.endsAt.toISOString(),
            link.timezone,
            link.location,
            link.game,
            link.rsvpOpen,
          ]),
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
  const sessionStore = createMemorySessionStore();
  const honoEnv = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: sessionStore,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    async memberCookie() {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000001",
        username: "member",
        avatar: null,
        member: true,
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
    },
    request(cookie?: string, path = `/e/${CANCELLED_KEY}`) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, honoEnv);
    },
  };
}

// Shared Kit model for the same cancelled row + siblings, through the same
// fail-open resolver the Kit presentation binds to. No session, cookie or
// viewer flows through any seam.
function kitStore(opts: { related?: EventLink[]; relatedError?: Error } = {}): EventStateStore {
  const event = { ...(cancelledRow() as unknown as PublicEvent), goingCount: 0 };
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    relatedFn: async () => {
      if (opts.relatedError) throw opts.relatedError;
      return opts.related ?? RELATED;
    },
    suggestionsFn: async () => [],
  };
}

async function kitGoneModel(opts: { related?: EventLink[]; relatedError?: Error } = {}) {
  const outcome = await resolveEventState({
    key: CANCELLED_KEY,
    search: "",
    path: `/e/${CANCELLED_KEY}`,
    env: { APP_URL } as unknown as Env,
    setHeaders: () => {},
    store: kitStore(opts),
  });
  if (outcome.kind !== "gone") throw new Error(`expected a gone model, got ${outcome.kind}`);
  return outcome.model;
}

function alternativesSection(html: string): string | null {
  const match = html.match(
    /<ul[^>]*data-testid="event-cancelled-alternatives"[^>]*>[\s\S]*?<\/ul>/,
  );
  return match ? match[0] : null;
}

describe("Hono cancelled alternatives + ICS (RED: missing until the build lands)", () => {
  it("lists upcoming same-game alternatives with title links, time and location", async () => {
    const source = honoFixture();
    const res = await source.request();
    expect(res.status).toBe(410);
    const html = await res.text();
    const section = alternativesSection(html);
    expect(section, "Hono 410 carries the alternatives list").not.toBeNull();
    for (const link of RELATED) {
      expect(section).toContain(link.title);
      expect(section).toContain(`href="/e/${link.eventKey}"`);
    }
    // The venue sibling names its location; the list renders times (the 2030
    // fixture year proves these are the siblings' instants, not static copy).
    // Either twin's formatter satisfies this: the exact string is not pinned.
    expect(section).toContain("The lobby");
    expect(section).toContain("<time");
    expect(section).toContain("2030");
  });

  it("offers a per-event calendar download link", async () => {
    const source = honoFixture();
    const html = await (await source.request()).text();
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).toContain(`href="/events/${CANCELLED_KEY}.ics"`);
  });
});

describe("fail-open alternatives lookup (RED: ICS without alternatives, never 500)", () => {
  it("renders 410 with ICS and no alternatives when the lookup fails", async () => {
    const source = honoFixture({ relatedError: new Error("related lookup down") });
    const res = await source.request();
    expect(res.status).toBe(410);
    expect(res.status).not.toBe(500);
    const html = await res.text();
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).toContain(`href="/events/${CANCELLED_KEY}.ics"`);
    expect(html).not.toContain('data-testid="event-cancelled-alternatives"');
    expect(html).toContain('href="/events">See upcoming events</a>');
  });
});

describe("empty alternatives (RED: dead-end-free page keeps ICS, no empty list)", () => {
  it("renders no empty list markup when no alternatives exist", async () => {
    const source = honoFixture({ related: [] });
    const res = await source.request();
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).not.toContain('data-testid="event-cancelled-alternatives"');
    expect(html).toContain('href="/events">See upcoming events</a>');
  });
});

describe("preserved gone contract (CONTROL: green before and after)", () => {
  it("keeps 410, private no-store and noindex for every viewer", async () => {
    const source = honoFixture();
    const viewers: [string, string | undefined][] = [
      ["guest", undefined],
      ["member", await source.memberCookie()],
      ["forged cookie", "__Host-two_session=forged"],
    ];
    for (const [who, cookie] of viewers) {
      const res = await source.request(cookie);
      expect(res.status, who).toBe(410);
      expect(res.headers.get("cache-control"), who).toBe("private, no-store");
      expect(res.headers.get("x-robots-tag"), who).toBe("noindex, nofollow");
    }
    const html = await (await source.request()).text();
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("renders byte-identical HTML for guest and member (session-free)", async () => {
    const source = honoFixture();
    const guestHtml = await (await source.request()).text();
    const memberHtml = await (await source.request(await source.memberCookie())).text();
    expect(memberHtml).toBe(guestHtml);
  });

  it("keeps JSON-LD cancelled status and the way back to upcoming", async () => {
    const source = honoFixture();
    const html = await (await source.request()).text();
    expect(html).toContain("<h1>Chess night</h1>");
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain("https://schema.org/EventCancelled");
    expect(html).toContain('href="/events">See upcoming events</a>');
    expect(html).toContain('data-testid="event-jsonld"');
  });

  it("keeps the gone page free of RSVP, join, canonical and share leaks", async () => {
    const source = honoFixture();
    const html = await (await source.request(await source.memberCookie())).text();
    expect(html).not.toMatch(
      /rel="canonical"|og:|twitter:|event-join-pitch|event-copy-link|event-pagination|event-attendees|event-google-calendar/,
    );
    // The live share testid stays absent: the gone download uses the
    // Kit-mirrored event-cancelled-ics testid, never the live event-ics one.
    expect(html).not.toContain('data-testid="event-ics"');
    expect(html).not.toMatch(/data-testid="rsvp[^"]*"/);
  });

  it("keeps unknown keys 404 and the cancelled ICS downloadable", async () => {
    const source = honoFixture();
    expect((await source.request(undefined, `/e/${UNKNOWN_KEY}`)).status).toBe(404);
    const ics = await source.request(undefined, `/events/${CANCELLED_KEY}.ics`);
    expect(ics.status).toBe(200);
    expect(ics.headers.get("content-type")).toContain("text/calendar");
    expect(await ics.text()).toContain("STATUS:CANCELLED");
  });
});

describe("Hono/Kit parity on shared fixtures (RED: same alternatives and ICS)", () => {
  it("shows the same alternatives and ICS href as Kit", async () => {
    const model = await kitGoneModel();
    expect(model.related).toHaveLength(RELATED.length);
    const source = honoFixture();
    const html = await (await source.request()).text();
    expect(html).toContain(`href="${model.icsUrl}"`);
    expect(html).toContain('data-testid="event-cancelled-ics"');
    const section = alternativesSection(html);
    expect(section, "Hono 410 carries the alternatives list").not.toBeNull();
    for (const alternative of model.related) {
      expect(section).toContain(alternative.title);
      expect(section).toContain(`href="/e/${alternative.key}"`);
      if (alternative.location) expect(section).toContain(alternative.location);
    }
  });

  it("degrades like Kit when the lookup fails", async () => {
    const model = await kitGoneModel({ relatedError: new Error("related lookup down") });
    expect(model.related).toEqual([]);
    const source = honoFixture({ relatedError: new Error("related lookup down") });
    const res = await source.request();
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).not.toContain('data-testid="event-cancelled-alternatives"');
    expect(html).toContain(`href="${model.icsUrl}"`);
  });
});
