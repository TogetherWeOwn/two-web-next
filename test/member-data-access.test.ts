// W15 ports AccessRecorder arm/flush and RecordMemberDataAccess. Hono uses a
// request-local declaration instead of Eloquent retrieval observers; see parity table.
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceOn, memberAccessLog, type AccessDecl, type AccessSink } from "../src/access-log";
import { enforceEnabled } from "../src/admin/guard";
import { adminApp } from "../src/admin/routes";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createDbProfileStore } from "../src/profiles/store";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

afterEach(() => vi.restoreAllMocks());

function router(sink: () => Promise<AccessSink | null>) {
  const app = new Hono<{ Bindings: Env; Variables: { viewerId: string; access: AccessDecl } }>();
  app.use("*", async (c, next) => { c.set("viewerId", MEMBER.userId); await next(); });
  app.use("*", memberAccessLog(sink));
  app.get("/read", (c) => {
    c.set("access", { resource: "member", action: "view", route: "test.member", subjects: [SUBJECT.userId] });
    return c.text(PERSONAL_STRINGS[1]!);
  });
  app.get("/unarmed", (c) => c.text("no member data"));
  app.get("/error", (c) => {
    c.set("access", { resource: "member", action: "view", route: "test.error", subjects: [SUBJECT.userId] });
    return c.text("Not found", 404);
  });
  return app;
}

describe("access-log flush lifecycle", () => {
  it.each([
    [undefined, true], ["", true], [" true ", true], ["garbage", true],
    [" false ", false], ["FALSE", false], ["0", false], [" No ", false],
  ])("profile/admin enforcement agree for %s => %s", (flag, expected) => {
    const bindings = { ...env, MEMBER_ACCESS_LOG_ENFORCE: flag };
    expect(enforceOn(bindings)).toBe(expected);
    expect(enforceEnabled(bindings)).toBe(expected);
  });

  it("arming a later request inherits nothing from unarmed/error requests", async () => {
    const write = vi.fn(async (_entry: Parameters<AccessSink>[0]) => true);
    const app = router(async () => write);
    for (const path of ["/read", "/unarmed", "/error", "/read"]) await app.request(path, {}, env);
    expect(write).toHaveBeenCalledTimes(2);
    for (const [entry] of write.mock.calls) {
      expect(entry).toMatchObject({ viewerDiscordId: MEMBER.userId, subjectUserIds: [SUBJECT.userId], route: "test.member" });
    }
  });

  it("does not release the response until the access-log write completes", async () => {
    let entered!: () => void;
    const sinkEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const app = router(async () => async () => { entered(); await persisted; return true; });
    let returned = false;
    const response = Promise.resolve(app.request("/read", {}, env)).then((res) => { returned = true; return res; });
    await sinkEntered;
    expect(returned).toBe(false);
    release();
    expect((await response).status).toBe(200);
  });

  it("does not acquire a sink for an unarmed or error response", async () => {
    const acquire = vi.fn(async () => null);
    const app = router(acquire);
    expect((await app.request("/unarmed", {}, env)).status).toBe(200);
    expect((await app.request("/error", {}, env)).status).toBe(404);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("a missing sink fails closed and replaces all profile contents", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(async () => null).request("/read", {}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(PERSONAL_STRINGS[1]);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("member data access (real recorder on agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let sessions = createMemorySessionStore();
  const profileApp = (connection = db) => profilesApp({
    sessionStore: sessions, store: createDbProfileStore(connection),
    accessLog: (entry) => recordAccess(connection, entry), throttle: async () => ({ limited: false }),
  });
  const admin = (connection = db) => adminApp({ sessionStore: sessions, db: connection });
  const bindings = (connection = db) => ({ ...env, ADMIN_DB: connection });
  const rows = () => db.select().from(memberDataAccessLogs).orderBy(memberDataAccessLogs.id);
  const entry = () => ({ viewerDiscordId: MODERATOR.userId, viewerUserId: MODERATOR.userId, resource: "member", action: "list", subjectUserIds: [SUBJECT.userId], route: "test.members.index" });

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); db = fixture.db; });
  beforeEach(async () => { await fixture.reset(); sessions = createMemorySessionStore(); });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());

  it.each([false, true])("HTML and JSON Accept views log exactly once with profile row=%s", async (hasProfile) => {
    await seed(db, hasProfile);
    const cookie = await cookieFor(sessions, MEMBER);
    const app = profileApp();
    for (const accept of ["text/html", "application/json"]) {
      const res = await app.request(`/members/${SUBJECT.userId}`, { headers: { cookie, accept } }, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain(SUBJECT.username);
    }
    const logs = await rows();
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log).toMatchObject({ viewerDiscordId: MEMBER.userId, viewerUserId: MEMBER.userId, resource: "profile", action: "view", subjectUserIds: [SUBJECT.userId], subjectCount: 1, route: "profiles.show" });
      expect(log.occurredAt).toBeInstanceOf(Date);
    }
    for (const path of ["/profile", `/members/${MEMBER.userId}`, "/members/999999999999999999"]) {
      for (const accept of ["text/html", "application/json"]) {
        expect((await app.request(path, { headers: { cookie, accept } }, env)).status).toBe(path.endsWith("999999999999999999") ? 404 : 200);
      }
    }
    expect(await rows()).toHaveLength(2);
  });

  it("excludes the viewer, deduplicates/sorts a listing and writes one row, not one per member", async () => {
    await seed(db);
    expect(await recordAccess(db, { ...entry(), subjectUserIds: [SUBJECT.userId, MODERATOR.userId, MEMBER.userId, SUBJECT.userId] })).toBe(true);
    const logs = await rows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ subjectUserIds: [SUBJECT.userId, MEMBER.userId].sort(), subjectCount: 2, action: "list" });
    expect(await recordAccess(db, { ...entry(), subjectUserIds: [MODERATOR.userId] })).toBe(false);
    expect(await recordAccess(db, { ...entry(), subjectUserIds: [] })).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("keeps the Discord identity across username changes and deletion of the local viewer", async () => {
    await seed(db);
    await recordAccess(db, entry());
    await db.update(users).set({ username: "renamed-viewer" }).where(eq(users.id, MODERATOR.userId));
    await db.delete(users).where(eq(users.id, MODERATOR.userId));
    const [log] = await rows();
    expect(log!.viewerDiscordId).toBe(MODERATOR.userId);
    expect(JSON.stringify(log)).not.toContain("renamed-viewer");
    // W1 uses a snowflake primary key and no viewer FK; the id remains meaningful.
    expect(log!.viewerUserId).toBe(MODERATOR.userId);
  });

  it("sequential armed/self/404 reads never carry subjects into the next request", async () => {
    await seed(db);
    const app = profileApp();
    const cookie = await cookieFor(sessions, MEMBER);
    for (const path of [`/members/${SUBJECT.userId}`, "/profile", "/members/999999999999999999", `/members/${SUBJECT.userId}`]) {
      await app.request(path, { headers: { cookie } }, env);
    }
    expect((await rows()).map((log) => log.subjectUserIds)).toEqual([[SUBJECT.userId], [SUBJECT.userId]]);
  });

  it("concurrent requests on the same app keep viewer/subject attribution request-local", async () => {
    await seed(db);
    const app = profileApp();
    const memberCookie = await cookieFor(sessions, MEMBER);
    const modCookie = await cookieFor(sessions, MODERATOR);
    const responses = await Promise.all([
      app.request(`/members/${SUBJECT.userId}`, { headers: { cookie: memberCookie } }, env),
      app.request(`/members/${MEMBER.userId}`, { headers: { cookie: modCookie } }, env),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(await rows()).toHaveLength(2);
    expect((await rows()).map((log) => [log.viewerDiscordId, log.subjectUserIds]).sort()).toEqual([
      [MEMBER.userId, [SUBJECT.userId]], [MODERATOR.userId, [MEMBER.userId]],
    ].sort());
  });

  it("owner save and denied member/moderator edits never become target-attributed read rows", async () => {
    await seed(db);
    const app = profileApp();
    for (const actor of [MEMBER, MODERATOR, SUBJECT]) {
      const res = await app.request(`/members/${SUBJECT.userId}`, {
        method: "PATCH", headers: { cookie: await cookieFor(sessions, actor), origin: env.APP_URL, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ bio: "owner save", games: [] }),
      }, env);
      expect(res.status).toBe(actor === SUBJECT ? 200 : 403);
    }
    expect((await createDbProfileStore(db).find(SUBJECT.userId))!.bio).toBe("owner save");
    expect(await rows()).toHaveLength(0);
  });

  it("admin roster/relation and join reads name the actual members, never profile or event ids", async () => {
    await seed(db);
    const cookie = await cookieFor(sessions, MODERATOR);
    for (const path of [`/events/${EVENT_KEY}`, "/join-attempts?q=w15-request"]) {
      const res = await admin().request(path, { headers: { cookie } }, bindings());
      expect(res.status).toBe(200);
    }
    const logs = await rows();
    expect(logs).toHaveLength(2);
    for (const log of logs) expect(log).toMatchObject({ viewerDiscordId: MODERATOR.userId, subjectUserIds: [SUBJECT.userId], subjectCount: 1 });
    expect(logs.map((log) => log.route)).toEqual(["admin.events.edit", "admin.join-attempts.index"]);
    expect(JSON.stringify(logs)).not.toContain("w15-request");
    expect(JSON.stringify(logs)).not.toContain(EVENT_KEY);
  });

  it("dashboard/form reads have no member subjects and no access rows", async () => {
    await seed(db);
    const cookie = await cookieFor(sessions, MODERATOR);
    for (const path of ["/", "/events/new", "/featured/new"]) {
      expect((await admin().request(path, { headers: { cookie } }, bindings())).status).toBe(200);
    }
    expect(await rows()).toHaveLength(0);
  });

  describe("sibling fixture isolation", () => {
    let sibling: MemberDataFixture | undefined;
    // Provisioning canonical migrations has its own bounded setup budget.
    // Disposal remains in the test because its isolation is being asserted.
    beforeAll(async () => { sibling = await createMemberDataFixture(process.env.DATABASE_URL!); }, 30_000);
    afterAll(async () => { await sibling?.dispose(); }, 30_000);

    it("isolates cleanup, failure DDL and disposal from another fixture's rows and constraints", async () => {
      const other = sibling!;
      try {
        expect(other.schemaName).not.toBe(fixture.schemaName);
        await seed(db);
        await seed(other.db);
        await recordAccess(other.db, entry());
        const rollback = new Error("rollback isolated DDL");
        await db.transaction(async (tx) => {
          await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
          throw rollback;
        }).catch((error: unknown) => { if (error !== rollback) throw error; });
        await fixture.reset();
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await other.db.select().from(users)).toHaveLength(4);
        expect(await other.db.select().from(memberDataAccessLogs)).toHaveLength(1);
        const targets = await other.db.execute(sql`
          select distinct target.relnamespace::regnamespace::text as schema_name
          from pg_constraint fk join pg_class source on source.oid = fk.conrelid
          join pg_class target on target.oid = fk.confrelid
          where fk.contype = 'f' and source.relnamespace = current_schema()::regnamespace`);
        expect(targets.map((target) => target.schema_name)).toEqual([other.schemaName]);
      } finally { await other.dispose(); }
      expect(await db.execute(sql`select 1 from pg_namespace where nspname = ${other.schemaName}`)).toHaveLength(0);
      await seed(db); // Disposing a sibling did not drop our tables or FKs.
      expect(await db.select().from(users)).toHaveLength(4);
    });
  });

  it("the access table stores identifiers/metadata only, not another copy of member contents", async () => {
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'member_data_access_logs' order by column_name`);
    expect(columns.map((column) => column.column_name)).toEqual([
      "action", "id", "occurred_at", "resource", "route", "subject_count", "subject_user_ids", "viewer_discord_id", "viewer_user_id",
    ]);
  });

  // DDL is transaction-local and always rolled back, even on assertion failure.
  // A missing-column INSERT is important: it carries bindings in the driver error,
  // unlike a table-missing statement-preparation failure in some drivers.
  it.each([
    ["profile", "text/html", "missing-column"], ["profile", "application/json", "missing-table"],
    ["admin", "text/html", "missing-column"], ["admin", "application/json", "missing-table"],
  ])("%s %s fails closed on a real %s INSERT and sanitizes diagnostics", async (surface, accept, failure) => {
    await seed(db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rollback = new Error("rollback test DDL");
    await db.transaction(async (tx) => {
      if (failure === "missing-column") await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
      else await tx.execute(sql`alter table member_data_access_logs rename to w15_unavailable_access_logs`);
      const connection = tx as unknown as Db;
      const actor = surface === "profile" ? MEMBER : MODERATOR;
      const cookie = await cookieFor(sessions, actor);
      const res = surface === "profile"
        ? await profileApp(connection).request(`/members/${SUBJECT.userId}?search=private-search-token`, { headers: { cookie, accept } }, env)
        : await admin(connection).request(`/events/${EVENT_KEY}?search=private-search-token`, { headers: { cookie, accept } }, bindings(connection));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.text();
      for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId]) expect(body).not.toContain(personal);
      expect(body).not.toContain("SQL");
      expect(spy).toHaveBeenCalled();
      const diagnostics = JSON.stringify(spy.mock.calls);
      expect(diagnostics).toContain("DrizzleQueryError");
      for (const value of [...PERSONAL_STRINGS, SUBJECT.userId, actor.userId, "private-search-token", "insert into", "subject_count"]) expect(diagnostics).not.toContain(value);
      throw rollback;
    }).catch((err: unknown) => { if (err !== rollback) throw err; });
    expect(await rows()).toHaveLength(0); // also proves table/column restoration after rollback
  });
});
