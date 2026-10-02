// Event-page navigation: local SQL/SSR fixtures plus isolated agent-testdb eligibility tests.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { getEventNeighbors, listRelatedEvents, type EventLink } from "../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = new Date("2030-01-10T20:00:00Z");
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const key = (id: number) => String(id).padStart(26, "0");
type EventRow = typeof events.$inferSelect;
const row = (id: number, over: Partial<EventRow> = {}): EventRow => ({
  id, icsSequence: 1894305600n, eventKey: key(id), title: `Game night ${id}`, game: "Chess", description: null,
  startsAt: NOW, endsAt: new Date("2030-01-10T22:00:00Z"), timezone: "Europe/London",
  location: "Voice", capacity: null, status: "published", discordEventId: null, syncRevision: 1, syncedRevision: 0,
  discordSyncFailedAt: null, discordSyncFailureCode: null,
  createdBy: null, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
  recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});
const linkValues = (e: EventLink) => [e.id, e.eventKey, e.title, e.startsAt.toISOString(), e.timezone, e.location];

function pageFixture(e = row(2), previous: EventLink | null = row(1), next: EventLink | null = row(3), related: EventLink[] = [row(3)]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "rsvps"') || sql.includes("from rsvps")) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      return { rows: columns.length ? [columns.map((k) => e[k] instanceof Date ? (e[k] as Date).toISOString() : e[k])] : [] };
    }
    if (sql.includes('"ends_at" >=')) return { rows: related.map(linkValues) };
    const neighbor = sql.includes('"starts_at" desc') ? previous : next;
    return { rows: neighbor ? [linkValues(neighbor)] : [] };
  }) as unknown as Db;
  const env: Env & { ADMIN_DB: Db; SESSION_STORE: SessionStore } = {
    APP_URL: "https://next.example.test", DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id", DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret", DISCORD_BOT_TOKEN: "bot-token", SESSION_SECRET,
    ADMIN_DB: db, SESSION_STORE: createMemorySessionStore(),
  };
  return { db, env, queries, request: (init?: RequestInit) => app.request(`/e/${e.eventKey}`, init, env) };
}

async function cookie(env: Env & { SESSION_STORE: SessionStore }, moderator = false, member = true) {
  const token = newSessionToken();
  await env.SESSION_STORE!.create({
    tokenHash: await hashToken(token), userId: "100000000000000001", username: "viewer", avatar: null,
    member, moderator, expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

const relatedKeys = (html: string) => [...html.matchAll(/href="\/e\/([^"]+)" data-testid="event-related-link"/g)].map((m) => m[1]);

describe("event navigation SQL and SSR (local fixtures)", () => {
  it("uses three bounded, published-only reads, with id tiebreaks and no RSVP aggregates", async () => {
    const f = pageFixture();
    await getEventNeighbors(f.db, row(2));
    await listRelatedEvents(f.db, row(2), NOW);
    expect(f.queries).toHaveLength(3);
    for (const q of f.queries) {
      expect(q.sql).toContain('"events"."status" =');
      expect(q.params).toContain("published");
      expect(q.sql).not.toContain("rsvps");
      expect(q.sql).toContain('isfinite("events"."starts_at")');
    }
    expect(f.queries[0]!.sql).toMatch(/"starts_at" < .*"starts_at" = .*"id" </);
    expect(f.queries[0]!.sql).toContain('order by "events"."starts_at" desc, "events"."id" desc');
    expect(f.queries[1]!.sql).toMatch(/"starts_at" > .*"starts_at" = .*"id" >/);
    expect(f.queries[1]!.sql).toContain('order by "events"."starts_at" asc, "events"."id" asc');
    for (const q of f.queries.slice(0, 2)) {
      expect(q.sql).toContain('"events"."id" <>');
      expect(q.sql).toContain('(select "starts_at" from "events" where "events"."id" =');
      expect(q.params).not.toContain(NOW.toISOString());
    }
    expect(f.queries.slice(0, 2).map((q) => q.params.at(-1))).toEqual([1, 1]);
    const related = f.queries[2]!;
    expect(related.sql).toContain('"events"."id" <>');
    expect(related.sql).toContain('"events"."ends_at" >=');
    expect(related.sql).toContain('case when "events"."game" =');
    expect(related.sql).toContain('then 0 else 1 end, "events"."starts_at" asc, "events"."id" asc');
    expect(related.params).toContain("Chess");
    expect(related.params.at(-1)).toBe(3);
  });

  it("omits the game preference for a game-less event, still in one read", async () => {
    const f = pageFixture();
    await listRelatedEvents(f.db, row(2, { game: null }), NOW);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.sql).not.toContain("case when");
  });

  it("renders accessible previous/next links, host-zone times, locations and a returning guest CTA", async () => {
    const f = pageFixture();
    const response = await f.request();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('aria-label="More events" data-testid="event-pagination"');
    expect(html).toContain(`href="/e/${key(1)}" rel="prev" data-testid="event-previous"`);
    expect(html).toContain(`href="/e/${key(3)}" rel="next" data-testid="event-next"`);
    expect(relatedKeys(html)).toEqual([key(3)]);
    expect(html).toContain('datetime="2030-01-10T20:00:00.000Z"');
    expect(html).toContain("20:00");
    expect(html).toContain("Voice");
    expect(html).toContain(`href="/join?next=%2Fe%2F${key(2)}" data-testid="event-related-join"`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(f.queries).toHaveLength(5); // Event + going aggregate + 3 navigation reads.
  });

  it.each(["added", "already_member"])("preserves navigation alongside a one-shot %s join confirmation", async (result) => {
    const f = pageFixture();
    const session = await cookie(f.env);
    const flash = (await serializeSigned(JOIN_RESULT_COOKIE, result, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
    const first = await f.request({ headers: { cookie: `${session}; ${flash}` } });
    const html = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("vary")).toBe("Cookie");
    expect(html).toContain('data-testid="join-result"');
    expect(html.includes('data-testid="reinvite-link"')).toBe(result === "already_member");
    expect(html).toContain(`href="/e/${key(1)}" rel="prev" data-testid="event-previous"`);
    expect(html).toContain(`href="/e/${key(3)}" rel="next" data-testid="event-next"`);
    expect(relatedKeys(html)).toEqual([key(3)]);
    expect(html).not.toContain('data-testid="event-join-pitch"');
    expect(html).not.toContain('data-testid="event-related-join"');
    expect(first.headers.getSetCookie().join("\n")).toContain(`${JOIN_RESULT_COOKIE}=; Max-Age=0`);

    const rotated = first.headers.getSetCookie().find((value) => value.startsWith("__Host-two_session="))!.split(";")[0]!;
    const second = await f.request({ headers: { cookie: rotated } });
    const again = await second.text();
    expect(again).not.toContain('data-testid="join-result"');
    expect(again).not.toContain('data-testid="event-join-pitch"');
    expect(relatedKeys(again)).toEqual([key(3)]);
  });

  it.each([
    ["2030-01-10T20:00:00Z", "2030-01-11T01:00:00Z", "GMT", "GMT-05:00"],
    ["2030-07-10T19:00:00Z", "2030-07-11T00:00:00Z", "GMT+01:00", "GMT-04:00"],
  ])("distinguishes equal host-local related times across zones at %s", async (londonStart, newYorkStart, londonOffset, newYorkOffset) => {
    const london = row(3, { startsAt: new Date(londonStart!), timezone: "Europe/London" });
    const newYork = row(4, { startsAt: new Date(newYorkStart!), timezone: "America/New_York" });
    const html = await (await pageFixture(row(2), null, null, [london, newYork]).request()).text();
    const related = html.split('data-testid="event-related"')[1]!;
    const times = [...related.matchAll(/<time datetime="([^"]+)">([^<]+)<\/time>/g)];
    expect(times.map((m) => m[1])).toEqual([london.startsAt.toISOString(), newYork.startsAt.toISOString()]);
    expect(times[0]![2]).toContain(`20:00 ${londonOffset}`);
    expect(times[1]![2]).toContain(`20:00 ${newYorkOffset}`);
    expect(times[0]![2]).not.toBe(times[1]![2]);
  });

  it("falls back to an explicit UTC instant for an invalid related-event zone", async () => {
    const sibling = row(3, { timezone: "Invalid/Zone" });
    const html = await (await pageFixture(row(2), null, null, [sibling]).request()).text();
    expect(html).toContain(`<time datetime="${NOW.toISOString()}">${NOW.toISOString()}</time>`);
  });

  it.each(["published", "draft", "past"] as const)("preserves %s page states, sharing and landmarks alongside navigation", async (status) => {
    const f = pageFixture(row(2, { status }));
    f.env.APP_URL += "/";
    const response = await f.request({ headers: { cookie: await cookie(f.env, true) } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`href="/e/${key(1)}" rel="prev" data-testid="event-previous"`);
    expect(relatedKeys(html)).toEqual([key(3)]);
    expect(html).toContain('href="#main"');
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html).toContain('<nav aria-label="Primary">');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('data-testid="event-venue">Voice');
    expect(html).toContain(`rel="canonical" href="https://next.example.test/e/${key(2)}"`);
    expect(html).toContain(`data-copy-link="https://next.example.test/e/${key(2)}"`);
    expect(html).toContain('property="og:title" content="Game night 2 — Together We Own"');
    expect(html).toContain('src="/islands/copy-link.js" defer');
    expect(html).not.toContain('data-testid="event-join-pitch"');
    expect(html).not.toContain('data-testid="event-related-join"');
    if (status !== "published") {
      expect(html).toContain(`data-testid="event-${status}"`);
      expect(html).toContain('name="robots" content="noindex, nofollow"');
    }
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(f.queries).toHaveLength(8); // Event/count, viewer answer/position, attendees and three navigation reads.
    const viewerAnswers = f.queries.filter((q) => q.sql.includes('select "user_id", "status", "synced_to_discord_at"'));
    expect(viewerAnswers).toHaveLength(1);
    expect(viewerAnswers[0]!.params).toContain("100000000000000001");
    expect(f.queries.filter((q) => q.sql.includes("row_number() over"))).toHaveLength(1);
    expect(f.queries.filter((q) => q.sql.includes('inner join "users"'))).toHaveLength(1);
  });

  it.each([true, false])("hides the guest CTA for a signed-in viewer (member=%s) and disables shared caching", async (member) => {
    const f = pageFixture();
    const response = await f.request({ headers: { cookie: await cookie(f.env, false, member) } });
    const html = await response.text();
    expect(relatedKeys(html)).toEqual([key(3)]);
    expect(html).not.toContain('data-testid="event-related-join"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it.each(["first", "last", "only"])("omits missing links at the %s event and hides an empty related block", async (position) => {
    const f = pageFixture(row(2), position === "first" || position === "only" ? null : row(1), position === "last" || position === "only" ? null : row(3), []);
    const html = await (await f.request()).text();
    expect(html.includes('data-testid="event-previous"')).toBe(position === "last");
    expect(html.includes('data-testid="event-next"')).toBe(position === "first");
    expect(html.includes('data-testid="event-pagination"')).toBe(position !== "only");
    expect(html).not.toContain('data-testid="event-related"');
    expect(html).not.toContain('data-testid="event-related-join"');
  });

  it("keeps draft authorization and cancelled 410 ahead of navigation reads", async () => {
    const draft = pageFixture(row(2, { status: "draft" }));
    expect((await draft.request()).status).toBe(403);
    expect(draft.queries).toHaveLength(2);
    const mod = await draft.request({ headers: { cookie: await cookie(draft.env, true) } });
    expect(mod.status).toBe(200);
    expect(mod.headers.get("cache-control")).toBe("private, no-store");
    expect(draft.queries.slice(4)).toHaveLength(6); // Navigation, attendees, viewer answer and position.
    const cancelled = pageFixture(row(2, { status: "cancelled" }));
    const gone = await cancelled.request();
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain('data-testid="event-pagination"');
    expect(cancelled.queries).toHaveLength(2);
  });

  it("escapes titles and locations without turning related cards into markup", async () => {
    const sibling = row(3, { title: '<img src=x onerror="alert(1)">', location: "<script>bad</script>", timezone: "America/New_York" });
    const html = await (await pageFixture(row(2), row(1), sibling, [sibling]).request()).text();
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("15:00");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event navigation eligibility (isolated test database)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => { await fixture.reset(); });
  const seed = async (rows: EventRow[]) => fixture.db.insert(events).values(rows).returning();
  const ids = (rows: EventLink[]) => rows.map((e) => e.id);

  it("has no dangling first/last links, skips non-published rows, and navigates a double-header by id", async () => {
    const [first, middle, last] = await seed([row(1), row(3), row(5),
      row(2, { status: "draft" }), row(4, { status: "cancelled" }), row(6, { status: "past" }),
    ]);
    expect(await getEventNeighbors(fixture.db, first!)).toMatchObject({ previous: null, next: { id: 3 } });
    expect(await getEventNeighbors(fixture.db, middle!)).toMatchObject({ previous: { id: 1 }, next: { id: 5 } });
    expect(await getEventNeighbors(fixture.db, last!)).toMatchObject({ previous: { id: 3 }, next: null });
  });

  it("orders neighbors by starts_at before id, including ended published events", async () => {
    const [current] = await seed([row(3), row(9, { startsAt: new Date("2020-01-01"), endsAt: new Date("2020-01-02") }),
      row(1, { startsAt: new Date("2040-01-01"), endsAt: new Date("2040-01-02") }),
    ]);
    expect(await getEventNeighbors(fixture.db, current!)).toMatchObject({ previous: { id: 9 }, next: { id: 1 } });
  });

  it("returns no neighbors or related links for a lone event", async () => {
    const [current] = await seed([row(1)]);
    expect(await getEventNeighbors(fixture.db, current!)).toEqual({ previous: null, next: null });
    expect(await listRelatedEvents(fixture.db, current!, NOW)).toEqual([]);
  });

  it("never links a lone event to itself when PostgreSQL stores microseconds", async () => {
    await seed([row(2)]);
    await fixture.client`update events set starts_at = '2030-01-10T20:00:00.123456Z'::timestamptz where id = 2`;
    const [current] = await fixture.db.select().from(events);
    expect(current!.startsAt.toISOString()).toBe("2030-01-10T20:00:00.123Z");
    expect(await getEventNeighbors(fixture.db, current!)).toEqual({ previous: null, next: null });
  });

  it("uses id tiebreaks for equal microsecond starts, including the first/last boundaries", async () => {
    await seed([row(1), row(2), row(3)]);
    await fixture.client`update events set starts_at = '2030-01-10T20:00:00.123456Z'::timestamptz`;
    const current = await fixture.db.select().from(events).orderBy(events.id);
    expect(await getEventNeighbors(fixture.db, current[0]!)).toMatchObject({ previous: null, next: { id: 2 } });
    expect(await getEventNeighbors(fixture.db, current[1]!)).toMatchObject({ previous: { id: 1 }, next: { id: 3 } });
    expect(await getEventNeighbors(fixture.db, current[2]!)).toMatchObject({ previous: { id: 2 }, next: null });
  });

  it("orders distinct microsecond starts within one millisecond before id", async () => {
    await seed([row(3), row(2), row(1), row(4, { status: "draft" }), row(5, { status: "cancelled" })]);
    await fixture.client`update events set starts_at = case id
      when 3 then '2030-01-10T20:00:00.123100Z'::timestamptz
      when 2 then '2030-01-10T20:00:00.123456Z'::timestamptz
      when 1 then '2030-01-10T20:00:00.123900Z'::timestamptz
      else '2030-01-10T20:00:00.123500Z'::timestamptz end`;
    const current = await fixture.db.select().from(events);
    expect(new Set(current.map((e) => e.startsAt.toISOString())).size).toBe(1);
    expect(await getEventNeighbors(fixture.db, current.find((e) => e.id === 2)!)).toMatchObject({ previous: { id: 3 }, next: { id: 1 } });
  });

  it.each(["infinity", "-infinity"])("omits a %s related start without breaking a valid event page", async (timestamp) => {
    const [current] = await seed([row(1), row(3)]);
    const env = { ...pageFixture().env, ADMIN_DB: fixture.db };
    expect((await app.request(`/e/${key(1)}`, undefined, env)).status).toBe(200);
    await seed([row(2)]);
    await fixture.client`update events set starts_at = ${timestamp}::timestamptz where id = 2`;
    const [invalid] = await fixture.client`select starts_at from events where id = 2`;
    expect(Number.isFinite(new Date(invalid!.starts_at).getTime())).toBe(false);
    const response = await app.request(`/e/${key(1)}`, undefined, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(ids(await listRelatedEvents(fixture.db, current!, NOW))).toEqual([3]);
    expect(relatedKeys(html)).toEqual([key(3)]);
    expect(html).toContain(`<time datetime="${NOW.toISOString()}">`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it.each(["infinity", "-infinity"])("hides the related block when its only sibling starts at %s", async (timestamp) => {
    const [current] = await seed([row(1), row(2)]);
    await fixture.client`update events set starts_at = ${timestamp}::timestamptz where id = 2`;
    const response = await app.request(`/e/${key(1)}`, undefined, { ...pageFixture().env, ADMIN_DB: fixture.db });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(await listRelatedEvents(fixture.db, current!, NOW)).toEqual([]);
    expect(html).not.toContain('data-testid="event-related"');
    expect(html).not.toContain('data-testid="event-related-join"');
  });

  it.each(["infinity", "-infinity"])("omits a %s neighbor and preserves finite destinations", async (timestamp) => {
    const [current] = await seed([row(2), row(4)]);
    await fixture.client`update events set starts_at = ${timestamp}::timestamptz where id = 4`;
    const env = { ...pageFixture().env, ADMIN_DB: fixture.db };
    const source = await app.request(`/e/${key(2)}`, undefined, env);
    const html = await source.text();
    expect(source.status).toBe(200);
    expect(await getEventNeighbors(fixture.db, current!)).toEqual({ previous: null, next: null });
    expect(html).not.toContain('data-testid="event-pagination"');
    expect(html).not.toContain(`href="/e/${key(4)}"`);

    await seed([row(1), row(3)]);
    expect(await getEventNeighbors(fixture.db, current!)).toMatchObject({ previous: { id: 1 }, next: { id: 3 } });
    const populated = await app.request(`/e/${key(2)}`, undefined, env);
    const populatedHtml = await populated.text();
    expect(populated.status).toBe(200);
    expect(populatedHtml).toContain(`href="/e/${key(1)}" rel="prev" data-testid="event-previous"`);
    expect(populatedHtml).toContain(`href="/e/${key(3)}" rel="next" data-testid="event-next"`);
    expect(populatedHtml).not.toContain(`href="/e/${key(4)}"`);
    for (const id of [1, 3]) expect((await app.request(`/e/${key(id)}`, undefined, env)).status).toBe(200);
  });

  it.each(["infinity", "-infinity"])("fills all three related slots when same-game starts are %s", async (timestamp) => {
    const [current] = await seed([row(1), row(2), row(3), row(4),
      row(5, { game: "Go" }), row(6, { game: "Go" }), row(7, { game: "Go" }),
    ]);
    await fixture.client`update events set starts_at = ${timestamp}::timestamptz where id in (2, 3, 4)`;
    const env = { ...pageFixture().env, ADMIN_DB: fixture.db };
    const response = await app.request(`/e/${key(1)}`, undefined, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(ids(await listRelatedEvents(fixture.db, current!, NOW))).toEqual([5, 6, 7]);
    expect(relatedKeys(html)).toEqual([key(5), key(6), key(7)]);
    expect(html).toContain('data-testid="event-related-join"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    for (const id of [5, 6, 7]) expect((await app.request(`/e/${key(id)}`, undefined, env)).status).toBe(200);
  });

  it("prioritizes three same-game events over nearer other games, with stable chronological ordering", async () => {
    const [current] = await seed([row(1), row(2, { game: "Go" }),
      row(6, { startsAt: new Date("2030-01-12"), endsAt: new Date("2030-01-13") }),
      row(4, { startsAt: new Date("2030-01-11"), endsAt: new Date("2030-01-12") }),
      row(3, { startsAt: new Date("2030-01-11"), endsAt: new Date("2030-01-12") }),
      row(5, { startsAt: new Date("2030-01-11"), endsAt: new Date("2030-01-12") }),
    ]);
    expect(ids(await listRelatedEvents(fixture.db, current!, NOW))).toEqual([3, 4, 5]);
  });

  it("fills from other upcoming events without duplicates, excluding self/drafts/cancelled/past/ended", async () => {
    const [current] = await seed([row(1), row(8), row(2, { game: "Go" }), row(3, { game: null }),
      row(4, { status: "draft" }), row(5, { status: "cancelled" }), row(6, { status: "past" }),
      row(7, { endsAt: new Date(NOW.getTime() - 1) }),
    ]);
    expect(ids(await listRelatedEvents(fixture.db, current!, NOW))).toEqual([8, 2, 3]);
  });

  it("has no null-game preference, and includes ongoing events ending exactly now", async () => {
    const [current] = await seed([row(1, { game: null }), row(2, { startsAt: new Date("2030-01-09"), endsAt: NOW }),
      row(3, { game: null }), row(4, { endsAt: new Date(NOW.getTime() - 1) }),
    ]);
    expect(ids(await listRelatedEvents(fixture.db, current!, NOW))).toEqual([2, 3]);
  });

  it("treats a non-null blank or quoted game as an exact bound value", async () => {
    await seed([row(1, { game: "" }), row(2), row(3, { game: "" }), row(4, { game: "Chess' OR true --" })]);
    expect(ids(await listRelatedEvents(fixture.db, row(1, { game: "" }), NOW))).toEqual([3, 2, 4]);
    expect(ids(await listRelatedEvents(fixture.db, row(1, { game: "Chess' OR true --" }), NOW))).toEqual([4, 2, 3]);
  });
});
