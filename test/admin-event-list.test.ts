import { and, eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_PAGE_SIZE, eventListUrl, parseEventListQuery } from "../src/admin/event-list";
import { adminApp } from "../src/admin/routes";
import { listEvents, type EventRow } from "../src/admin/store";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
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
const viewer = "event-list-test-mod";

async function cookieFor(store: SessionStore, moderator: boolean) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token), userId: viewer, username: "mod", avatar: null,
    member: true, moderator, expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET!, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

function link(html: string, rel: "next" | "prev"): string | undefined {
  return html.match(new RegExp(`rel="${rel}" href="([^"]+)"`))?.[1]?.replaceAll("&amp;", "&");
}
function rowKeys(html: string): string[] {
  return [...html.matchAll(/data-testid="event-status-([^"]+)"/g)].map((m) => m[1]!);
}

describe("admin event list query and guard (no DB)", () => {
  it("defaults to newest starts first and validates every allowlist", () => {
    expect(parseEventListQuery({})).toEqual({ q: "", status: "", series: "", fill: "", rsvp_open: "", sort: "starts_at", order: "desc", page: 1 });
    expect(parseEventListQuery({
      q: "  Games & nights  ", status: "unknown", series: "unknown", fill: "unknown", rsvp_open: "unknown",
      sort: "title; DROP TABLE events--", order: "asc;--", page: "Infinity",
    })).toEqual({ q: "Games & nights", status: "", series: "", fill: "", rsvp_open: "", sort: "starts_at", order: "desc", page: 1 });
  });

  it.each(["0", "-1", "1.5", "1e2", "NaN", "9007199254740991"])("ignores invalid page %s", (page) => {
    expect(parseEventListQuery({ page }).page).toBe(1);
  });

  it.each(["1", "0"])("encodes filters and preserves RSVP state %s when navigating", (rsvp_open) => {
    const query = parseEventListQuery({ q: 'Games & "nights"', status: "published", series: "child", fill: "has_seats", rsvp_open, sort: "title", order: "asc", page: "2" });
    const url = new URL(eventListUrl(query, { page: 3 }), env.APP_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Games & "nights"', status: "published", series: "child", fill: "has_seats", rsvp_open, sort: "title", order: "asc", page: "3",
    });
  });

  it.each(["", "bogus", "false"])("omits empty or invalid RSVP filter %s from navigation", (rsvp_open) => {
    expect(new URL(eventListUrl(parseEventListQuery({ rsvp_open })), env.APP_URL).searchParams.has("rsvp_open")).toBe(false);
  });

  it("keeps guests and non-moderators outside the filtered, sorted list", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const path = "/events?series=parent&fill=full&sort=title&order=asc&page=2";
    const guest = await app.request(path, {}, env);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");
    const cookie = await cookieFor(store, false);
    expect((await app.request(path, { headers: { cookie } }, env)).status).toBe(403);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin event list (isolated agent-testdb / CI fixture)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  let cookie: string;
  let fixtures: Record<string, EventRow>;
  const app = () => adminApp({ sessionStore: store, db: fixture.db });
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;
  const keys = (rows: EventRow[]) => rows.map((r) => r.eventKey);
  const request = (query = "") => app().request(`/events${query}`, { headers: { cookie } }, bindings());
  const list = (params: Parameters<typeof listEvents>[1]) => listEvents(fixture.db, { q: "List fixture", ...params });

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(() => fixture?.dispose());

  beforeEach(async () => {
    await fixture.reset();
    cookie = await cookieFor(store, true);
    fixtures = {};
    for (const [key, title, status, day, capacity] of [
      ["parent", "F parent", "published", 1, 2],
      ["child", "A child", "draft", 3, 2],
      ["standalone", "C standalone", "cancelled", 2, null],
      ["overfull", "B overfull", "past", 5, 1],
      ["empty", "D empty", "published", 4, 3],
      ["unlimited", "E unlimited", "draft", 6, null],
    ] as const) {
      const [row] = await fixture.db.insert(events).values({
        eventKey: `list-test-${key}`, title: `List fixture ${title}`, status, capacity,
        startsAt: new Date(`2026-11-0${day}T20:00:00Z`), endsAt: new Date(`2026-11-0${day}T22:00:00Z`),
        recurrenceFrequency: key === "parent" ? "weekly" : null,
        parentEventId: key === "child" ? fixtures.parent!.id : null,
      }).returning();
      fixtures[key] = row!;
    }
    for (const [key, statuses] of [
      ["parent", ["going", "going", "maybe"]],
      ["child", ["going", "maybe", "waitlist", "not_going"]],
      ["overfull", ["going", "going"]],
      ["unlimited", ["going", "going", "going"]],
    ] as const) {
      await fixture.db.insert(rsvps).values(statuses.map((status, i) => ({
        eventId: fixtures[key]!.id, userId: `list-test-member-${i}`, status,
      })));
    }
  });
  it.each([
    ["parent", ["parent"]], ["child", ["child"]],
    ["standalone", ["empty", "overfull", "standalone", "unlimited"]],
  ] as const)("series=%s selects only that class", async (series, expected) => {
    expect(keys(await list({ series })).sort()).toEqual(expected.map((k) => fixtures[k]!.eventKey).sort());
  });

  it.each([
    ["full", ["parent", "overfull"]], ["has_seats", ["child", "empty"]],
    ["unlimited", ["standalone", "unlimited"]],
  ] as const)("fill=%s counts only Going and handles null/empty/over-capacity", async (fill, expected) => {
    expect(keys(await list({ fill })).sort()).toEqual(expected.map((k) => fixtures[k]!.eventKey).sort());
  });

  it("combines search, status, series, fill and RSVP state without broadening results", async () => {
    await fixture.db.update(events).set({ rsvpOpen: false }).where(eq(events.id, fixtures.parent!.id));
    expect(keys(await list({ status: "published", series: "parent", fill: "full", rsvp_open: "0" }))).toEqual([fixtures.parent!.eventKey]);
    expect(await list({ status: "published", series: "parent", fill: "full", rsvp_open: "1" })).toEqual([]);
    expect(await list({ q: "no match", status: "published", series: "parent", fill: "full" })).toEqual([]);
    expect(await list({ status: "draft", series: "parent", fill: "full" })).toEqual([]);
  });

  it.each([
    ["title", ["child", "overfull", "standalone", "empty", "unlimited", "parent"]],
    ["starts_at", ["parent", "standalone", "child", "empty", "overfull", "unlimited"]],
    ["status", ["standalone", "child", "unlimited", "overfull", "parent", "empty"]],
  ] as const)("sort=%s is correct ascending and descending with stable ties", async (sort, expected) => {
    expect(keys(await list({ sort, order: "asc" }))).toEqual(expected.map((k) => fixtures[k]!.eventKey));
    const descending = sort === "status"
      ? ["parent", "empty", "overfull", "child", "unlimited", "standalone"]
      : [...expected].reverse();
    expect(keys(await list({ sort, order: "desc" }))).toEqual(descending.map((k) => fixtures[k]!.eventKey));
  });

  it.each(["title; DROP TABLE events--", "__proto__", "constructor", "game"])("ignores invalid sort %s instead of interpolating SQL", async (sort) => {
    expect(keys(await list({ sort }))).toEqual(keys(await list({})));
    expect(await fixture.db.select().from(events)).toHaveLength(6);
  });

  it("renders selected filters, accessible sort toggles, no delete/bulk, and page-resetting sort links", async () => {
    const res = await request("?q=List+fixture&status=published&series=parent&fill=full&sort=title&order=asc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(rowKeys(html)).toEqual([fixtures.parent!.eventKey]);
    for (const value of ["published", "parent", "full"]) expect(html).toContain(`value="${value}" selected`);
    expect(html).toContain('name="sort" value="title"');
    expect(html).toContain('name="order" value="asc"');
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('aria-label="Sort by title descending"');
    expect(html).toContain('q=List+fixture&amp;status=published&amp;series=parent&amp;fill=full&amp;sort=title&amp;order=desc');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("/delete");
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      expect((await app().request(`/events/${fixtures.parent!.eventKey}`, {
        method, headers: { cookie, origin: env.APP_URL },
      }, env)).status).toBe(404);
    }
  });

  it.each(["1", "0"])("paginates RSVP state %s with every filter preserved and logs only displayed rows", async (rsvp_open) => {
    await fixture.db.insert(events).values(Array.from({ length: EVENT_PAGE_SIZE + 2 }, (_, i) => ({
      eventKey: `list-test-page-${i}`, title: `Page fixture & nights ${String(i).padStart(2, "0")}`,
      status: "published", capacity: 4, rsvpOpen: rsvp_open === "1",
      startsAt: new Date("2026-12-01T20:00:00Z"), endsAt: new Date("2026-12-01T22:00:00Z"),
    })));
    await fixture.db.insert(events).values({
      eventKey: "list-test-page-opposite", title: "Page fixture & nights 00 opposite",
      status: "published", capacity: 4, rsvpOpen: rsvp_open !== "1",
      startsAt: new Date("2026-12-01T20:00:00Z"), endsAt: new Date("2026-12-01T22:00:00Z"),
    });
    const query = `?q=Page+fixture+%26+nights&status=published&series=standalone&fill=has_seats&rsvp_open=${rsvp_open}&sort=title&order=asc`;
    const first = await (await request(query)).text();
    expect(rowKeys(first)).toHaveLength(EVENT_PAGE_SIZE);
    expect(link(first, "prev")).toBeUndefined();
    const next = new URL(link(first, "next")!, env.APP_URL);
    expect(Object.fromEntries(next.searchParams)).toEqual({
      q: "Page fixture & nights", status: "published", series: "standalone", fill: "has_seats", rsvp_open, sort: "title", order: "asc", page: "2",
    });
    const second = await (await request(next.search)).text();
    expect(rowKeys(second)).toEqual(["list-test-page-25", "list-test-page-26"]);
    expect(link(second, "next")).toBeUndefined();
    const previous = new URL(link(second, "prev")!, env.APP_URL);
    expect(previous.searchParams.has("page")).toBe(false);
    expect(previous.searchParams.get("rsvp_open")).toBe(rsvp_open);
    expect([...rowKeys(first), ...rowKeys(second)]).toHaveLength(new Set([...rowKeys(first), ...rowKeys(second)]).size);
    const sortLink = second.match(/href="([^"]+)" aria-label="Sort by title descending"/)![1]!.replaceAll("&amp;", "&");
    expect(new URL(sortLink, env.APP_URL).searchParams.has("page")).toBe(false);
    expect(new URL(sortLink, env.APP_URL).searchParams.get("rsvp_open")).toBe(rsvp_open);
    const [log] = await fixture.db.select().from(memberDataAccessLogs)
      .where(and(eq(memberDataAccessLogs.viewerDiscordId, viewer), eq(memberDataAccessLogs.subjectCount, EVENT_PAGE_SIZE)));
    expect(log!.subjectUserIds.sort()).toEqual(rowKeys(first).sort());
    expect(log!.subjectUserIds).not.toContain("list-test-page-25");
  });

  it("breaks equal sort values by id so pages do not repeat rows", async () => {
    const inserted = await fixture.db.insert(events).values(Array.from({ length: EVENT_PAGE_SIZE + 1 }, (_, i) => ({
      eventKey: `list-test-tie-${i}`, title: "Tie fixture", status: "draft",
      startsAt: new Date("2026-12-01T20:00:00Z"), endsAt: new Date("2026-12-01T22:00:00Z"),
    }))).returning();
    for (const sort of ["title", "status", "starts_at"]) {
      const first = await (await request(`?q=Tie+fixture&sort=${sort}`)).text();
      const second = await (await request(`?q=Tie+fixture&sort=${sort}&page=2`)).text();
      expect(rowKeys(first)).toEqual(inserted.slice(0, EVENT_PAGE_SIZE).map((r) => r.eventKey));
      expect(rowKeys(second)).toEqual([inserted[EVENT_PAGE_SIZE]!.eventKey]);
    }
  });

  it("empty and invalid query states still render usable navigation", async () => {
    const html = await (await request("?q=missing&sort=constructor&order=invalid&page=0")).text();
    expect(html).toContain("No events yet.");
    expect(html).toContain("Page 1");
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('name="sort" value="starts_at"');
    expect(link(html, "next")).toBeUndefined();
    expect(link(html, "prev")).toBeUndefined();
  });
});
