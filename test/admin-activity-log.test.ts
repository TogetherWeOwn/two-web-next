// route-inventory: GET /admin/activity-log
// Admin activity-log viewer (R11): moderator-only, paginated, access-logged,
// never renders raw properties JSON.
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { ACTIVITY_LOG_PAGE_SIZE, parseActivityLogQuery } from "../src/admin/table-list";
import { activityLog, memberDataAccessLogs } from "../src/db/admin-schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe("activity-log guard pins (local fixtures)", () => {
  it("redirects guests and forbids members before any activity read", async () => {
    const sessions = createMemorySessionStore();
    const app = adminApp(sessions);
    const guest = await app.request("/activity-log", {}, env);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");
    const cookie = await cookieFor(sessions, MEMBER);
    for (const path of ["/activity-log", "/activity-log?subject=Event", "/activity-log?page=2"]) {
      expect((await app.request(path, { headers: { cookie } }, env)).status, path).toBe(403);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "offers no %s activity-log route, even to moderators",
    async (method) => {
      const sessions = createMemorySessionStore();
      const cookie = await cookieFor(sessions, MODERATOR);
      const res = await adminApp(sessions).request(
        "/activity-log",
        { method, headers: { cookie, origin: env.APP_URL } },
        env,
      );
      expect(res.status).toBe(404);
    },
  );

  it("normalizes unsafe activity-log query state", () => {
    expect(parseActivityLogQuery({})).toEqual({ subject: "", causer: "", page: 1 });
    for (const page of ["", "0", "-1", "1.5", "1e2", "Infinity", "9007199254740993"]) {
      expect(parseActivityLogQuery({ page }).page, page).toBe(1);
    }
    expect(parseActivityLogQuery({ subject: "  Event  ", causer: "  123  ", page: "2" })).toEqual({
      subject: "Event",
      causer: "123",
      page: 2,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("activity-log viewer (isolated agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();
  let cookie: string;
  const app = () => adminApp({ sessionStore: sessions, db: fixture.db });
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db });
  const read = (qs = "") =>
    app().request(`/activity-log${qs}`, { headers: { cookie } }, bindings());
  const logs = () => fixture.db.select().from(memberDataAccessLogs);

  const seedRow = (overrides: Partial<typeof activityLog.$inferInsert> = {}) =>
    fixture.db
      .insert(activityLog)
      .values({
        description: "updated event Friday games",
        subjectType: "Event",
        subjectId: "01J00000000000000000000015",
        causerId: SUBJECT.userId,
        event: "updated",
        ...overrides,
      })
      .returning()
      .then((rows) => rows[0]!);

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    sessions = createMemorySessionStore();
    cookie = await cookieFor(sessions, MODERATOR);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => fixture?.dispose());

  it("renders moderator rows (who, what, when, subject) and writes one access-log row", async () => {
    const row = await seedRow();
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Activity log");
    expect(html).toContain(row.description);
    expect(html).toContain(SUBJECT.userId);
    expect(html).toContain("Event");
    expect(html).toContain(row.subjectId!);
    expect(html).toContain(row.createdAt!.toISOString());
    expect(html).not.toContain('method="post"');
    const entries = await logs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      viewerDiscordId: MODERATOR.userId,
      viewerUserId: MODERATOR.userId,
      resource: "activity_log",
      action: "list",
      route: "admin.activity-log.index",
      subjectUserIds: [SUBJECT.userId],
      subjectCount: 1,
    });
  });

  it("filters by subject and causer", async () => {
    await seedRow({
      description: "created event Alpha",
      subjectType: "Event",
      subjectId: "alpha-key",
      causerId: SUBJECT.userId,
    });
    await seedRow({
      description: "created featured Beta",
      subjectType: "FeaturedContent",
      subjectId: "42",
      causerId: MEMBER.userId,
    });
    let html = await (await read("?subject=alpha")).text();
    expect(html).toContain("Alpha");
    expect(html).not.toContain("Beta");
    html = await (await read(`?causer=${MEMBER.userId}`)).text();
    expect(html).toContain("Beta");
    expect(html).not.toContain("Alpha");
    html = await (await read("?subject=zz-no-matches")).text();
    expect(html).toContain("No activity matches these filters.");
  });

  it("paginates at the page-size boundary with prev/next links", async () => {
    const rows = [];
    for (let i = 0; i < ACTIVITY_LOG_PAGE_SIZE + 1; i++) {
      rows.push(
        await seedRow({ description: `row ${i}`, subjectId: `key-${i}`, causerId: SUBJECT.userId }),
      );
    }
    expect(rows).toHaveLength(ACTIVITY_LOG_PAGE_SIZE + 1);
    const first = await read();
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("Page 1");
    expect(firstHtml).toContain('rel="next"');
    expect(firstHtml).not.toContain('rel="prev"');
    const second = await read("?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).toContain("Page 2");
    expect(secondHtml).toContain('rel="prev"');
    expect(secondHtml).not.toContain('rel="next"');
    // Out-of-range and unsafe pages fall back without crashing.
    for (const qs of ["?page=9999", "?page=0", "?page=abc"]) {
      const res = await read(qs);
      expect(res.status, qs).toBe(200);
    }
  });

  it("never renders raw properties JSON", async () => {
    const beforeValue = "not-rendered-before-value";
    await seedRow({
      description: "updated event Gamma",
      properties: { title: { before: beforeValue, after: "new" } },
    });
    const html = await (await read()).text();
    expect(html).toContain("Gamma");
    expect(html).not.toContain(beforeValue);
    expect(html).not.toContain("before");
  });

  it("renders an empty state with no access-log row when nothing names a member", async () => {
    await seedRow({ causerId: null, description: "system sweep" });
    const res = await read();
    expect(res.status).toBe(200);
    // System-only page names no member: no subjects, no log row.
    expect(await logs()).toHaveLength(0);
    await fixture.reset();
    sessions = createMemorySessionStore();
    cookie = await cookieFor(sessions, MODERATOR);
    const empty = await read();
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No activity yet.");
    expect(await logs()).toHaveLength(0);
  });

  it("fails closed when the access-log insert fails, without releasing contents", async () => {
    const row = await seedRow();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.db.execute(
      sql`ALTER TABLE member_data_access_logs RENAME TO unavailable_access_logs`,
    );
    try {
      const res = await read();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).not.toContain(row.description);
      expect(html).not.toContain(row.subjectId!);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE unavailable_access_logs RENAME TO member_data_access_logs`,
      );
    }
    expect(await logs()).toHaveLength(0);
  });
});
