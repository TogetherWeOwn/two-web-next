import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store";
import { listJoinAttempts, listRoster, JOIN_RETENTION_DAYS } from "../src/admin/reads";
import { featuredListUrl, joinAttemptsUrl, parseFeaturedListQuery, parseJoinAttemptsQuery, parseRosterQuery, rosterUrl, JOIN_ATTEMPT_PAGE_SIZE } from "../src/admin/table-list";
import { events, featuredContents, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { joinAttempts, users } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const injection = "%' OR 1=1; DROP TABLE users;--";
function link(html: string, rel: "next" | "prev") {
  return html.match(new RegExp(`rel="${rel}" href="([^"]+)"`))?.[1]?.replaceAll("&amp;", "&");
}
function featuredIds(html: string) {
  return [...html.matchAll(/data-testid="featured-position-(\d+)"/g)].map((m) => Number(m[1]));
}
function attemptIds(html: string) {
  return [...html.matchAll(/href="\/admin\/join-attempts\/(\d+)"/g)].map((m) => Number(m[1]));
}

describe("admin table query state (no DB)", () => {
  it("defaults and allowlists featured filter, sort and order", () => {
    expect(parseFeaturedListQuery({})).toEqual({ published: "", q: "", sort: "position", order: "asc" });
    expect(parseFeaturedListQuery({ published: "false", q: `  ${injection}  `, sort: injection, order: injection }))
      .toEqual({ published: "", q: injection, sort: "position", order: "asc" });
    expect(parseFeaturedListQuery({ published: "0", sort: "updated_at", order: "desc" }))
      .toEqual({ published: "0", q: "", sort: "updated_at", order: "desc" });
  });

  it("defaults and allowlists roster sort/order independently of event parameters", () => {
    expect(parseRosterQuery({})).toEqual({ q: "", sort: "answered", order: "desc" });
    expect(parseRosterQuery({ roster_q: "  Alice  ", roster_sort: "status", roster_order: "asc" }))
      .toEqual({ q: "Alice", sort: "status", order: "asc" });
    expect(parseRosterQuery({ q: "wrong", sort: "status", roster_sort: injection, roster_order: injection }))
      .toEqual({ q: "", sort: "answered", order: "desc" });
  });

  it.each(["", "0", "-1", "1.5", "1e2", "Infinity", injection, "9007199254740991"])("normalizes unsafe page %s", (page) => {
    expect(parseJoinAttemptsQuery({ page }).page).toBe(1);
  });

  it("preserves and encodes all filter state in navigation", () => {
    const featured = parseFeaturedListQuery({ published: "1", q: 'A & "B"', sort: "updated_at", order: "desc" });
    expect(Object.fromEntries(new URL(featuredListUrl(featured, { order: "asc" }), env.APP_URL).searchParams))
      .toEqual({ published: "1", q: 'A & "B"', sort: "updated_at", order: "asc" });
    const roster = parseRosterQuery({ roster_q: injection, roster_sort: "status", roster_order: "asc" });
    const url = new URL(rosterUrl("event", roster, { sort: "answered", order: "desc" }), env.APP_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ roster_q: injection, roster_sort: "answered", roster_order: "desc" });
    expect(url.hash).toBe("#rsvp-roster");
    expect(Object.fromEntries(new URL(joinAttemptsUrl({ outcome: "denied", q: "request & id", page: 2 }, 3), env.APP_URL).searchParams))
      .toEqual({ outcome: "denied", q: "request & id", page: "3" });
  });

  it("keeps filtered/sorted/paged views behind the existing moderator guard", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, MEMBER);
    for (const path of ["/featured?published=0&q=alice&sort=updated_at", "/events/event?roster_q=alice&roster_sort=status", "/join-attempts?page=2"]) {
      expect((await app.request(path, {}, env)).status).toBe(302);
      expect((await app.request(path, { headers: { cookie } }, env)).status).toBe(403);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin tables (isolated agent-testdb / CI schema)", () => {
  let fixture: MemberDataFixture;
  let cookie: string;
  const store = createMemorySessionStore();
  const request = async (path: string) => {
    const response = await adminApp({ sessionStore: store, db: fixture.db }).request(path, { headers: { cookie } }, { ...env, ADMIN_DB: fixture.db });
    expect(response.status).toBe(200);
    return response.text();
  };
  const logs = () => fixture.db.select().from(memberDataAccessLogs).orderBy(memberDataAccessLogs.id);
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    cookie = await cookieFor(store, MODERATOR);
  });

  async function seedFeatured() {
    return fixture.db.insert(featuredContents).values([
      { title: "Alpha night", isPublished: true, position: 2, updatedAt: new Date("2026-10-01T01:00Z") },
      { title: "Beta night", isPublished: false, position: 1, updatedAt: new Date("2026-10-02T01:00Z") },
      { title: "Gamma night", isPublished: true, position: 1, updatedAt: new Date("2026-10-02T01:00Z") },
      { title: "100%_\\ literal", isPublished: false, position: 3, updatedAt: new Date("2026-10-03T01:00Z") },
      { title: injection, isPublished: true, position: 4, updatedAt: new Date("2026-10-04T01:00Z") },
    ]).returning();
  }

  it.each(["1", "0", ""])("featured published=%s combines with case-insensitive title search and audits exactly the results", async (published) => {
    const rows = await seedFeatured();
    const expected = rows.filter((r) => r.title.includes("night") && (!published || r.isPublished === (published === "1")));
    const html = await request(`/featured?published=${published}&q=NIGHT`);
    expect(featuredIds(html).sort()).toEqual(expected.map((r) => r.id).sort());
    const [log] = await logs();
    expect(log!.route).toBe("admin.featured.index");
    expect(log!.subjectUserIds).toEqual(expected.map((r) => String(r.id)).sort());
    expect(log!.subjectCount).toBe(expected.length);
    expect(html).toContain(`value="${published}" selected`);
    expect(html).toContain('name="q" type="search" value="NIGHT"');
  });

  it.each(["position", "updated_at"])("featured sort=%s supports both directions and stable id ties", async (sort) => {
    const rows = await seedFeatured();
    for (const order of ["asc", "desc"] as const) {
      const expected = [...rows].sort((a, b) => {
        const diff = sort === "position" ? a.position - b.position : a.updatedAt.getTime() - b.updatedAt.getTime();
        return (order === "asc" ? diff : -diff) || a.id - b.id;
      });
      expect(featuredIds(await request(`/featured?sort=${sort}&order=${order}`))).toEqual(expected.map((r) => r.id));
    }
    expect((await listFeatured(fixture.db, { sort: injection })).map((r) => r.id))
      .toEqual((await listFeatured(fixture.db, {})).map((r) => r.id));
  });

  it("featured literal LIKE escaping and injection-shaped q neither broaden nor execute SQL", async () => {
    const rows = await seedFeatured();
    for (const q of ["%_\\", injection]) {
      const expected = q === injection ? rows[4]! : rows[3]!;
      const html = await request(`/featured?q=${encodeURIComponent(q)}`);
      expect(featuredIds(html)).toEqual([expected.id]);
      expect((await logs()).at(-1)!.subjectUserIds).toEqual([String(expected.id)]);
    }
    expect(await fixture.db.select().from(featuredContents)).toHaveLength(5);
    expect(await fixture.db.select().from(users)).toEqual([]);
    const empty = await request("/featured?q=absent");
    expect(empty).toContain('colspan="5" data-testid="featured-empty"');
    expect(await logs()).toHaveLength(2); // Empty result sets create no access row.
  });

  it("featured last-changed column and accessible sort links preserve filters and sort direction", async () => {
    await seedFeatured();
    const html = await request("/featured?published=1&q=night&sort=updated_at&order=desc");
    expect(html).toContain("Last changed ↓");
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-label="Sort by last changed ascending"');
    expect(html).toContain("sort=updated_at&amp;order=asc&amp;published=1&amp;q=night");
    expect(html).toContain('name="sort" value="updated_at"');
    expect(html).toContain('<time datetime="2026-10-02T01:00:00.000Z">');
  });

  async function seedRoster() {
    const [event, other] = await fixture.db.insert(events).values(["roster", "other"].map((eventKey) => ({
      eventKey, title: eventKey, startsAt: new Date("2099-10-01T20:00Z"), endsAt: new Date("2099-10-01T22:00Z"),
    }))).returning();
    await fixture.db.insert(users).values([
      { id: "a", username: "Alice" }, { id: "b", username: "Alice 100%_\\" },
      { id: "c", username: injection }, { id: "d", username: "Drew" },
    ]);
    await fixture.db.insert(rsvps).values([
      { eventId: event!.id, userId: "a", status: "going", updatedAt: new Date("2026-10-01T01:00Z") },
      { eventId: event!.id, userId: "b", status: "maybe", updatedAt: new Date("2026-10-02T01:00Z") },
      { eventId: event!.id, userId: "c", status: "going", updatedAt: new Date("2026-10-02T01:00Z") },
      { eventId: event!.id, userId: "unknown-id", status: "not_going", updatedAt: new Date("2026-10-03T01:00Z") },
      { eventId: other!.id, userId: "d", status: "going" },
    ]);
    return listRoster(fixture.db, "roster");
  }

  it("roster member search is server-side, literal, event-scoped and access-logs only rendered members", async () => {
    await seedRoster();
    for (const [q, ids] of [["alice", ["a", "b"]], ["%_\\", ["b"]], [injection, ["c"]], ["Drew", []]] as const) {
      const html = await request(`/events/roster?roster_q=${encodeURIComponent(q)}`);
      expect(html).toContain(`RSVPs (${ids.length})`);
      if (ids.length) expect((await logs()).at(-1)!.subjectUserIds).toEqual(ids);
      expect(html).not.toContain("unknown-id");
      expect(html).not.toContain("Unknown member");
      if (q !== "alice" && q !== "%_\\") expect(html).not.toContain("Alice");
    }
    expect(await logs()).toHaveLength(3);
    expect((await logs()).every((r) => r.route === "admin.events.edit")).toBe(true);
    expect(await fixture.db.select().from(users)).toHaveLength(4);
  });

  it.each(["status", "answered"])("roster sort=%s supports both directions and stable member ties", async (sort) => {
    const rows = await seedRoster();
    for (const order of ["asc", "desc"] as const) {
      const query = parseRosterQuery({ roster_sort: sort, roster_order: order });
      const expected = [...rows].sort((a, b) => {
        const diff = sort === "status" ? a.status.localeCompare(b.status) : a.answeredAt.getTime() - b.answeredAt.getTime();
        return (order === "asc" ? diff : -diff) || a.userId.localeCompare(b.userId);
      });
      expect((await listRoster(fixture.db, "roster", query)).map((r) => r.userId)).toEqual(expected.map((r) => r.userId));
      const html = await request(`/events/roster?roster_sort=${sort}&roster_order=${order}`);
      const names = expected.map((r) => r.username ?? "Unknown member");
      // Table cell positions, not form values/encoded query strings.
      const positions = names.map((name) => html.indexOf(`<td>${name.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}</td>`));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("roster invalid sorts use newest-first; headers/search preserve state and missing names do not expose ids", async () => {
    await seedRoster();
    const fallback = await request(`/events/roster?roster_sort=${encodeURIComponent(injection)}&roster_order=invalid`);
    expect(fallback.indexOf("Unknown member")).toBeLessThan(fallback.indexOf("Alice"));
    expect(fallback).not.toContain("unknown-id");
    expect(fallback).toContain('aria-label="Sort by answered ascending"');
    const html = await request("/events/roster?roster_q=alice&roster_sort=status&roster_order=asc");
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain("roster_sort=status&amp;roster_order=desc&amp;roster_q=alice#rsvp-roster");
    expect(html).toContain('name="roster_sort" value="status"');
    expect(html).toContain('name="roster_order" value="asc"');
    expect(html).toContain('id="roster-q" name="roster_q" type="search" value="alice"');
  });

  it("join pages retain filters, reach older attempts, omit lookahead subjects, and keep stable id ordering", async () => {
    const now = new Date();
    const rows = await fixture.db.insert(joinAttempts).values(Array.from({ length: JOIN_ATTEMPT_PAGE_SIZE + 2 }, (_, i) => ({
      outcome: "denied", requestId: "request & trace", discordId: `member-${i}`, createdAt: now,
    }))).returning();
    await fixture.db.insert(joinAttempts).values([
      { outcome: "added", requestId: "request & trace", discordId: "wrong-outcome" },
      { outcome: "denied", requestId: "wrong-query", discordId: "wrong-query" },
      { outcome: "denied", requestId: "request & trace", discordId: "expired", createdAt: new Date(now.getTime() - (JOIN_RETENTION_DAYS + 1) * 86_400_000) },
    ]);
    const ordered = [...rows].reverse();
    const first = await request("/join-attempts?outcome=denied&q=request+%26+trace");
    expect(attemptIds(first)).toEqual(ordered.slice(0, JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
    expect(link(first, "prev")).toBeUndefined();
    const next = new URL(link(first, "next")!, env.APP_URL);
    expect(Object.fromEntries(next.searchParams)).toEqual({ outcome: "denied", q: "request & trace", page: "2" });
    const second = await request(`/join-attempts${next.search}`);
    expect(attemptIds(second)).toEqual(ordered.slice(JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
    expect(link(second, "next")).toBeUndefined();
    const prev = new URL(link(second, "prev")!, env.APP_URL);
    expect(Object.fromEntries(prev.searchParams)).toEqual({ outcome: "denied", q: "request & trace", page: "1" });
    const access = await logs();
    expect(access[0]!.subjectUserIds).toEqual(ordered.slice(0, JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.discordId!).sort());
    expect(access[1]!.subjectUserIds).toEqual(ordered.slice(JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.discordId!).sort());
    expect(access[0]!.subjectCount).toBe(JOIN_ATTEMPT_PAGE_SIZE);
    expect(access[0]!.subjectUserIds).not.toContain(ordered[JOIN_ATTEMPT_PAGE_SIZE]!.discordId);
    expect(access.every((r) => r.route === "admin.join-attempts.index")).toBe(true);
    expect(await fixture.db.select().from(joinAttempts)).toHaveLength(JOIN_ATTEMPT_PAGE_SIZE + 5);
  });

  it("join exact Discord/request search, empty pages and invalid page state remain usable", async () => {
    await fixture.db.insert(joinAttempts).values([
      { outcome: "added", discordId: "123", requestId: "one" },
      { outcome: "added", discordId: "1234", requestId: "two" },
      { outcome: "denied", requestId: injection },
    ]);
    const exact = await request("/join-attempts?q=123&page=invalid");
    expect(attemptIds(exact)).toHaveLength(1);
    expect(exact).toContain("Page 1");
    expect(await listJoinAttempts(fixture.db, { q: injection })).toHaveLength(1);
    const empty = await request("/join-attempts?outcome=added&page=2");
    expect(empty).toContain("No join attempts.");
    expect(link(empty, "prev")).toContain("outcome=added");
    expect(link(empty, "next")).toBeUndefined();
    expect(await logs()).toHaveLength(1);
  });
});
