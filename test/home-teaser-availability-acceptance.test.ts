// Acceptance: the homepage teaser shows game, host and availability like the
// schedule card (Hono twin plus the shared teaser read).
//
// Owned by the acceptance card: the paired build works from this branch and
// never edits this file; corrections return to the acceptance card.
// Local fixtures only: pg-proxy fakes record real Drizzle SQL, no database.
// Exact command: npx vitest run test/home-teaser-availability-acceptance.test.ts
//
// Contract pinned here (the schedule card in
// src/events/pages-calendar-card.tsx plus `rowAvailability` is the precedent):
// - `listHomeUpcoming` widens its existing full-row select to also project
//   `game`, `organizer_name`, `status`, `endsAt` and `rsvpOpen` — the fields
//   `rowAvailability` reads, plus the trimmed public game/host. No added
//   query, and no member identity field joins the guest-cached payload:
//   the public organizer display name only, never a user id or username.
// - Canonical teaser rows render the trimmed game and
//   `Hosted by {host}` under the schedule card's `event-card-host` testid,
//   only when non-blank, plus one availability snapshot under
//   `event-schedule-availability` ("RSVPs paused", "N seat(s) left",
//   "No seat limit", "Ended"). Seat arithmetic reads `goingOccupancy`
//   (falling back to `goingCount` on older fixtures), never the named count.
// - Exactly full keeps exactly one marker: the `event-spots-left` "Full"
//   node, with no second availability node for the same verdict.
// - A row that ended between read and render reads "Ended" and never
//   advertises seats. Discord rows read "Discord-managed" and keep the
//   invite link, with no going count and no detail link.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listHomeUpcoming, type HomeUpcomingRow } from "../src/events/reads";
import type { DiscordTransient } from "../src/islands/contracts";
import { Home } from "../src/screens/home";

const NOW = new Date("2030-07-04T18:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const FINITE_SEATS = /\b\d+\s+seats?\s+left\b/;

function event(
  id: number,
  overrides: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: "Private host notes",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    organizer_name: null,
    capacity: null,
    status: "published",
    discordEventId: "private-discord-event-id",
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: "private-creator-id",
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function transient(id: string, startOffsetHours: number, title: string): DiscordTransient {
  const startsAt = new Date(NOW.getTime() + startOffsetHours * 3600_000);
  return {
    discordId: id,
    status: "scheduled",
    title,
    description: "Discord public description",
    location: "Lobby voice room",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
  };
}

function fixture(
  rows: (typeof events.$inferSelect)[] = [],
  counts?: { named?: [number, number][]; occupied?: [number, number][] },
  discordRows: DiscordTransient[] = [],
) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    queries.push({ sql, params });
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      const named: [number, number][] = counts?.named ?? [];
      const occupied = counts?.occupied ?? named;
      const countRows = (sql.includes('inner join "users"') ? named : occupied).filter(([id]) =>
        (params as unknown[]).includes(id),
      );
      return { rows: countRows };
    }
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) {
      return {
        rows: rows
          .filter((r) => r.discordEventId !== null && params.includes(r.discordEventId))
          .map((r) => [r.discordEventId]),
      };
    }
    if (sql.includes('"timezone"') && !sql.includes('"title"')) {
      const cutoff = new Date(
        String(params.find((p) => !Number.isNaN(Date.parse(String(p)))) ?? NOW),
      );
      const past = rows
        .filter((r) => r.status !== "draft" && r.endsAt < cutoff)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id - a.id)
        .slice(0, Number(params.at(-1) ?? 20));
      return { rows: past.map((r) => [r.timezone]) };
    }
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >='))
      selected = selected.filter((r) => r.endsAt >= new Date(String(params[1])));
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number(params.at(-1)));
    return {
      rows: selected.map((row) =>
        columns.map((key) => {
          const value = row[key];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => discordRows,
      lastReadFailed: () => false,
    },
  } as Env;
  return { db, env, queries, request: () => app.request("/", {}, env) };
}

/** The one teaser row for `key`, so a sibling's marker cannot satisfy the pin. */
function teaserRow(html: string, key: string): string {
  const hit = html.split('<li class="card"').find((chunk) => chunk.includes(`/e/${key}"`));
  if (!hit) throw new Error(`no teaser row for ${key}`);
  return hit.split("</li>")[0]!;
}

/** The one Discord teaser row carrying `title` (it has no detail link). */
function discordRow(html: string, title: string): string {
  const hit = html
    .split('<li class="card"')
    .find((chunk) => chunk.includes('data-source="discord"') && chunk.includes(title));
  if (!hit) throw new Error(`no discord teaser row for ${title}`);
  return hit.split("</li>")[0]!;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function freezeNow() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("teaser read: widened projection, zero added queries, no member identity", () => {
  it("projects trimmed game/host plus the availability fields from the same reads", async () => {
    const startsAt = new Date(NOW.getTime() + 3600_000);
    const endsAt = new Date(startsAt.getTime() + 7200_000);
    const f = fixture(
      [
        event(1, {
          game: "  Wingspan  ",
          organizer_name: "  Mara Host  ",
          rsvpOpen: false,
          capacity: 4,
          startsAt,
          endsAt,
        }),
        event(2, { game: "   ", organizer_name: "   " }),
      ],
      { named: [[1, 1]], occupied: [[1, 3]] },
    );
    const rows = (await listHomeUpcoming(f.db, NOW)) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    // Zero added queries for the widening: statement timeout setup, the one
    // events select, and the two batched RSVP aggregates — exactly as today.
    expect(f.queries).toHaveLength(4);
    expect(f.queries.filter((q) => q.sql.includes('from "events"'))).toHaveLength(1);
    expect(f.queries.filter((q) => q.sql.includes('from "rsvps"'))).toHaveLength(2);

    const first = rows[0]!;
    expect(Object.keys(first).sort()).toEqual([
      "capacity",
      "endsAt",
      "eventKey",
      "game",
      "goingCount",
      "goingOccupancy",
      "location",
      "organizer_name",
      "rsvpOpen",
      "startsAt",
      "status",
      "timezone",
      "title",
    ]);
    expect(first["game"]).toBe("Wingspan");
    expect(first["organizer_name"]).toBe("Mara Host");
    expect(first["rsvpOpen"]).toBe(false);
    expect(first["status"]).toBe("published");
    expect(first["endsAt"]).toBeInstanceOf(Date);
    expect((first["endsAt"] as Date | undefined)?.getTime?.()).toBe(endsAt.getTime());
    expect(first["goingCount"]).toBe(1);
    expect(first["goingOccupancy"]).toBe(3);
    expect(first["capacity"]).toBe(4);

    // Stored whitespace trims to blank (empty string or null), never a label.
    const blank = rows[1]!;
    expect(blank["game"] ?? "").toBe("");
    expect(blank["organizer_name"] ?? "").toBe("");

    // No member identity or private row data in the guest-cached payload.
    const payload = JSON.stringify(rows);
    for (const privateValue of [
      "private-creator-id",
      "private-discord-event-id",
      "Private host notes",
      '"createdBy"',
      '"discordEventId"',
      '"description"',
      '"userId"',
      '"username"',
    ]) {
      expect(payload).not.toContain(privateValue);
    }
  });
});

describe("Hono teaser: game, host and availability from stored rows", () => {
  it("shows game, host and occupancy-based seats left (singular and plural)", async () => {
    freezeNow();
    const f = fixture(
      [
        event(1, { game: "Wingspan", organizer_name: "Mara Host", capacity: 4 }),
        event(2, { game: "Coup", organizer_name: "Jo Host", capacity: 10 }),
      ],
      {
        named: [
          [1, 1],
          [2, 2],
        ],
        // Occupancy diverges on row 1: 3 seats taken, only 1 named. The
        // seats-left verdict must read occupancy, never the named count.
        occupied: [
          [1, 3],
          [2, 2],
        ],
      },
    );
    const html = await (await f.request()).text();
    const singular = teaserRow(html, "event-1");
    expect(singular).toContain("Wingspan");
    expect(singular).toContain('data-testid="event-card-host"');
    expect(singular).toContain("Hosted by Mara Host");
    expect(singular).toContain("1 of 4 going");
    expect(singular).toContain('data-testid="event-schedule-availability"');
    expect(singular).toContain("1 seat left");
    expect(singular).not.toContain("3 seats left");
    expect(singular).not.toContain("event-spots-left");

    const plural = teaserRow(html, "event-2");
    expect(plural).toContain("Coup");
    expect(plural).toContain("Hosted by Jo Host");
    expect(plural).toContain("8 seats left");
    expect(plural).not.toContain("event-spots-left");

    for (const privateValue of ["private-creator-id", "private-discord-event-id"]) {
      expect(html).not.toContain(privateValue);
    }
  });

  it("reads paused on a paused canonical row, capped or uncapped, advertising no seats", async () => {
    freezeNow();
    const f = fixture(
      [event(1, { rsvpOpen: false, capacity: 10 }), event(2, { rsvpOpen: false, capacity: null })],
      {
        named: [
          [1, 1],
          [2, 1],
        ],
      },
    );
    const html = await (await f.request()).text();
    for (const key of ["event-1", "event-2"]) {
      const row = teaserRow(html, key);
      expect(row).toContain('data-testid="event-schedule-availability"');
      expect(row).toContain("RSVPs paused");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("event-spots-left");
    }
  });

  it("reads paused, never Full, on paused rows that are full or overfull", async () => {
    freezeNow();
    const f = fixture(
      [event(1, { rsvpOpen: false, capacity: 4 }), event(2, { rsvpOpen: false, capacity: 4 })],
      {
        named: [
          [1, 1],
          [2, 1],
        ],
        occupied: [
          [1, 4],
          [2, 6],
        ],
      },
    );
    const html = await (await f.request()).text();
    for (const key of ["event-1", "event-2"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("RSVPs paused");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("Ended");
    }
  });

  it("reads No seat limit on an open uncapped row with no invented finite count", async () => {
    freezeNow();
    const f = fixture([event(1, { capacity: null })], { named: [[1, 3]] });
    const html = await (await f.request()).text();
    const row = teaserRow(html, "event-1");
    expect(row).toContain("3 going");
    expect(row).toContain('data-testid="event-schedule-availability"');
    expect(row).toContain("No seat limit");
    expect(row).not.toMatch(FINITE_SEATS);
    expect(row).not.toContain("event-spots-left");
  });

  it("marks an exactly-full row once only: the Full marker, no second availability node", async () => {
    freezeNow();
    const f = fixture([event(1, { capacity: 2 })], {
      named: [[1, 1]],
      occupied: [[1, 2]],
    });
    const html = await (await f.request()).text();
    const row = teaserRow(html, "event-1");
    expect(row).toContain("1 of 2 going");
    expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(1);
    expect(occurrences(row, ">Full<")).toBe(1);
    expect(row).not.toContain("event-schedule-availability");
    expect(row).not.toContain("0 seats left");
  });

  it("omits blank game/host entirely: no empty labels beside a populated control row", async () => {
    freezeNow();
    const f = fixture(
      [
        event(1, { game: "Wingspan", organizer_name: "Mara Host", capacity: 10 }),
        event(2, { game: "   ", organizer_name: "   ", capacity: 10 }),
        event(3, { game: null, organizer_name: null, capacity: 10 }),
      ],
      { named: [[1, 1]] },
    );
    const html = await (await f.request()).text();
    const control = teaserRow(html, "event-1");
    expect(control).toContain("Wingspan");
    expect(control).toContain("Hosted by Mara Host");
    for (const key of ["event-2", "event-3"]) {
      const row = teaserRow(html, key);
      // Still a real row (title and availability render), so the negatives
      // below are scoped, not vacuous.
      expect(row).toContain(key === "event-2" ? "Game night 2" : "Game night 3");
      expect(row).toContain("seats left");
      expect(row).not.toContain("Hosted by");
      expect(row).not.toContain("event-card-host");
      expect(row).not.toMatch(/<p>\s*<\/p>/);
    }
  });

  it("escapes hostile game and host text", async () => {
    freezeNow();
    const f = fixture([
      event(1, {
        game: '<script>alert("game")</script>',
        organizer_name: '<img src=x onerror="alert(1)">',
        capacity: 10,
      }),
    ]);
    const html = await (await f.request()).text();
    const row = teaserRow(html, "event-1");
    expect(row).toContain("&lt;script&gt;");
    expect(row).toContain("Hosted by &lt;img");
    expect(row).not.toContain("<script>alert");
    expect(row).not.toContain("<img src=x");
  });

  it("reads Discord-managed on a Discord row and keeps its invite link", async () => {
    freezeNow();
    const f = fixture([], undefined, [transient("d1", 5, "Friday community games")]);
    const html = await (await f.request()).text();
    expect(html).toContain('data-testid="home-events-list"');
    const row = discordRow(html, "Friday community games");
    expect(row).toContain('href="https://discord.gg/invite"');
    expect(row).toContain('data-testid="home-event-discord"');
    expect(row).toContain('data-testid="event-schedule-availability"');
    expect(row).toContain("Discord-managed");
    expect(row).toContain("RSVP in Discord");
    expect(row).not.toContain("going");
    expect(row).not.toContain("Hosted by");
    expect(row).not.toContain("event-spots-left");
    expect(row).not.toMatch(FINITE_SEATS);
  });
});

function canonicalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = new Date(NOW.getTime() + 3600_000);
  return {
    source: "canonical",
    eventKey: "direct-night",
    title: "Direct game night",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    game: "Wingspan",
    organizer_name: "Mara Host",
    status: "published",
    rsvpOpen: true,
    goingCount: 1,
    goingOccupancy: 1,
    capacity: 10,
    ...overrides,
  };
}

function renderHome(rows: Record<string, unknown>[]): string {
  return Home({
    session: null,
    notice: null,
    inviteUrl: "https://discord.gg/invite",
    appUrl: "https://next.example.test",
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: rows as unknown as HomeUpcomingRow[],
    eventsUnavailable: false,
    featured: [],
  })!.toString() as string;
}

describe("Hono teaser: rows that changed or predate the widened read", () => {
  it("reads Ended, never seats, on a row that ended between read and render", () => {
    freezeNow();
    const html = renderHome([
      canonicalRow({
        eventKey: "ended-just-now",
        startsAt: new Date(NOW.getTime() - 7200_000),
        endsAt: new Date(NOW.getTime() - 60_000),
      }),
      canonicalRow({
        eventKey: "ends-exactly-now",
        startsAt: new Date(NOW.getTime() - 7200_000),
        endsAt: NOW,
      }),
    ]);
    for (const key of ["ended-just-now", "ends-exactly-now"]) {
      const row = teaserRow(html, key);
      // The row the earlier read admitted stays visible; only its
      // bookability claim changes.
      expect(row).toContain("Direct game night");
      expect(row).toContain('data-testid="event-schedule-availability"');
      expect(row).toContain("Ended");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("RSVPs paused");
      expect(row).not.toContain("event-spots-left");
      expect(row).not.toContain(">Full<");
    }
  });

  it("reads Ended, never Full, on ended rows that are full or overfull, with a Full control past the end boundary", () => {
    freezeNow();
    const minus1 = new Date(NOW.getTime() - 1);
    const plus1 = new Date(NOW.getTime() + 1);
    const pastStart = new Date(NOW.getTime() - 7200_000);
    const html = renderHome([
      canonicalRow({
        eventKey: "ended-full-minus1",
        startsAt: pastStart,
        endsAt: minus1,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "ended-full-now",
        startsAt: pastStart,
        endsAt: NOW,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "ended-overfull-minus1",
        startsAt: pastStart,
        endsAt: minus1,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "ended-overfull-now",
        startsAt: pastStart,
        endsAt: NOW,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "open-full-plus1",
        startsAt: pastStart,
        endsAt: plus1,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "open-overfull-plus1",
        startsAt: pastStart,
        endsAt: plus1,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
    ]);
    for (const key of [
      "ended-full-minus1",
      "ended-full-now",
      "ended-overfull-minus1",
      "ended-overfull-now",
    ]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Direct game night");
      expect(row).toContain("Ended");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("RSVPs paused");
    }
    for (const key of ["open-full-plus1", "open-overfull-plus1"]) {
      const row = teaserRow(html, key);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(1);
      expect(occurrences(row, ">Full<")).toBe(1);
      expect(row).not.toContain("event-schedule-availability");
      expect(row).not.toContain("Ended");
      expect(row).not.toContain("0 seats left");
    }
  });

  it("reads Ended over paused when ended, paused over Full when open, on paused rows that are full or overfull", () => {
    freezeNow();
    const minus1 = new Date(NOW.getTime() - 1);
    const plus1 = new Date(NOW.getTime() + 1);
    const pastStart = new Date(NOW.getTime() - 7200_000);
    const html = renderHome([
      canonicalRow({
        eventKey: "paused-full-ended-minus1",
        startsAt: pastStart,
        endsAt: minus1,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "paused-full-ended-now",
        startsAt: pastStart,
        endsAt: NOW,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "paused-overfull-ended-minus1",
        startsAt: pastStart,
        endsAt: minus1,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "paused-overfull-ended-now",
        startsAt: pastStart,
        endsAt: NOW,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "paused-full-open-plus1",
        startsAt: pastStart,
        endsAt: plus1,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 4,
        capacity: 4,
      }),
      canonicalRow({
        eventKey: "paused-overfull-open-plus1",
        startsAt: pastStart,
        endsAt: plus1,
        rsvpOpen: false,
        goingCount: 1,
        goingOccupancy: 6,
        capacity: 4,
      }),
    ]);
    for (const key of [
      "paused-full-ended-minus1",
      "paused-full-ended-now",
      "paused-overfull-ended-minus1",
      "paused-overfull-ended-now",
    ]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Ended");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toContain("RSVPs paused");
      expect(row).not.toMatch(FINITE_SEATS);
    }
    for (const key of ["paused-full-open-plus1", "paused-overfull-open-plus1"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("RSVPs paused");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("Ended");
    }
  });

  it("keeps older fixtures without the new fields open, unhosted and crash-free", () => {
    freezeNow();
    const html = renderHome([
      {
        source: "canonical",
        eventKey: "legacy-night",
        title: "Legacy game night",
        startsAt: new Date(NOW.getTime() + 3600_000),
        timezone: "Europe/London",
        location: null,
        goingCount: 2,
        capacity: 4,
      },
    ]);
    const row = teaserRow(html, "legacy-night");
    expect(row).toContain("2 of 4 going");
    // Missing occupancy falls back to the named count, missing rsvpOpen
    // reads open, missing host renders nothing.
    expect(row).toContain("2 seats left");
    expect(row).not.toContain("RSVPs paused");
    expect(row).not.toContain("Hosted by");
  });
});
