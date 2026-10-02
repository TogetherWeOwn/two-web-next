// Existing profilesApp handlers with real member rows and the real recorder.
// Result fixtures/workerd tests do not substitute for this database proof.
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { users } from "../src/db/schema";
import { keyedMemberRead } from "../src/member-reads";
import { profilesApp } from "../src/profiles/routes";
import { createDbProfileStore } from "../src/profiles/store";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const path = `/members/${SUBJECT.userId}`;

describe.skipIf(!process.env.DATABASE_URL)("keyed retrieval in the existing profile handler (real Postgres)", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => {
    await fixture.reset();
    await seed(fixture.db);
    sessions = createMemorySessionStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.reset(); });
  afterAll(() => fixture?.dispose());
  const request = async (app: ReturnType<typeof profilesApp>) => app.request(path, {
    headers: { cookie: await cookieFor(sessions, MEMBER) },
  }, { ...env, ADMIN_DB: fixture.db });
  const denial = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    for (const value of [...PERSONAL_STRINGS, MEMBER.userId, SUBJECT.userId]) expect(body).not.toContain(value);
  };
  const logs = () => fixture.db.select().from(memberDataAccessLogs);

  it.each(["unwrapped", "caught", "extra-in-helper"])("a new %s query in the existing retrieval cannot borrow the original read's attribution", async (variant) => {
    const original = createDbProfileStore(fixture.db);
    const app = profilesApp({
      sessionStore: sessions, throttle: async () => ({ limited: false }),
      accessLog: (entry) => recordAccess(fixture.db, entry),
      store: { ...original, async find(id) {
        const member = await original.find(id);
        const bindings = { ...env, ADMIN_DB: fixture.db };
        const db = (await dbFor({ env: bindings }))!;
        const query = () => db.select({ id: users.id, name: users.username }).from(users);
        if (variant === "extra-in-helper") {
          try { await keyedMemberRead(async () => { await query(); return query(); }); } catch {}
        } else if (variant === "caught") { try { await query(); } catch {} }
        else await query();
        return member;
      } },
    });
    await denial(await request(app));
    expect(await logs()).toHaveLength(0);
  });

  it.each(["missing", "invalid", "partial"])("refuses a %s returned key, not just a bad route parameter", async (variant) => {
    const original = createDbProfileStore(fixture.db);
    const app = profilesApp({
      sessionStore: sessions, accessLog: (entry) => recordAccess(fixture.db, entry),
      store: { ...original, async find(id) {
        const member = (await original.find(id))!;
        return { ...member, id: variant === "missing" ? undefined : variant === "invalid" ? "invalid-owner" : "123" } as typeof member;
      } },
    });
    await denial(await request(app));
    expect(await logs()).toHaveLength(0);
  });

  it("a REAL failed profile SELECT emits no SQL or bound member identity", async () => {
    const rollback = new Error("rollback keyed profile SELECT proof");
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`alter table users drop column username`);
      const connection = tx as unknown as Db;
      const app = profilesApp({ sessionStore: sessions, stats: async () => null, store: createDbProfileStore(connection), accessLog: (entry) => recordAccess(connection, entry) });
      await denial(await request(app));
      expect(console.error).toHaveBeenCalledExactlyOnceWith("Profile request failed; refusing contents.", { exception: "DrizzleQueryError" });
      const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of [...PERSONAL_STRINGS, MEMBER.userId, SUBJECT.userId, "select", "username"]) expect(diagnostics).not.toContain(value);
      throw rollback;
    }).catch((error: unknown) => { if (error !== rollback) throw error; });
    expect(await logs()).toHaveLength(0);
  });

  it("REAL failed INSERT refuses the actual profile handler and sanitizes diagnostics", async () => {
    const rollback = new Error("rollback keyed profile INSERT proof");
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
      const connection = tx as unknown as Db;
      const app = profilesApp({ sessionStore: sessions, stats: async () => null, store: createDbProfileStore(connection), accessLog: (entry) => recordAccess(connection, entry) });
      await denial(await request(app));
      expect(console.error).toHaveBeenCalledExactlyOnceWith("Member read audit failed; refusing contents.", { exception: "DrizzleQueryError" });
      const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of [...PERSONAL_STRINGS, MEMBER.userId, SUBJECT.userId, "insert into", "subject_count"]) expect(diagnostics).not.toContain(value);
      throw rollback;
    }).catch((error: unknown) => { if (error !== rollback) throw error; });
    expect(await logs()).toHaveLength(0);
    expect(await fixture.db.select().from(users).where(eq(users.id, SUBJECT.userId))).toHaveLength(1);
  });
});
