// Acceptance pin: admin free-text filters (roster/join-attempts/activity-log
// `q`, activity-log `subject`/`causer`, event `q`, featured `q`) are
// length-bounded at the parser, the single boundary every Hono route and Kit
// loader crosses before the ILIKE/eq sinks and the pagination/sort links.
//
// Contract pinned here:
// - The bound is 128 characters, measured on the normalized value (NULs
//   stripped, then trimmed) — the exact string that would reach SQL/links.
// - A value over the bound is an invalid value and falls back to "" (absent),
//   like an unknown enum filter falls back to "" or an unsafe page to 1.
//   It is never truncated to a different search term.
// - Other fields in the same query are unaffected by one overlong field.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventEmptyText, eventListUrl, parseEventListQuery } from "../src/admin/event-list";
import {
  featuredEmptyText,
  featuredListUrl,
  parseFeaturedListQuery,
} from "../src/admin/featured-list-query";
import { listRoster } from "../src/admin/reads";
import { adminApp } from "../src/admin/routes";
import {
  activityLogEmptyText,
  activityLogUrl,
  joinAttemptsUrl,
  parseActivityLogQuery,
  parseJoinAttemptsQuery,
  parseRosterQuery,
  rosterEmptyText,
  rosterUrl,
} from "../src/admin/table-list";
import type { Db } from "../src/db/index";
import { activityLog, events, featuredContents, rsvps } from "../src/db/admin-schema";
import { joinAttempts, users } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const BOUND = 128;
const atBound = "x".repeat(BOUND);
const overBound = "x".repeat(BOUND + 1);
const huge = "x".repeat(8192);
const NUL = String.fromCharCode(0);

// One row per free-text field across the five admin list parsers.
const fields: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ["roster roster_q", (v) => parseRosterQuery({ roster_q: v }).q],
  ["join-attempts q", (v) => parseJoinAttemptsQuery({ q: v }).q],
  ["activity-log subject", (v) => parseActivityLogQuery({ subject: v }).subject],
  ["activity-log causer", (v) => parseActivityLogQuery({ causer: v }).causer],
  ["event q", (v) => parseEventListQuery({ q: v }).q],
  ["featured q", (v) => parseFeaturedListQuery({ q: v }).q],
];

describe("admin free-text filter length bound (no DB)", () => {
  it.each(fields)("%s: a normal search passes through verbatim", (_name, parse) => {
    expect(parse("Friday games")).toBe("Friday games");
    expect(parse("  alice  ")).toBe("alice");
  });

  it.each(fields)("%s: exactly 128 characters is preserved", (_name, parse) => {
    expect(parse(atBound)).toBe(atBound);
  });

  it.each(fields)("%s: 129 characters falls back to absent, not truncated", (_name, parse) => {
    expect(parse(overBound)).toBe("");
  });

  it.each(fields)("%s: a multi-KB value falls back to absent", (_name, parse) => {
    expect(parse(huge)).toBe("");
  });

  it.each(fields)("%s: the bound is measured after trimming", (_name, parse) => {
    expect(parse(`  ${atBound}  `)).toBe(atBound);
    expect(parse(` ${overBound} `)).toBe("");
  });

  it.each(fields)("%s: the bound is measured after NUL stripping", (_name, parse) => {
    // Raw length is over the bound; the normalized term that reaches SQL is not.
    expect(parse(atBound + NUL.repeat(16))).toBe(atBound);
    expect(parse(overBound + NUL)).toBe("");
  });

  it("keeps the sibling fields of an overlong field in every parser", () => {
    expect(
      parseRosterQuery({
        roster_q: huge,
        roster_sort: "status",
        roster_order: "asc",
        roster_page: "3",
      }),
    ).toEqual({ q: "", sort: "status", order: "asc", page: 3 });
    expect(parseJoinAttemptsQuery({ q: huge, outcome: "denied", page: "2" })).toEqual({
      outcome: "denied",
      q: "",
      page: 2,
    });
    expect(parseActivityLogQuery({ subject: huge, causer: "123", page: "2" })).toEqual({
      subject: "",
      causer: "123",
      page: 2,
    });
    expect(parseActivityLogQuery({ subject: "Event", causer: huge })).toEqual({
      subject: "Event",
      causer: "",
      page: 1,
    });
    expect(
      parseEventListQuery({ q: huge, status: "draft", sort: "title", order: "asc", page: "2" }),
    ).toMatchObject({ q: "", status: "draft", sort: "title", order: "asc", page: 2 });
    expect(
      parseFeaturedListQuery({ q: huge, published: "1", sort: "updated_at", order: "desc" }),
    ).toEqual({ published: "1", q: "", sort: "updated_at", order: "desc", page: 1 });
  });

  it("never reflects overlong text into pagination or sort links", () => {
    const urls = [
      rosterUrl("event", parseRosterQuery({ roster_q: huge }), { page: 2 }),
      joinAttemptsUrl(parseJoinAttemptsQuery({ q: huge }), 2),
      activityLogUrl(parseActivityLogQuery({ subject: huge, causer: huge }), 2),
      eventListUrl(parseEventListQuery({ q: huge }), { page: 2 }),
      featuredListUrl(parseFeaturedListQuery({ q: huge }), { page: 2 }),
    ];
    for (const url of urls) {
      expect(url).not.toContain(huge.slice(0, 200));
      expect(url.length).toBeLessThan(200);
      const params = new URL(url, env.APP_URL).searchParams;
      for (const key of ["q", "roster_q", "subject", "causer"]) {
        expect(params.get(key), `${url} must not carry ${key}`).toBeNull();
      }
    }
  });

  it("still carries a bound-length search in navigation links", () => {
    const params = new URL(
      featuredListUrl(parseFeaturedListQuery({ q: atBound }), { page: 2 }),
      env.APP_URL,
    ).searchParams;
    expect(params.get("q")).toBe(atBound);
  });

  it("reads overlong filters as unfiltered for zero-row copy", () => {
    expect(rosterEmptyText(parseRosterQuery({ roster_q: huge }))).toBe("No RSVPs yet.");
    expect(featuredEmptyText(parseFeaturedListQuery({ q: huge }))).toBe("No featured content yet.");
    expect(eventEmptyText(parseEventListQuery({ q: huge }))).toBe("No events yet.");
    expect(activityLogEmptyText(parseActivityLogQuery({ subject: huge, causer: huge }))).toBe(
      "No activity yet.",
    );
  });

  it("sends no overlong term to the roster ILIKE sink", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const db = drizzle.mock() as unknown as Db;
    // Real builders and SQL text; only returned rows are fixtures.
    const session = (
      db as unknown as {
        session: {
          prepareQuery: (query: { sql: string; params?: unknown[] }) => unknown;
          transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
        };
      }
    ).session;
    session.prepareQuery = (query) => ({
      setToken() {
        return this;
      },
      execute: async () => {
        captured.push({ sql: query.sql, params: query.params ?? [] });
        return query.sql.startsWith("select count(*)") ? [{ n: 0 }] : [];
      },
    });
    session.transaction = async (work) => work(db);

    // Positive control: the capture really sees the bound LIKE parameter.
    await listRoster(db, "roster", parseRosterQuery({ roster_q: "alice" }));
    expect(captured.some((c) => c.sql.includes("ilike"))).toBe(true);
    expect(captured.flatMap((c) => c.params)).toContain("%alice%");

    captured.length = 0;
    await listRoster(db, "roster", parseRosterQuery({ roster_q: huge }));
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((c) => !c.sql.includes("ilike"))).toBe(true);
    for (const param of captured.flatMap((c) => c.params)) {
      if (typeof param === "string") expect(param.length).toBeLessThanOrEqual(BOUND + 2);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "admin routes with overlong free-text filters (isolated agent-testdb / CI schema)",
  () => {
    let fixture: MemberDataFixture;
    let cookie: string;
    const store = createMemorySessionStore();
    const request = async (path: string) => {
      const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
        path,
        { headers: { cookie } },
        { ...env, ADMIN_DB: fixture.db },
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      cookie = await cookieFor(store, MODERATOR);
    });

    it("featured: overlong q lists unfiltered and is not reflected into the page", async () => {
      const rows = await fixture.db
        .insert(featuredContents)
        .values([
          { title: "Alpha night", isPublished: true, position: 1 },
          { title: "Beta night", isPublished: true, position: 2 },
        ])
        .returning();
      const ids = (html: string) =>
        [...html.matchAll(/data-testid="featured-position-(\d+)"/g)].map((m) => Number(m[1]));
      // Positive control: a normal search still filters.
      expect(ids(await request("/featured?q=Alpha"))).toEqual([rows[0]!.id]);

      const html = await request(`/featured?q=${huge}`);
      expect(ids(html).sort()).toEqual(rows.map((r) => r.id).sort());
      expect(html).not.toContain(huge.slice(0, 200));
    });

    it("events: overlong q lists unfiltered and is not reflected into the page", async () => {
      await fixture.db.insert(events).values({
        eventKey: "bound-check",
        title: "Bound check social",
        startsAt: new Date("2099-10-01T20:00Z"),
        endsAt: new Date("2099-10-01T22:00Z"),
      });
      // Positive control: a normal search still filters.
      expect(await request("/events?q=Bound")).toContain("Bound check social");
      expect(await request("/events?q=absent")).not.toContain("Bound check social");

      const html = await request(`/events?q=${huge}`);
      expect(html).toContain("Bound check social");
      expect(html).not.toContain(huge.slice(0, 200));
    });

    it("roster: overlong roster_q lists the full roster and is not reflected", async () => {
      const [event] = await fixture.db
        .insert(events)
        .values({
          eventKey: "01K00000000000000000000018",
          title: "roster-bound",
          startsAt: new Date("2099-10-01T20:00Z"),
          endsAt: new Date("2099-10-01T22:00Z"),
        })
        .returning();
      await fixture.db.insert(users).values([{ id: "100000000000009001", username: "Alice" }]);
      await fixture.db.insert(rsvps).values([
        { eventId: event!.id, userId: "100000000000009001", status: "going" },
        { eventId: event!.id, userId: "100000000000009002", status: "maybe" },
      ]);
      // Positive control: a normal search still filters.
      expect(await request("/events/01K00000000000000000000018?roster_q=alice")).toContain(
        "RSVPs (1)",
      );

      const html = await request(`/events/01K00000000000000000000018?roster_q=${huge}`);
      expect(html).toContain("RSVPs (2)");
      expect(html).not.toContain(huge.slice(0, 200));
    });

    it("join-attempts: overlong q lists unfiltered and is not reflected", async () => {
      const rows = await fixture.db
        .insert(joinAttempts)
        .values([
          { outcome: "added", discordId: "100000000000008001", requestId: "one" },
          { outcome: "denied", discordId: "100000000000008002", requestId: "two" },
        ])
        .returning();
      const ids = (html: string) =>
        [...html.matchAll(/href="\/admin\/join-attempts\/(\d+)"/g)].map((m) => Number(m[1]));
      // Positive control: the exact-match search still filters.
      expect(ids(await request("/join-attempts?q=100000000000008001"))).toEqual([rows[0]!.id]);

      const html = await request(`/join-attempts?q=${huge}`);
      expect(ids(html).sort()).toEqual(rows.map((r) => r.id).sort());
      expect(html).not.toContain(huge.slice(0, 200));
    });

    it("activity-log: overlong subject/causer list unfiltered and are not reflected", async () => {
      await fixture.db.insert(activityLog).values({
        description: "updated event Bound check",
        subjectType: "Event",
        subjectId: "bound-key",
        causerId: SUBJECT.userId,
        event: "updated",
      });
      // Positive controls: normal subject/causer filters still match and miss.
      expect(await request("/activity-log?subject=Event")).toContain("updated event Bound check");
      expect(await request("/activity-log?subject=absent")).not.toContain(
        "updated event Bound check",
      );
      expect(await request(`/activity-log?causer=${SUBJECT.userId}`)).toContain(
        "updated event Bound check",
      );

      const html = await request(`/activity-log?subject=${huge}&causer=${huge}`);
      expect(html).toContain("updated event Bound check");
      expect(html).not.toContain(huge.slice(0, 200));
    });
  },
);
