// route-inventory: GET /e/:key
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { EventAttendee, ViewerRsvp } from "../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// Detail share matrix for the event page (fixture-only): canonical, title,
// time, venue and description render for every viewer; a guest sees the join
// pitch and never attendee names while a member sees their own RSVP answer;
// capacity copy pins spots-left and waitlist wording at full and
// over-capacity. Real Drizzle queries and Hono/session rendering; no DB.
const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const CANONICAL = `${APP_URL}${PATH}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER_ID = "100000000000000001";

type Answer = { status: string; syncedToDiscordAt: Date | null };

function fixture(
  over: Partial<typeof events.$inferSelect> = {},
  opts: {
    going?: number;
    occupancy?: number;
    answers?: Record<string, Answer>;
    attendees?: EventAttendee[];
  } = {},
) {
  const { going = 3, occupancy, answers = {}, attendees = [] } = opts;
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
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
  const queries: string[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push(sql);
    // Waitlist line rank is empty in this fixture (position fallback).
    if (sql.includes("row_number()")) return { rows: [] };
    if (
      sql.includes('from "rsvps"') &&
      sql.includes('inner join "users"') &&
      !sql.includes("group by")
    ) {
      // Member-only attendee projection: positional for the pg-proxy mapper,
      // named for the keyed-read owner projection. The attributable
      // going-count aggregate joins too, so it falls through to the count arm.
      return {
        rows: attendees.map((a) => Object.assign([a.id, a.name], { id: a.id, name: a.name })),
      };
    }
    if (sql.includes('from "rsvps"')) {
      if (sql.includes("count(*)") || sql.includes("group by")) {
        // The named going count joins users; seat occupancy does not. They
        // diverge when a nameless going row holds a seat.
        const n = sql.includes('inner join "users"') ? going : (occupancy ?? going);
        return { rows: [[row.id, n]] };
      }
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
    queries,
    env,
    async cookie(moderator = false) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: MEMBER_ID,
        username: "member",
        avatar: null,
        member: true,
        moderator,
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

describe("Event detail share matrix (fixture-only)", () => {
  it("renders the share matrix: canonical, title, time, venue and description", async () => {
    const html = await (await fixture().request()).text();
    expect(html).toContain(`rel="canonical" href="${CANONICAL}"`);
    expect(html).toContain(`property="og:url" content="${CANONICAL}"`);
    expect(html).toContain(
      `href="${CANONICAL}" data-copy-link="${CANONICAL}" data-testid="event-copy-link">Copy link</a>`,
    );
    expect(html).toContain("<title>Chess night — Together We Own</title>");
    expect(html).toContain('<h1 data-waitlist-position="">Chess night</h1>');
    expect(html).toContain('property="og:title" content="Chess night — Together We Own"');
    expect(html).toContain('<time datetime="2030-01-10T20:00:00.000Z">');
    expect(html).toContain("10 January 2030");
    expect(html).toContain('data-testid="event-venue">The lobby &amp; voice channel');
    expect(html).toContain("<p>Bring a friend &amp; a board.</p>");
    expect(html).toContain('property="og:description" content="Bring a friend &amp; a board."');
    expect(html).toContain("3 of 10 going");
  });

  it("shows a guest the join pitch and never attendee names, even with attendees stored", async () => {
    const source = fixture({}, { attendees: [{ id: MEMBER_ID, name: "member" }] });
    const html = await (await source.request()).text();
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain(`href="/join?next=${encodeURIComponent(PATH)}"`);
    expect(html).toContain("Log in with Discord");
    expect(html).not.toContain('data-testid="event-attendees"');
    // The roster is named, not hidden: the guest nudge carries the count and
    // the sign-in return, never identities.
    expect(html).toContain('data-testid="event-roster-guest-nudge"');
    expect(html).toContain("Who&#39;s going");
    expect(html).toContain("sign in to see who&#39;s in");
    expect(html).toContain(`href="/join/discord?next=${encodeURIComponent(PATH)}"`);
    expect(html).not.toContain("/members/");
    expect(html).not.toContain(">member</a>");
    // No roster-shaped read runs for guests; the public attributable count
    // still joins users (non-sensitive aggregate, never identities).
    expect(
      source.queries.filter((q) => q.includes('inner join "users"') && !q.includes("group by")),
    ).toHaveLength(0);
  });

  it("shows a guest on a zero-named-going event its own nudge line, never a 0-going line", async () => {
    const source = fixture({}, { going: 0 });
    const html = await (await source.request()).text();
    expect(html).toContain('data-testid="event-roster-guest-nudge"');
    // The roster lists named going rows only: an empty list never claims
    // there are no RSVP responses, and never promises a first going seat.
    expect(html).toContain("No one is listed as going yet.");
    expect(html).not.toMatch(/No RSVPs(\.| yet)/);
    expect(html).not.toContain("sign in to be the first");
    expect(html).toContain(`href="/join/discord?next=${encodeURIComponent(PATH)}"`);
    // The old nudge line is gone; the lineup's "0 of 10 going" stays.
    expect(html).not.toContain("0 going —");
  });

  it("shows a member their going answer and their linked attendee name, never the pitch", async () => {
    const source = fixture(
      {},
      {
        answers: { [MEMBER_ID]: { status: "going", syncedToDiscordAt: null } },
        attendees: [{ id: MEMBER_ID, name: "member" }],
      },
    );
    const html = await (await source.request(await source.cookie())).text();
    expect(html).not.toContain('data-testid="event-join-pitch"');
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(html).toContain("You&#39;re in");
    expect(html).toContain('data-testid="rsvp-withdraw"');
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain(`<a href="/members/${MEMBER_ID}">member</a>`);
  });

  it("shows an unanswered member the going control with spots left", async () => {
    const source = fixture({ capacity: 10 }, { going: 3 });
    const html = await (await source.request(await source.cookie())).text();
    expect(html).toContain("<span data-count>3 of 10 going</span>");
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">7 of 10 spots left</span>");
    expect(html).toContain('data-testid="rsvp-going"');
    expect(html).not.toContain('data-testid="event-full"');
  });

  it("pins full capacity with the cap beside it and the waitlist join, never a going button", async () => {
    const source = fixture({ capacity: 4 }, { going: 4 });
    const html = await (await source.request(await source.cookie())).text();
    expect(html).toContain("<span data-count>4 of 4 going</span>");
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">Full</span>");
    expect(html).toContain("This one&#39;s full. Cap is 4.");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
  });

  it("clamps over-capacity to Full with the waitlist, never a going button", async () => {
    const source = fixture({ capacity: 4 }, { going: 6 });
    const html = await (await source.request(await source.cookie())).text();
    expect(html).toContain("<span data-count>6 of 4 going</span>");
    expect(html).toContain(">Full</span>");
    expect(html).toContain("This one&#39;s full. Cap is 4.");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
  });

  it.each([
    ["expanded endsAt only", "2030-01-10T20:00:00Z", "+010000-01-10T22:00:00Z"],
    ["negative startsAt only", "-000001-01-10T20:00:00Z", "2030-01-10T22:00:00Z"],
    ["expanded", "+010000-01-10T20:00:00Z", "+010000-01-10T22:00:00Z"],
    ["negative", "-000001-01-10T20:00:00Z", "-000001-01-10T22:00:00Z"],
  ])(
    "keeps the page 200 with the other share links for %s-year boundaries",
    async (_label, startsAt, endsAt) => {
      // Read-eligible (finite) but not ICS-wire-formattable: the page must
      // survive by omitting only the Google Calendar deep link.
      const source = fixture({ startsAt: new Date(startsAt), endsAt: new Date(endsAt) });
      const response = await source.request();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="event-ics"');
      expect(html).toContain('data-testid="event-copy-link"');
      expect(html).not.toContain('data-testid="event-google-calendar"');
      expect(html).not.toContain("calendar.google.com");
    },
  );
});

describe("Event detail closed/paused roster copy (fixture-only)", () => {
  afterEach(() => vi.useRealTimers());

  function freezeRosterClock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-10T21:00:00Z"));
  }

  // Past, paused and draft events keep a plain honest empty line with no
  // RSVP invitation: the RSVP block on the same page already says no seat
  // can be taken. A guest who could still act (a populated roster to see)
  // keeps the sign-in nudge. Drafts 403 for non-moderators, so the draft
  // guest has no roster surface to pin.
  const PAST_START = new Date("2020-01-10T20:00:00Z");
  const PAST_END = new Date("2020-01-10T22:00:00Z");

  it.each([
    ["past status", { status: "past" }, "This one has been and gone", false],
    [
      "ended event",
      { startsAt: PAST_START, endsAt: PAST_END },
      "This one has been and gone",
      false,
    ],
    ["paused RSVPs", { rsvpOpen: false }, "RSVPs are paused for this event", false],
    ["draft", { status: "draft" }, "Not published yet", true],
  ])(
    "member on an empty roster sees a plain line on %s, never an invitation",
    async (_label, over, verdict, moderator) => {
      if (_label === "paused RSVPs") freezeRosterClock();
      const source = fixture(over, { going: 0, attendees: [] });
      const response = await source.request(await source.cookie(moderator));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(verdict);
      expect(html).toContain('data-testid="event-roster-empty"');
      expect(html).toContain("No one is listed as going yet.");
      expect(html).not.toMatch(/No RSVPs(\.| yet)/);
      expect(html).not.toContain("RSVP to start the list");
    },
  );

  it.each([
    ["past status", { status: "past" }, "This one has been and gone"],
    ["ended event", { startsAt: PAST_START, endsAt: PAST_END }, "This one has been and gone"],
    ["paused RSVPs", { rsvpOpen: false }, "Log in with Discord"],
  ])(
    "guest on a zero-named-going event sees a plain line on %s, never a be-the-first nudge",
    async (_label, over, rsvpCopy) => {
      if (_label === "paused RSVPs") freezeRosterClock();
      const source = fixture(over, { going: 0, attendees: [] });
      const response = await source.request();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(rsvpCopy);
      expect(html).toContain('data-testid="event-roster-guest-nudge"');
      expect(html).toContain("No one is listed as going yet.");
      expect(html).not.toMatch(/No RSVPs(\.| yet)/);
      expect(html).not.toContain("sign in to be the first");
    },
  );

  it.each([
    ["maybe", "maybe", /down as a maybe/i],
    ["waitlisted", "waitlisted", /on the waitlist/i],
  ])(
    "member with a current %s answer and no listed going sees no listed going, never 'no RSVPs'",
    async (_label, status, answerCopy) => {
      freezeRosterClock();
      // Correction: the roster lists named going rows only, so an existing
      // maybe/waitlisted answer beside an empty roster must not be
      // contradicted by a "no RSVP responses" claim.
      const source = fixture(
        {},
        {
          going: 0,
          attendees: [],
          answers: { [MEMBER_ID]: { status, syncedToDiscordAt: null } },
        },
      );
      const response = await source.request(await source.cookie());
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toMatch(answerCopy);
      expect(html).toContain('data-testid="event-roster-empty"');
      expect(html).toContain("No one is listed as going yet.");
      expect(html).not.toMatch(/No RSVPs(\.| yet)/);
      expect(html).not.toContain("RSVP to start the list");
    },
  );

  it("full by a nameless seat: waitlist action beside a neutral empty roster, never a first-going invite", async () => {
    freezeRosterClock();
    // Correction: capacity 1, goingOccupancy 1, named goingCount 0 and an
    // empty named roster — the divergent fixture shape from the
    // going-count/roster agreement contract. The adjacent action offers
    // only the waitlist, so roster copy must not invite a going RSVP.
    const source = fixture({ capacity: 1 }, { going: 0, occupancy: 1, attendees: [] });
    const response = await source.request(await source.cookie());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<span data-count>0 of 1 going</span>");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
    expect(html).toContain('data-testid="event-roster-empty"');
    expect(html).toContain("No one is listed as going yet.");
    expect(html).not.toMatch(/No RSVPs(\.| yet)|RSVP to start the list|sign in to be the first/);
  });

  it("guest on a past event with RSVPs keeps the sign-in nudge for a roster they can still see", async () => {
    const source = fixture(
      { status: "past" },
      { going: 2, attendees: [{ id: MEMBER_ID, name: "member" }] },
    );
    const response = await source.request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("This one has been and gone");
    expect(html).toContain('data-testid="event-roster-guest-nudge"');
    expect(html).toContain("2 going");
    expect(html).toContain("sign in to see who&#39;s in");
  });
});
