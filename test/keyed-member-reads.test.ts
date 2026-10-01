import { eq, sql } from "drizzle-orm";
import { Hono, type Handler } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { bufferedMemberText, keyedMemberRead, memberReadBoundary } from "../src/member-reads";
import { observeMemberReads } from "../src/db/member-reads";
import { env, MEMBER, MODERATOR, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const declaration = { resource: "member", action: "list" as const, route: "test.existing-handler" };
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!process.env.DATABASE_URL)("keyed member read boundary (real Postgres)", () => {
  let fixture: MemberDataFixture;
  const logs = () => fixture.db.select().from(memberDataAccessLogs);
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => { await fixture.reset(); await seed(fixture.db); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());

  const router = (handler: Handler<{ Bindings: Env }>, viewer = MEMBER.userId) => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) => memberReadBoundary(c, { ...declaration, viewer }, (entry) => recordAccess(fixture.db, entry), next));
    app.get("/existing", handler);
    return app;
  };
  const db = () => observeMemberReads(fixture.db);
  const deny = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    for (const value of [...PERSONAL_STRINGS, SUBJECT.userId, "select", "subject_count"]) expect(body).not.toContain(value);
    expect(await logs()).toHaveLength(0);
  };

  it("uses actual user keys, deduplicates/excludes self and writes one row", async () => {
    const app = router(async (c) => {
      const rows = await keyedMemberRead(() => db().select({ id: users.id, name: users.username }).from(users));
      await keyedMemberRead(() => db().select({ id: users.id, name: users.username }).from(users).where(eq(users.id, SUBJECT.userId)));
      return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
    });
    const res = await app.request("/existing", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUBJECT.username);
    expect(await logs()).toMatchObject([{
      viewerDiscordId: MEMBER.userId, viewerUserId: MEMBER.userId,
      subjectUserIds: [MODERATOR.userId, SUBJECT.userId, "100000000000000104"].sort(),
      subjectCount: 3, resource: "member", action: "list", route: declaration.route,
    }]);
  });

  it.each(["unwrapped", "caught", "extra-in-helper"])("refuses a new %s sensitive query inside an existing handler", async (variant) => {
    const app = router(async (c) => {
      const query = () => db().select({ id: users.id, name: users.username }).from(users);
      if (variant === "extra-in-helper") {
        try { await keyedMemberRead(async () => { await query(); return query(); }); } catch {}
      } else {
        await keyedMemberRead(query);
        if (variant === "caught") { try { await query(); } catch {} }
        else await query();
      }
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });

  it.each(["missing", "wrong-table", "raw"])("refuses %s owner attribution without another identity lookup", async (variant) => {
    const app = router(async (c) => {
      await keyedMemberRead<unknown>(() => variant === "missing"
        ? db().select({ name: users.username }).from(users)
        : variant === "wrong-table"
          ? db().select({ id: rsvps.id, status: rsvps.status }).from(rsvps)
          : db().execute(sql`select username from users`));
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });

  it.each([null, "not-a-member-key", "123"])("invalid/partial key %s refuses contents before audit", async (key) => {
    // Test-service-only raw rows reproduce incomplete legacy projections without
    // relaxing the production table's primary key constraint.
    const connection = db();
    await fixture.db.execute(sql`alter table join_attempts alter column discord_id drop not null`);
    const { joinAttempts } = await import("../src/db/schema");
    await fixture.db.insert(joinAttempts).values([
      { requestId: "keyed-valid", discordId: SUBJECT.userId, outcome: "joined" },
      { requestId: "keyed-invalid", discordId: key, outcome: "joined" },
    ]);
    const app = router(async (c) => {
      await keyedMemberRead(() => connection.select().from(joinAttempts));
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });

  it.each(["self", "empty"])("explicit %s keyed result serves buffered contents with no row", async (variant) => {
    const app = router(async (c) => {
      await keyedMemberRead(() => db().select({ id: users.id, name: users.username }).from(users)
        .where(eq(users.id, variant === "self" ? MEMBER.userId : "999999999999999999")));
      return bufferedMemberText(c, "empty/self result");
    });
    expect((await app.request("/existing", {}, env)).status).toBe(200);
    expect(await logs()).toHaveLength(0);
  });

  it.each([true, false])("refuses %s-declared streams before any producer starts", async (declared) => {
    let produced = 0;
    const app = router(async (c) => {
      if (declared) await keyedMemberRead(() => db().select({ id: users.id, name: users.username }).from(users));
      // An approved buffer cannot classify a subsequent replacement stream.
      if (declared) bufferedMemberText(c, "benign buffer");
      c.res = new Response(new ReadableStream({ pull(controller) { produced++; controller.enqueue(new TextEncoder().encode(PERSONAL_STRINGS[1])); } }, { highWaterMark: 0 }));
      return c.res;
    });
    await deny(await app.request("/existing", {}, env));
    expect(produced).toBe(0);
  });

  it("a REAL failed audit INSERT refuses contents and emits no bindings", async () => {
    const rollback = new Error("rollback failed INSERT fixture");
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
      const connection = observeMemberReads(tx as unknown as typeof fixture.db);
      const app = new Hono<{ Bindings: Env }>();
      app.use("*", (c, next) => memberReadBoundary(c, { ...declaration, viewer: MEMBER.userId }, (entry) => recordAccess(tx as unknown as typeof fixture.db, entry), next));
      app.get("/existing", async (c) => {
        const rows = await keyedMemberRead(() => connection.select({ id: users.id, name: users.username }).from(users));
        return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(SUBJECT.username);
      const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of [...PERSONAL_STRINGS, SUBJECT.userId, MEMBER.userId, "insert into", "subject_count"]) expect(diagnostics).not.toContain(value);
      throw rollback;
    }).catch((err: unknown) => { if (err !== rollback) throw err; });
    expect(await logs()).toHaveLength(0);
  });

  it("transaction descendants cannot bypass classification", async () => {
    const app = router(async (c) => {
      try { await db().transaction((tx) => tx.select().from(users)); } catch {}
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });
});

describe("buffered member responses", () => {
  it("will not treat an undeclared ordinary Response as classified", async () => {
    const entries: AccessEntry[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) => memberReadBoundary(c, { ...declaration, viewer: MEMBER.userId }, async (entry) => { entries.push(entry); return true; }, next));
    app.get("/unclassified", () => new Response("sensitive contents"));
    const res = await app.request("/unclassified", {}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("sensitive contents");
    expect(entries).toHaveLength(0);
  });
});
