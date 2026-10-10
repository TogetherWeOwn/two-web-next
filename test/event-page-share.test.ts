// route-inventory: GET /e/:key
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
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
  opts: { going?: number; answers?: Record<string, Answer>; attendees?: EventAttendee[] } = {},
) {
  const { going = 3, answers = {}, attendees = [] } = opts;
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
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) {
      // Member-only attendee projection: positional for the pg-proxy mapper,
      // named for the keyed-read owner projection.
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
    queries,
    env,
    async cookie() {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: MEMBER_ID,
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
    expect(html).not.toContain("Who&#39;s going");
    expect(html).not.toContain("/members/");
    expect(html).not.toContain(">member</a>");
    expect(source.queries.filter((q) => q.includes('inner join "users"'))).toHaveLength(0);
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
});
