import { eq, sql } from "drizzle-orm";
import { Hono, type Handler } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { bufferedMemberText, keyedMemberRead, memberReadBoundary } from "../src/member-reads";
import { memberReadDb, observeMemberReads } from "../src/db/member-reads";
import { alias } from "drizzle-orm/pg-core";
import { events } from "../src/db/admin-schema";
import { nonSensitiveRead } from "../src/member-reads";
import { env, MEMBER, MODERATOR, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const declaration = { resource: "member", action: "list" as const, route: "test.existing-handler" };
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!process.env.DATABASE_URL)("keyed member read boundary (real Postgres)", () => {
  let fixture: MemberDataFixture;
  const logs = () => fixture.db.select().from(memberDataAccessLogs);
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    await seed(fixture.db);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());

  const router = (handler: Handler<{ Bindings: Env }>, viewer = MEMBER.userId) => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) =>
      memberReadBoundary(
        c,
        { ...declaration, viewer },
        (entry) => recordAccess(fixture.db, entry),
        next,
      ),
    );
    app.get("/existing", handler);
    return app;
  };
  const db = () => observeMemberReads(fixture.db);
  const deny = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    for (const value of [...PERSONAL_STRINGS, SUBJECT.userId, "select", "subject_count"])
      expect(body).not.toContain(value);
    expect(await logs()).toHaveLength(0);
  };

  it("uses actual user keys, deduplicates/excludes self and writes one row", async () => {
    const app = router(async (c) => {
      const rows = await keyedMemberRead(() =>
        db().select({ id: users.id, name: users.username }).from(users),
      );
      await keyedMemberRead(() =>
        db()
          .select({ id: users.id, name: users.username })
          .from(users)
          .where(eq(users.id, SUBJECT.userId)),
      );
      return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
    });
    const res = await app.request("/existing", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUBJECT.username);
    expect(await logs()).toMatchObject([
      {
        viewerDiscordId: MEMBER.userId,
        viewerUserId: MEMBER.userId,
        subjectUserIds: [MODERATOR.userId, SUBJECT.userId, "100000000000000104"].sort(),
        subjectCount: 3,
        resource: "member",
        action: "list",
        route: declaration.route,
      },
    ]);
  });

  it.each(["unwrapped", "caught", "extra-in-helper"])(
    "refuses a new %s sensitive query inside an existing handler",
    async (variant) => {
      const app = router(async (c) => {
        const query = () => db().select({ id: users.id, name: users.username }).from(users);
        if (variant === "extra-in-helper") {
          try {
            await keyedMemberRead(async () => {
              await query();
              return query();
            });
          } catch {}
        } else {
          await keyedMemberRead(query);
          if (variant === "caught") {
            try {
              await query();
            } catch {}
          } else await query();
        }
        return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
      });
      await deny(await app.request("/existing", {}, env));
    },
  );

  it.each(["missing", "wrong-table", "raw"])(
    "refuses %s owner attribution without another identity lookup",
    async (variant) => {
      const app = router(async (c) => {
        await keyedMemberRead<unknown>(() =>
          variant === "missing"
            ? db().select({ name: users.username }).from(users)
            : variant === "wrong-table"
              ? db().select({ id: rsvps.id, status: rsvps.status }).from(rsvps)
              : db().execute(sql`select username from users`),
        );
        return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
      });
      await deny(await app.request("/existing", {}, env));
    },
  );

  it.each(["", "not-a-member-key", "123"])(
    "invalid non-null key %s refuses contents before audit",
    async (key) => {
      // Only actual SQL NULL is ownerless; malformed non-null IDs must not
      // silently drop a subject from a mixed result.
      const connection = db();
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
    },
  );

  it.each(["self", "empty"])(
    "explicit %s keyed result serves buffered contents with no row",
    async (variant) => {
      const app = router(async (c) => {
        await keyedMemberRead(() =>
          db()
            .select({ id: users.id, name: users.username })
            .from(users)
            .where(eq(users.id, variant === "self" ? MEMBER.userId : "999999999999999999")),
        );
        return bufferedMemberText(c, "empty/self result");
      });
      expect((await app.request("/existing", {}, env)).status).toBe(200);
      expect(await logs()).toHaveLength(0);
    },
  );

  it.each([true, false])(
    "refuses %s-declared streams before any producer starts",
    async (declared) => {
      let produced = 0;
      const app = router(async (c) => {
        if (declared)
          await keyedMemberRead(() =>
            db().select({ id: users.id, name: users.username }).from(users),
          );
        // An approved buffer cannot classify a subsequent replacement stream.
        if (declared) bufferedMemberText(c, "benign buffer");
        c.res = new Response(
          new ReadableStream(
            {
              pull(controller) {
                produced++;
                controller.enqueue(new TextEncoder().encode(PERSONAL_STRINGS[1]));
              },
            },
            { highWaterMark: 0 },
          ),
        );
        return c.res;
      });
      await deny(await app.request("/existing", {}, env));
      expect(produced).toBe(0);
    },
  );

  it("a REAL failed audit INSERT refuses contents and emits no bindings", async () => {
    const rollback = new Error("rollback failed INSERT fixture");
    await fixture.db
      .transaction(async (tx) => {
        await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
        const connection = observeMemberReads(tx as unknown as typeof fixture.db);
        const app = new Hono<{ Bindings: Env }>();
        app.use("*", (c, next) =>
          memberReadBoundary(
            c,
            { ...declaration, viewer: MEMBER.userId },
            (entry) => recordAccess(tx as unknown as typeof fixture.db, entry),
            next,
          ),
        );
        app.get("/existing", async (c) => {
          const rows = await keyedMemberRead(() =>
            connection.select({ id: users.id, name: users.username }).from(users),
          );
          return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
        });
        const res = await app.request("/existing", {}, env);
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain(SUBJECT.username);
        const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
        for (const value of [
          ...PERSONAL_STRINGS,
          SUBJECT.userId,
          MEMBER.userId,
          "insert into",
          "subject_count",
        ])
          expect(diagnostics).not.toContain(value);
        throw rollback;
      })
      .catch((err: unknown) => {
        if (err !== rollback) throw err;
      });
    expect(await logs()).toHaveLength(0);
  });

  it("sequential and concurrent reads share a DB, never receipts or viewer identities", async () => {
    const connection = db();
    const app = new Hono<{ Bindings: Env }>();
    app.use("/:viewer/:subject", (c, next) =>
      memberReadBoundary(
        c,
        { ...declaration, viewer: c.req.param("viewer")! },
        (entry) => recordAccess(fixture.db, entry),
        next,
      ),
    );
    app.get("/:viewer/:subject", async (c) => {
      const rows = await keyedMemberRead(() =>
        connection
          .select({ id: users.id, name: users.username })
          .from(users)
          .where(eq(users.id, c.req.param("subject")!)),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
    });
    const request = (viewer: string, subject: string) =>
      app.request(`/${viewer}/${subject}`, {}, env);
    const parallel = await Promise.all([
      request(MEMBER.userId, SUBJECT.userId),
      request(MODERATOR.userId, MEMBER.userId),
    ]);
    expect(parallel.map((res) => res.status)).toEqual([200, 200]);
    for (const subject of [MEMBER.userId, "999999999999999999", SUBJECT.userId]) {
      expect((await request(MEMBER.userId, subject)).status).toBe(200);
    }
    expect((await logs()).map((row) => [row.viewerDiscordId, row.subjectUserIds]).sort()).toEqual(
      [
        [MEMBER.userId, [SUBJECT.userId]],
        [MODERATOR.userId, [MEMBER.userId]],
        [MEMBER.userId, [SUBJECT.userId]],
      ].sort(),
    );
  });

  it("prepared statements consume a fresh permit on each execution", async () => {
    const prepared = db()
      .select({ id: users.id, name: users.username })
      .from(users)
      .prepare("keyed_member_prepared");
    const app = router(async (c) => {
      await keyedMemberRead(() => prepared.execute());
      try {
        await prepared.execute();
      } catch {}
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });

  it.each([
    ["prepared", true],
    ["prepared", false],
    ["lazy", true],
    ["lazy", false],
  ] as const)(
    "public borrowed seam observes prebuilt %s queries at execution (keyed=%s)",
    async (mode, keyed) => {
      const connection = memberReadDb(fixture.db);
      const query = connection
        .select({ id: users.id, name: users.username })
        .from(users)
        .where(eq(users.id, SUBJECT.userId));
      const prepared = query.prepare("public_seam_prebuilt");
      const execute = () => (mode === "prepared" ? prepared.execute() : query);
      // Outside capture this remains an ordinary borrowed adapter.
      expect((await execute())[0]!.name).toBe(SUBJECT.username);
      const allowed = router(async (c) => {
        const rows = await (keyed ? keyedMemberRead(execute) : execute());
        return bufferedMemberText(c, rows[0]!.name!);
      });
      const response = await allowed.request("/existing", {}, env);
      if (!keyed) return deny(response);
      expect(response.status).toBe(200);
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
      await clearAuditRows(fixture.db, ["member_data_access_logs"]);
      const unwrapped = router(async (c) => {
        const rows = await execute();
        return bufferedMemberText(c, rows[0]!.name!);
      });
      await deny(await unwrapped.request("/existing", {}, env));
    },
  );

  it.each([false, true])(
    "an aliased relation requires its own owner (projected=%s)",
    async (projectOwner) => {
      const other = alias(users, "other");
      const app = router(async (c) => {
        const rows = await keyedMemberRead(() =>
          db()
            .select({
              viewerId: users.id,
              name: other.username,
              ...(projectOwner ? { otherId: other.id } : {}),
            })
            .from(users)
            .innerJoin(other, eq(other.id, SUBJECT.userId))
            .where(eq(users.id, MEMBER.userId)),
        );
        return bufferedMemberText(c, rows[0]!.name!);
      });
      const response = await app.request("/existing", {}, env);
      if (!projectOwner) return deny(response);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(SUBJECT.username);
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId], subjectCount: 1 }]);
    },
  );

  it("refuses modifying CTEs before execution and preserves stored event data", async () => {
    const original = (await fixture.db.select().from(events))[0]!;
    const app = router(async (c) => {
      const connection = db();
      const change = connection
        .$with("change")
        .as(
          connection
            .update(events)
            .set({ title: "mutated-private-name" })
            .returning({ id: events.id }),
        );
      try {
        await nonSensitiveRead("events", () => connection.with(change).select().from(events));
      } catch {}
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
    expect((await fixture.db.select().from(events))[0]!.title).toBe(original.title);
  });

  it.each([false, true])("native $count cannot bypass observation (keyed=%s)", async (keyed) => {
    const connection = memberReadDb(fixture.db);
    const count = connection.$count(users, eq(users.id, SUBJECT.userId));
    const app = router(async (c) => {
      try {
        await (keyed ? keyedMemberRead(() => count) : count);
      } catch {}
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });

  it("transaction descendants cannot bypass classification", async () => {
    const app = router(async (c) => {
      try {
        await db().transaction((tx) => tx.select().from(users));
      } catch {}
      return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
    });
    await deny(await app.request("/existing", {}, env));
  });
});

describe("buffered member responses", () => {
  it("will not treat an undeclared ordinary Response as classified", async () => {
    const entries: AccessEntry[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) =>
      memberReadBoundary(
        c,
        { ...declaration, viewer: MEMBER.userId },
        async (entry) => {
          entries.push(entry);
          return true;
        },
        next,
      ),
    );
    app.get("/unclassified", () => new Response("sensitive contents"));
    const res = await app.request("/unclassified", {}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("sensitive contents");
    expect(entries).toHaveLength(0);
  });
});
