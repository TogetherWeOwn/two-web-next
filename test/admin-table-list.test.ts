import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store";
import { listJoinAttempts, listRoster, JOIN_RETENTION_DAYS } from "../src/admin/reads";
import {
  featuredListUrl,
  joinAttemptsUrl,
  parseFeaturedListQuery,
  parseJoinAttemptsQuery,
  parseRosterQuery,
  rosterUrl,
  JOIN_ATTEMPT_PAGE_SIZE,
} from "../src/admin/table-list";
import { events, featuredContents, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { joinAttempts, users } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { eventEditorBrowser } from "./helpers/admin-event-editor";

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
    expect(parseFeaturedListQuery({})).toEqual({
      published: "",
      q: "",
      sort: "position",
      order: "asc",
    });
    expect(
      parseFeaturedListQuery({
        published: "false",
        q: `  ${injection}  `,
        sort: injection,
        order: injection,
      }),
    ).toEqual({ published: "", q: injection, sort: "position", order: "asc" });
    expect(parseFeaturedListQuery({ published: "0", sort: "updated_at", order: "desc" })).toEqual({
      published: "0",
      q: "",
      sort: "updated_at",
      order: "desc",
    });
  });

  it("defaults and allowlists roster sort/order independently of event parameters", () => {
    expect(parseRosterQuery({})).toEqual({ q: "", sort: "answered", order: "desc" });
    expect(
      parseRosterQuery({ roster_q: "  Alice  ", roster_sort: "status", roster_order: "asc" }),
    ).toEqual({ q: "Alice", sort: "status", order: "asc" });
    expect(
      parseRosterQuery({
        q: "wrong",
        sort: "status",
        roster_sort: injection,
        roster_order: injection,
      }),
    ).toEqual({ q: "", sort: "answered", order: "desc" });
  });

  it.each(["", "0", "-1", "1.5", "1e2", "Infinity", injection, "9007199254740991"])(
    "normalizes unsafe page %s",
    (page) => {
      expect(parseJoinAttemptsQuery({ page }).page).toBe(1);
    },
  );

  it("preserves and encodes all filter state in navigation", () => {
    const featured = parseFeaturedListQuery({
      published: "1",
      q: 'A & "B"',
      sort: "updated_at",
      order: "desc",
    });
    expect(
      Object.fromEntries(
        new URL(featuredListUrl(featured, { order: "asc" }), env.APP_URL).searchParams,
      ),
    ).toEqual({ published: "1", q: 'A & "B"', sort: "updated_at", order: "asc" });
    const roster = parseRosterQuery({
      roster_q: injection,
      roster_sort: "status",
      roster_order: "asc",
    });
    const url = new URL(
      rosterUrl("event", roster, { sort: "answered", order: "desc" }),
      env.APP_URL,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      roster_q: injection,
      roster_sort: "answered",
      roster_order: "desc",
    });
    expect(url.hash).toBe("#rsvp-roster");
    expect(
      Object.fromEntries(
        new URL(joinAttemptsUrl({ outcome: "denied", q: "request & id", page: 2 }, 3), env.APP_URL)
          .searchParams,
      ),
    ).toEqual({ outcome: "denied", q: "request & id", page: "3" });
  });

  it("keeps filtered/sorted/paged views behind the existing moderator guard", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, MEMBER);
    for (const path of [
      "/featured?published=0&q=alice&sort=updated_at",
      "/events/event?roster_q=alice&roster_sort=status",
      "/join-attempts?page=2",
    ]) {
      expect((await app.request(path, {}, env)).status).toBe(302);
      expect((await app.request(path, { headers: { cookie } }, env)).status).toBe(403);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "admin tables (isolated agent-testdb / CI schema)",
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
    const logs = () =>
      fixture.db.select().from(memberDataAccessLogs).orderBy(memberDataAccessLogs.id);
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      cookie = await cookieFor(store, MODERATOR);
    });

    async function seedFeatured() {
      return fixture.db
        .insert(featuredContents)
        .values([
          {
            title: "Alpha night",
            isPublished: true,
            position: 2,
            updatedAt: new Date("2026-10-01T01:00Z"),
          },
          {
            title: "Beta night",
            isPublished: false,
            position: 1,
            updatedAt: new Date("2026-10-02T01:00Z"),
          },
          {
            title: "Gamma night",
            isPublished: true,
            position: 1,
            updatedAt: new Date("2026-10-02T01:00Z"),
          },
          {
            title: "100%_\\ literal",
            isPublished: false,
            position: 3,
            updatedAt: new Date("2026-10-03T01:00Z"),
          },
          {
            title: injection,
            isPublished: true,
            position: 4,
            updatedAt: new Date("2026-10-04T01:00Z"),
          },
        ])
        .returning();
    }

    it.each(["1", "0", ""])(
      "featured published=%s combines with case-insensitive title search and audits exactly the results",
      async (published) => {
        const rows = await seedFeatured();
        const expected = rows.filter(
          (r) => r.title.includes("night") && (!published || r.isPublished === (published === "1")),
        );
        const html = await request(`/featured?published=${published}&q=NIGHT`);
        expect(featuredIds(html).sort()).toEqual(expected.map((r) => r.id).sort());
        expect(await logs()).toEqual([]); // Featured IDs are resources, not member keys.
        expect(html).toContain(`value="${published}" selected`);
        expect(html).toContain('name="q" type="search" value="NIGHT"');
      },
    );

    it.each(["position", "updated_at"])(
      "featured sort=%s supports both directions and stable id ties",
      async (sort) => {
        const rows = await seedFeatured();
        for (const order of ["asc", "desc"] as const) {
          const expected = [...rows].sort((a, b) => {
            const diff =
              sort === "position"
                ? a.position - b.position
                : a.updatedAt.getTime() - b.updatedAt.getTime();
            return (order === "asc" ? diff : -diff) || a.id - b.id;
          });
          expect(featuredIds(await request(`/featured?sort=${sort}&order=${order}`))).toEqual(
            expected.map((r) => r.id),
          );
        }
        expect((await listFeatured(fixture.db, { sort: injection })).map((r) => r.id)).toEqual(
          (await listFeatured(fixture.db, {})).map((r) => r.id),
        );
      },
    );

    it("featured literal LIKE escaping and injection-shaped q neither broaden nor execute SQL", async () => {
      const rows = await seedFeatured();
      for (const q of ["%_\\", injection]) {
        const expected = q === injection ? rows[4]! : rows[3]!;
        const html = await request(`/featured?q=${encodeURIComponent(q)}`);
        expect(featuredIds(html)).toEqual([expected.id]);
        expect(await logs()).toEqual([]);
      }
      expect(await fixture.db.select().from(featuredContents)).toHaveLength(5);
      expect(await fixture.db.select().from(users)).toEqual([]);
      const empty = await request("/featured?q=absent");
      expect(empty).toContain('colspan="5" data-testid="featured-empty"');
      expect(await logs()).toEqual([]); // All featured projections are classified non-sensitive.
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
      const [event, other] = await fixture.db
        .insert(events)
        .values(
          ["roster", "other"].map((eventKey) => ({
            eventKey,
            title: eventKey,
            startsAt: new Date("2099-10-01T20:00Z"),
            endsAt: new Date("2099-10-01T22:00Z"),
          })),
        )
        .returning();
      await fixture.db.insert(users).values([
        { id: "100000000000001001", username: "Alice" },
        { id: "100000000000001002", username: "Alice 100%_\\" },
        { id: "100000000000001003", username: injection },
        { id: "100000000000001004", username: "Drew" },
      ]);
      await fixture.db.insert(rsvps).values([
        {
          eventId: event!.id,
          userId: "100000000000001001",
          status: "going",
          updatedAt: new Date("2026-10-01T01:00Z"),
        },
        {
          eventId: event!.id,
          userId: "100000000000001002",
          status: "maybe",
          updatedAt: new Date("2026-10-02T01:00Z"),
        },
        {
          eventId: event!.id,
          userId: "100000000000001003",
          status: "going",
          updatedAt: new Date("2026-10-02T01:00Z"),
        },
        {
          eventId: event!.id,
          userId: "100000000000001005",
          status: "not_going",
          updatedAt: new Date("2026-10-03T01:00Z"),
        },
        { eventId: other!.id, userId: "100000000000001004", status: "going" },
      ]);
      return listRoster(fixture.db, "roster");
    }

    it("roster member search is server-side, literal, event-scoped and access-logs only rendered members", async () => {
      await seedRoster();
      for (const [q, ids] of [
        ["alice", ["100000000000001001", "100000000000001002"]],
        ["%_\\", ["100000000000001002"]],
        [injection, ["100000000000001003"]],
        ["Drew", []],
      ] as const) {
        const html = await request(`/events/roster?roster_q=${encodeURIComponent(q)}`);
        expect(html).toContain(`RSVPs (${ids.length})`);
        if (ids.length) expect((await logs()).at(-1)!.subjectUserIds).toEqual(ids);
        expect(html).not.toContain("100000000000001005");
        expect(html).not.toContain("Unknown member");
        if (q !== "alice" && q !== "%_\\") expect(html).not.toContain("Alice");
      }
      expect(await logs()).toHaveLength(3);
      expect((await logs()).every((r) => r.route === "admin.events.edit")).toBe(true);
      expect(await fixture.db.select().from(users)).toHaveLength(4);
    });

    it.each(["status", "answered"])(
      "roster sort=%s supports both directions and stable member ties",
      async (sort) => {
        const rows = await seedRoster();
        for (const order of ["asc", "desc"] as const) {
          const query = parseRosterQuery({ roster_sort: sort, roster_order: order });
          const expected = [...rows].sort((a, b) => {
            const diff =
              sort === "status"
                ? a.status.localeCompare(b.status)
                : a.answeredAt.getTime() - b.answeredAt.getTime();
            return (order === "asc" ? diff : -diff) || a.userId.localeCompare(b.userId);
          });
          expect((await listRoster(fixture.db, "roster", query)).map((r) => r.userId)).toEqual(
            expected.map((r) => r.userId),
          );
          const html = await request(`/events/roster?roster_sort=${sort}&roster_order=${order}`);
          const names = expected.map((r) => r.username ?? "Unknown member");
          // Table cell positions, not form values/encoded query strings.
          const positions = names.map((name) =>
            html.indexOf(`<td>${name.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}</td>`),
          );
          expect(positions.every((p) => p >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
        }
      },
    );

    it("roster invalid sorts use newest-first; headers/search preserve state and missing names do not expose ids", async () => {
      await seedRoster();
      const fallback = await request(
        `/events/roster?roster_sort=${encodeURIComponent(injection)}&roster_order=invalid`,
      );
      expect(fallback.indexOf("Unknown member")).toBeLessThan(fallback.indexOf("Alice"));
      expect(fallback).not.toContain("100000000000001005");
      expect(fallback).toContain('aria-label="Sort by answered ascending"');
      const html = await request(
        "/events/roster?roster_q=alice&roster_sort=status&roster_order=asc",
      );
      expect(html).toContain('aria-sort="ascending"');
      expect(html).toContain(
        "roster_sort=status&amp;roster_order=desc&amp;roster_q=alice#rsvp-roster",
      );
      expect(html).toContain('name="roster_sort" value="status"');
      expect(html).toContain('name="roster_order" value="asc"');
      expect(html).toContain('id="roster-q" name="roster_q" type="search" value="alice"');
      expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
      expect(html).toContain(
        '<form method="post" action="/admin/events/roster" data-event-editor="">',
      );
      expect(html).toContain(
        '<form method="get" action="/admin/events/roster#rsvp-roster" class="filters">',
      );
      expect(html.match(/data-event-editor/g)).toHaveLength(1); // Only Save bypasses the dirty guard.
    });

    it.each(["invalid", "1"])(
      "keeps the returned draft dirty when Save rejects capacity=%s before or during update",
      async (capacity) => {
        await seedRoster();
        const clean = await request("/events/roster");
        expect(clean).not.toContain("data-event-draft");
        const fields = {
          title: "Rejected draft",
          starts_at: "2099-10-01 20:00",
          ends_at: "2099-10-01 22:00",
          timezone: "UTC",
          capacity,
        };
        const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
          "/events/roster",
          {
            method: "POST",
            headers: {
              cookie,
              origin: env.APP_URL,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(fields),
          },
          { ...env, ADMIN_DB: fixture.db },
        );
        expect(response.status).toBe(422);
        const html = await response.text();
        expect(html).toContain('name="title" type="text" value="Rejected draft"');
        expect(html).toContain('data-event-editor="" data-event-draft=""');
        expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
        const persisted = (await fixture.db.select().from(events)).find(
          (r) => r.eventKey === "roster",
        )!;
        expect(persisted.title).toBe("roster");
        expect(persisted.capacity).toBeNull();
        // Run the actual island with the error page's dirty marker and returned fields.
        const b = eventEditorBrowser({
          draft: html.includes('data-event-draft=""'),
          initial: fields,
        });
        const departure = b.navigate("sort");
        expect(departure.preventDefault).toHaveBeenCalledOnce();
        expect(departure.returnValue).toBe("");
        expect(b.values.get("title")).toBe("Rejected draft");
        expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
        const retry = await adminApp({ sessionStore: store, db: fixture.db }).request(
          "/events/roster",
          {
            method: "POST",
            headers: {
              cookie,
              origin: env.APP_URL,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ ...fields, capacity: "2" }),
          },
          { ...env, ADMIN_DB: fixture.db },
        );
        expect(retry.status).toBe(303);
        const saved = await request("/events/roster");
        expect(saved).toContain('name="title" type="text" value="Rejected draft"');
        expect(saved).not.toContain("data-event-draft");
        expect(
          eventEditorBrowser({ initial: { ...fields, capacity: "2" } }).navigate("sort")
            .preventDefault,
        ).not.toHaveBeenCalled();
      },
    );

    it("roster uses a readable fallback for absent, empty and whitespace names without exposing member ids", async () => {
      const [event] = await fixture.db
        .insert(events)
        .values({
          eventKey: "missing-names",
          title: "Missing names",
          startsAt: new Date("2099-10-01T20:00Z"),
          endsAt: new Date("2099-10-01T22:00Z"),
        })
        .returning();
      await fixture.db.insert(users).values([
        { id: "100000000000002002", username: "" },
        { id: "100000000000002003", username: " \t\n " },
        { id: "100000000000002004", username: " Alice " },
      ]);
      const ids = [
        "100000000000002001",
        "100000000000002002",
        "100000000000002003",
        "100000000000002004",
      ];
      await fixture.db
        .insert(rsvps)
        .values(ids.map((userId) => ({ eventId: event!.id, userId, status: "going" as const })));
      const html = await request("/events/missing-names");
      expect(html.match(/<td>Unknown member<\/td>/g)).toHaveLength(3);
      expect(html).toContain("<td>Alice</td>");
      expect(html).not.toContain("<td></td>");
      for (const id of ids) expect(html).not.toContain(id);
      expect((await logs()).at(-1)!.subjectUserIds).toEqual([...ids].sort());
    });

    it("distinguishes unmatched roster/featured filters from a genuinely empty table", async () => {
      await seedRoster();
      await seedFeatured();
      expect(await request("/events/roster?roster_q=absent")).toContain(
        "No RSVPs match this member search.",
      );
      expect(await request("/events/other?roster_q=absent")).not.toContain("No RSVPs yet.");
      expect(await request("/featured?q=absent")).toContain(
        "No featured content matches these filters.",
      );
      await fixture.db.delete(featuredContents);
      expect(await request("/featured?published=0")).toContain(
        "No featured content matches these filters.",
      );
      expect(await request("/featured")).toContain("No featured content yet.");
      await fixture.db.delete(rsvps);
      expect(await request("/events/roster")).toContain("No RSVPs yet.");
    });

    it("join pages retain filters, reach older attempts, audit every retrieved owner, and keep stable id ordering", async () => {
      const now = new Date();
      const rows = await fixture.db
        .insert(joinAttempts)
        .values(
          Array.from({ length: JOIN_ATTEMPT_PAGE_SIZE + 2 }, (_, i) => ({
            outcome: "denied",
            requestId: "request & trace",
            discordId: String(100000000000003000n + BigInt(i)),
            createdAt: now,
          })),
        )
        .returning();
      await fixture.db.insert(joinAttempts).values([
        { outcome: "added", requestId: "request & trace", discordId: "wrong-outcome" },
        { outcome: "denied", requestId: "wrong-query", discordId: "wrong-query" },
        {
          outcome: "denied",
          requestId: "request & trace",
          discordId: "expired",
          createdAt: new Date(now.getTime() - (JOIN_RETENTION_DAYS + 1) * 86_400_000),
        },
      ]);
      const ordered = [...rows].reverse();
      const first = await request("/join-attempts?outcome=denied&q=request+%26+trace");
      expect(attemptIds(first)).toEqual(ordered.slice(0, JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
      expect(link(first, "prev")).toBeUndefined();
      const next = new URL(link(first, "next")!, env.APP_URL);
      expect(Object.fromEntries(next.searchParams)).toEqual({
        outcome: "denied",
        q: "request & trace",
        page: "2",
      });
      const second = await request(`/join-attempts${next.search}`);
      expect(attemptIds(second)).toEqual(ordered.slice(JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
      expect(link(second, "next")).toBeUndefined();
      const prev = new URL(link(second, "prev")!, env.APP_URL);
      expect(Object.fromEntries(prev.searchParams)).toEqual({
        outcome: "denied",
        q: "request & trace",
        page: "1",
      });
      const access = await logs();
      expect(access).toHaveLength(2); // One real row per request, not per member.
      expect(access[0]!.subjectUserIds).toEqual(
        ordered
          .slice(0, JOIN_ATTEMPT_PAGE_SIZE + 1)
          .map((r) => r.discordId!)
          .sort(),
      );
      expect(access[1]!.subjectUserIds).toEqual(
        ordered
          .slice(JOIN_ATTEMPT_PAGE_SIZE)
          .map((r) => r.discordId!)
          .sort(),
      );
      expect(access[0]!.subjectCount).toBe(JOIN_ATTEMPT_PAGE_SIZE + 1);
      expect(access[0]!.subjectUserIds).toContain(ordered[JOIN_ATTEMPT_PAGE_SIZE]!.discordId);
      expect(first).not.toContain(ordered[JOIN_ATTEMPT_PAGE_SIZE]!.discordId); // Retrieved but not rendered.
      expect(access.every((r) => r.route === "admin.join-attempts.index")).toBe(true);
      expect(await fixture.db.select().from(joinAttempts)).toHaveLength(JOIN_ATTEMPT_PAGE_SIZE + 5);
    });

    it.each([null, "invalid-owner", "123"])(
      "refuses the whole page when its unrendered lookahead owner is %s",
      async (owner) => {
        const createdAt = new Date();
        await fixture.db.insert(joinAttempts).values(
          Array.from({ length: JOIN_ATTEMPT_PAGE_SIZE + 1 }, (_, i) => ({
            outcome: "added",
            requestId: "private-page-sentinel",
            createdAt,
            discordId: i === 0 ? owner : String(100000000000005000n + BigInt(i)),
          })),
        );
        const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
          "/join-attempts",
          {
            headers: { cookie },
          },
          { ...env, ADMIN_DB: fixture.db },
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).not.toContain("private-page-sentinel");
        expect(body).not.toContain("100000000000005");
        expect(await logs()).toEqual([]);
      },
    );

    it("join exact Discord/request search, empty pages and invalid page state remain usable", async () => {
      await fixture.db.insert(joinAttempts).values([
        { outcome: "added", discordId: "100000000000004001", requestId: "one" },
        { outcome: "added", discordId: "1000000000000040010", requestId: "two" },
        { outcome: "denied", requestId: injection },
      ]);
      const exact = await request("/join-attempts?q=100000000000004001&page=invalid");
      expect(attemptIds(exact)).toHaveLength(1);
      expect(exact).toContain("Page 1");
      expect(await listJoinAttempts(fixture.db, { q: injection })).toHaveLength(1);
      const empty = await request("/join-attempts?outcome=added&page=2");
      expect(empty).toContain("No join attempts.");
      expect(link(empty, "prev")).toContain("outcome=added");
      expect(link(empty, "next")).toBeUndefined();
      expect(await logs()).toHaveLength(1);
    });
  },
);
