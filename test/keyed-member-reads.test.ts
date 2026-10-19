import { eq, sql } from "drizzle-orm";
import { Hono, type Handler } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { joinAttempts as attempts, profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  bufferedMemberText,
  declareMemberResult,
  keyedMemberRead,
  MemberReadRefused,
  memberReadBoundary,
} from "../src/member-reads";
import { requestLog } from "../src/request-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
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
    __resetAlertRateLimitForTests();
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

  it.each(["direct", "derived"])(
    "a %s union cannot launder another table's rows through the nullable join owner",
    async (shape) => {
      // The profile row has a valid owner but a SQL-NULL bio. Relabelled as
      // join_attempts.discord_id, that NULL must not drop the profile subject.
      const marker = "synthetic-private-timezone-marker";
      await fixture.db.update(profiles).set({ bio: null, timezone: marker });
      await fixture.db
        .insert(attempts)
        .values({ discordId: null, requestId: "pre-identity", outcome: "denied" });
      const connection = db();
      const app = router(async (c) => {
        const combined = connection
          .select({ owner: attempts.discordId, trace: attempts.requestId })
          .from(attempts)
          .where(eq(attempts.outcome, "denied"))
          .unionAll(
            connection.select({ owner: profiles.bio, trace: profiles.timezone }).from(profiles),
          );
        const mixed = combined.as("mixed");
        const query =
          shape === "derived"
            ? connection.select({ owner: mixed.owner, trace: mixed.trace }).from(mixed)
            : combined;
        const rows = await keyedMemberRead(() => query);
        return bufferedMemberText(c, JSON.stringify(rows));
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(marker);
      expect(await logs()).toHaveLength(0);
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

  it("forced-overlap reads rendezvous after distinct sensitive reads, never sharing receipts", async () => {
    const connection = db();
    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    type Gate = { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
    const gates = new Map<string, Gate>();
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
      // Rendezvous after the distinct sensitive read, while the capture is
      // still open and before the buffered response is released. Probe
      // requests (self/empty, no gate) proceed without parking.
      const gate = gates.get(`${c.req.param("viewer")}/${c.req.param("subject")}`);
      if (gate) {
        gate.arrived.resolve();
        await withTimeout(gate.release.promise, 5000, `release ${c.req.param("viewer")}`);
      }
      return bufferedMemberText(c, rows.map((row) => row.name).join(" "));
    });
    const request = (viewer: string, subject: string): Promise<Response> =>
      Promise.resolve(app.request(`/${viewer}/${subject}`, {}, env));
    const keyA = `${MEMBER.userId}/${SUBJECT.userId}`;
    const keyB = `${MODERATOR.userId}/${MEMBER.userId}`;

    for (const first of ["b", "a"] as const) {
      await fixture.reset();
      await seed(fixture.db);
      const gateA = { arrived: deferred(), release: deferred() };
      const gateB = { arrived: deferred(), release: deferred() };
      gates.set(keyA, gateA);
      gates.set(keyB, gateB);
      let settledA = false;
      let settledB = false;
      const promiseA = request(MEMBER.userId, SUBJECT.userId);
      const promiseB = request(MODERATOR.userId, MEMBER.userId);
      promiseA.then(
        () => {
          settledA = true;
        },
        () => {
          settledA = true;
        },
      );
      promiseB.then(
        () => {
          settledB = true;
        },
        () => {
          settledB = true;
        },
      );
      try {
        // Both sensitive reads completed and both handlers are parked:
        // neither buffered response has been released yet.
        await withTimeout(
          Promise.all([gateA.arrived.promise, gateB.arrived.promise]),
          5000,
          `rendezvous (first=${first})`,
        );
        expect(settledA, `A must stay parked until release (first=${first})`).toBe(false);
        expect(settledB, `B must stay parked until release (first=${first})`).toBe(false);
        if (first === "b") {
          gateB.release.resolve();
          const resB = await withTimeout(promiseB, 5000, `B response (first=${first})`);
          expect(resB.status).toBe(200);
          expect(await resB.text()).toBe(MEMBER.username);
          expect(settledA, `A must stay parked while B completes (first=${first})`).toBe(false);
          gateA.release.resolve();
          const resA = await withTimeout(promiseA, 5000, `A response (first=${first})`);
          expect(resA.status).toBe(200);
          expect(await resA.text()).toBe(SUBJECT.username);
        } else {
          gateA.release.resolve();
          const resA = await withTimeout(promiseA, 5000, `A response (first=${first})`);
          expect(resA.status).toBe(200);
          expect(await resA.text()).toBe(SUBJECT.username);
          expect(settledB, `B must stay parked while A completes (first=${first})`).toBe(false);
          gateB.release.resolve();
          const resB = await withTimeout(promiseB, 5000, `B response (first=${first})`);
          expect(resB.status).toBe(200);
          expect(await resB.text()).toBe(MEMBER.username);
        }
        expect(
          (await logs()).map((row) => [row.viewerDiscordId, row.subjectUserIds]).sort(),
        ).toEqual(
          [
            [MEMBER.userId, [SUBJECT.userId]],
            [MODERATOR.userId, [MEMBER.userId]],
          ].sort(),
        );
        // No leftover receipt: an explicit self read and an empty read each
        // serve without writing another audit row.
        expect((await request(MEMBER.userId, MEMBER.userId)).status).toBe(200);
        expect(await logs()).toHaveLength(2);
        expect((await request(MEMBER.userId, "999999999999999999")).status).toBe(200);
        expect(await logs()).toHaveLength(2);
      } finally {
        gateA.release.resolve();
        gateB.release.resolve();
        await Promise.allSettled([promiseA, promiseB]);
        gates.clear();
      }
    }
  }, 15000);

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

describe("caught member-read boundary failures", () => {
  beforeEach(() => __resetAlertRateLimitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("alerts once for a directly caught MemberReadRefused and preserves the plain 503", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono();
    app.use("*", requestLog);
    app.use("/direct/*", (c) =>
      memberReadBoundary(
        c,
        { ...declaration, viewer: null },
        async () => true,
        async () => {
          throw new MemberReadRefused();
        },
      ),
    );
    app.get("/direct/:key", (c) => c.text("should not run"));

    const response = await app.request("/direct/private-key", {}, env);
    const requestId = response.headers.get("x-request-id");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Member data is temporarily unavailable.");
    const alerts = error.mock.calls
      .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
      .filter((line) => line?.event === "error.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      event: "error.alert",
      exception: "MemberReadRefused",
      method: "GET",
      request_id: requestId,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-key");
  });

  it("alerts once when the member-read audit write throws and preserves the plain 503", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono();
    app.use("*", requestLog);
    app.use("/audit/*", (c) =>
      memberReadBoundary(
        c,
        { ...declaration, viewer: MEMBER.userId },
        async () => {
          throw new TypeError("private audit failure");
        },
        async () => {
          declareMemberResult([SUBJECT.userId]);
          bufferedMemberText(c, "private member data");
        },
      ),
    );
    app.get("/audit/:key", (c) => c.text("should not run"));

    const response = await app.request("/audit/private-key", {}, env);
    const requestId = response.headers.get("x-request-id");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Member data is temporarily unavailable.");
    const alerts = error.mock.calls
      .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
      .filter((line) => line?.event === "error.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      event: "error.alert",
      exception: "TypeError",
      method: "GET",
      route: "/audit/:key",
      request_id: requestId,
    });
    expect(error).toHaveBeenCalledWith("Member read audit failed; refusing contents.", {
      exception: "TypeError",
      request_id: requestId,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("private");
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
