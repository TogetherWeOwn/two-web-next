// Admin event fill column + UTC labels (TOG-11708).
// Ledger gaps docs/w15-events-acceptance-ledger.md:136,138: the fill filter
// (test/admin-event-list.test.ts) proves Going-only selection, but nothing
// proves the rendered Fill column or the explicit UTC column label. Roster
// counts and form-conversion tests are not proof of this table column.
import { jsx } from "hono/jsx/jsx-runtime";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { EventsPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import { type EventListRow } from "../src/admin/store";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const viewer = "100000000000000117"; // Discord snowflake: the read boundary refuses non-numeric viewers.

async function cookieFor(store: SessionStore) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token), userId: viewer, username: "mod", avatar: null,
    member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET!, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

function row(over: Partial<EventListRow> & { eventKey: string }): EventListRow {
  const at = new Date("2026-06-15T00:30:00Z");
  const { eventKey, ...rest } = over;
  return {
    id: 1, eventKey, title: eventKey, game: null, description: null,
    startsAt: at, endsAt: new Date("2026-06-15T02:30:00Z"), timezone: "UTC", location: null,
    capacity: null, status: "published", discordEventId: null, discordSyncFailedAt: null,
    discordSyncFailureCode: null, createdBy: null, rsvpOpen: true, recurrenceFrequency: null,
    recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: at, updatedAt: at, icsSequence: 0n, syncRevision: 0, syncedRevision: 0, goingCount: 0, ...rest,
  };
}

/** Raw inner HTML of one row's Fill cell (order-independent). */
function fillCell(html: string, key: string): string {
  const m = html.match(new RegExp(`<td data-testid="event-fill-${key}">([\\s\\S]*?)</td>`));
  if (!m) throw new Error(`no fill cell for ${key}`);
  return m[1]!;
}

const DEFAULT_QUERY = parseEventListQuery({});

describe("admin event fill column and UTC labels (no DB)", () => {
  const rows = [
    row({ eventKey: "fill-partial", goingCount: 1, capacity: 4 }),
    row({ eventKey: "fill-full", goingCount: 2, capacity: 2 }),
    row({ eventKey: "fill-over", goingCount: 3, capacity: 2 }),
    row({ eventKey: "fill-open", goingCount: 3, capacity: null }),
    row({ eventKey: "fill-empty", goingCount: 0, capacity: 3 }),
  ];
  const html = String(jsx(EventsPage, { rows, query: DEFAULT_QUERY, hasNext: false }));

  it("labels the starts column as UTC in the header and its sort toggle", () => {
    expect(html).toContain("Starts (UTC)");
    expect(html).toContain('aria-label="Sort by starts (utc) ascending"');
    expect(html).not.toContain(">Starts<");
  });

  it("renders UTC instants inside <time datetime> bytes", () => {
    expect(html).toContain('<time datetime="2026-06-15T00:30:00.000Z">2026-06-15T00:30:00.000Z</time>');
  });

  it("renders the same UTC bytes for one instant in two zones (London/New York rollover)", () => {
    const instant = new Date("2026-06-15T00:30:00Z"); // 01:30 BST, June 14 20:30 EDT
    const pair = String(jsx(EventsPage, {
      rows: [
        row({ eventKey: "fill-london", timezone: "Europe/London", startsAt: instant, goingCount: 1, capacity: 4 }),
        row({ eventKey: "fill-new-york", timezone: "America/New_York", startsAt: instant, goingCount: 1, capacity: 4 }),
      ],
      query: DEFAULT_QUERY, hasNext: false,
    }));
    const bytes = pair.match(/<time datetime="([^"]+)">[^<]*<\/time>/g);
    expect(bytes).toHaveLength(2);
    expect(bytes![0]).toBe(bytes![1]);
    expect(bytes![0]).toContain("2026-06-15T00:30:00.000Z");
  });

  it("renders a New York evening wall time as the UTC date, not the wall date", () => {
    // 2026-01-15T02:00Z is still Jan 14 in New York; the table shows Jan 15 UTC.
    const ny = String(jsx(EventsPage, {
      rows: [row({
        eventKey: "fill-ny-evening", timezone: "America/New_York",
        startsAt: new Date("2026-01-15T02:00:00Z"),
        endsAt: new Date("2026-01-15T04:00:00Z"), goingCount: 0, capacity: null,
      })],
      query: DEFAULT_QUERY, hasNext: false,
    }));
    expect(ny).toContain('<time datetime="2026-01-15T02:00:00.000Z">2026-01-15T02:00:00.000Z</time>');
  });

  it("counts Going-only seats with uncapped display and full/over-capacity badges", () => {
    expect(fillCell(html, "fill-partial")).toBe("1 of 4 going");
    expect(fillCell(html, "fill-empty")).toBe("0 of 3 going");
    expect(fillCell(html, "fill-open")).toBe("3 going");
    const full = fillCell(html, "fill-full");
    expect(full).toContain("2 of 2 going");
    expect(full).toContain('data-testid="event-fill-badge-fill-full"');
    expect(full).toContain("Full");
    expect(full).not.toContain("event-over-capacity-");
    const over = fillCell(html, "fill-over");
    expect(over).toContain("3 of 2 going");
    expect(over).toContain('data-testid="event-fill-badge-fill-over"');
    expect(over).toContain('data-testid="event-over-capacity-fill-over"');
    expect(over).toContain("Over capacity");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin event fill labels (isolated agent-testdb / CI fixture)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  let cookie: string;
  const app = () => adminApp({ sessionStore: store, db: fixture.db });
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(() => fixture?.dispose());

  beforeEach(async () => {
    await fixture.reset();
    cookie = await cookieFor(store);
    const defs = [
      // [key, title, capacity, startsAt, timezone]
      ["fill-partial", "Fill Partial", 4, "2026-11-01T20:00:00Z", "Europe/London"],
      ["fill-full", "Fill Full", 2, "2026-11-02T20:00:00Z", "Europe/London"],
      ["fill-over", "Fill Over", 1, "2026-11-03T20:00:00Z", "Europe/London"],
      ["fill-open", "Fill Open", null, "2026-11-04T20:00:00Z", "Europe/London"],
      // Same instant, two zones: 01:30 BST in London, June 14 20:30 EDT in New York.
      ["fill-london", "Fill London", 4, "2026-06-15T00:30:00Z", "Europe/London"],
      ["fill-new-york", "Fill New York", 4, "2026-06-15T00:30:00Z", "America/New_York"],
    ] as const;
    const ids: Record<string, number> = {};
    for (const [key, title, capacity, startsAt, timezone] of defs) {
      const [inserted] = await fixture.db.insert(events).values({
        eventKey: key, title, status: "published", capacity, timezone,
        startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 2 * 3600_000),
      }).returning();
      ids[key] = inserted!.id;
    }
    const rsvp = (key: string, status: string, n: number, who: string) =>
      fixture.db.insert(rsvps).values(Array.from({ length: n }, (_, i) => ({
        eventId: ids[key]!, userId: `${who}-${i}`, status,
      })));
    // Going-only proof: Maybe/Waitlist/Not going never occupy a seat.
    await rsvp("fill-partial", "going", 1, "partial-going");
    await rsvp("fill-partial", "maybe", 2, "partial-maybe");
    await rsvp("fill-partial", "waitlisted", 1, "partial-waitlisted");
    await rsvp("fill-partial", "not_going", 1, "partial-declined");
    await rsvp("fill-full", "going", 2, "full-going");
    await rsvp("fill-full", "maybe", 3, "full-maybe");
    await rsvp("fill-over", "going", 2, "over-going");
    await rsvp("fill-open", "going", 3, "open-going");
    await rsvp("fill-open", "maybe", 2, "open-maybe");
    await rsvp("fill-london", "going", 1, "london-going");
    await rsvp("fill-new-york", "going", 1, "ny-going");
  });

  it("renders Going-only fill cells, UTC labels and identical bytes across zones", async () => {
    const res = await app().request("/events?sort=starts_at&order=asc", { headers: { cookie } }, bindings());
    expect(res.status).toBe(200);
    const html = await res.text();
    // UTC column label, header and sort toggle (starts_at asc is active, so the toggle offers descending).
    expect(html).toContain("Starts (UTC)");
    expect(html).toContain('aria-label="Sort by starts (utc) descending"');
    expect(html).toContain("<th scope=\"col\">Fill</th>");
    // Going-only: distractors never occupy a seat.
    expect(fillCell(html, "fill-partial")).toBe("1 of 4 going");
    expect(fillCell(html, "fill-open")).toBe("3 going");
    // Full and over-capacity badges.
    const full = fillCell(html, "fill-full");
    expect(full).toContain("2 of 2 going");
    expect(full).toContain("Full");
    expect(full).not.toContain("Over capacity");
    const over = fillCell(html, "fill-over");
    expect(over).toContain("2 of 1 going");
    expect(over).toContain("Full");
    expect(over).toContain("Over capacity");
    // Same instant, two zones: identical UTC bytes.
    const london = html.match(/<time datetime="([^"]+)">[^<]*<\/time>/g)
      ?.filter((t) => t.includes("2026-06-15T00:30:00.000Z"));
    expect(london).toHaveLength(2);
  });
});
