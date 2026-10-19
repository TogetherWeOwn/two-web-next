import { eq, sql } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import * as reads from "../src/admin/reads";
import * as store from "../src/admin/store";
import { featuredContents, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { joinAttempts, users } from "../src/db/schema";
import * as memberReads from "../src/member-reads";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { notFoundResponse } from "../src/errors";
import { createMemorySessionStore } from "../src/sessions";
import {
  cookieFor,
  env,
  EVENT_KEY,
  MEMBER,
  MODERATOR,
  PERSONAL_STRINGS,
  seed,
  SUBJECT,
} from "./helpers/member-data";
import { assertDenialThrows } from "./helpers/assert-denial";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Every injection below runs through an EXISTING mounted admin handler. The
// real adapter, owner columns and INSERT are used, not fabricated audit rows.
describe.skipIf(!process.env.DATABASE_URL)(
  "mounted keyed admin reads (isolated real Postgres)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    let cookie: string;
    const logs = () => fixture.db.select().from(memberDataAccessLogs);
    const request = (path: string, db: Db = fixture.db) =>
      app.request(
        `/admin${path === "/" ? "" : path}`,
        { headers: { cookie } },
        {
          ...env,
          ADMIN_DB: db,
          SESSION_STORE: sessions,
          MEMBER_ACCESS_LOG_ENFORCE: "false",
        },
      );
    const denial = async (response: Response, checkRows = true) => {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.text();
      for (const token of [
        ...PERSONAL_STRINGS,
        SUBJECT.userId,
        MODERATOR.userId,
        "w15-request",
        "select",
        "subject_count",
      ])
        expect(body).not.toContain(token);
      if (checkRows) expect(await logs()).toHaveLength(0);
    };
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      sessions = createMemorySessionStore();
      cookie = await cookieFor(sessions, MODERATOR);
      __resetAlertRateLimitForTests();
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.db.delete(featuredContents);
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it.each(["roster", "dashboard"])(
      "refuses an added unwrapped sensitive query in the existing %s handler",
      async (surface) => {
        let sabotage: unknown;
        if (surface === "roster") {
          const original = reads.listRoster;
          vi.spyOn(reads, "listRoster").mockImplementationOnce(async (db, key) => {
            const rows = await original(db, key);
            try {
              await db.select().from(users);
            } catch (error) {
              sabotage = error;
            }
            return rows;
          });
        } else {
          const original = reads.joinFunnelStats;
          vi.spyOn(reads, "joinFunnelStats").mockImplementationOnce(async (db, now) => {
            const counts = await original(db, now);
            try {
              await db.select().from(users);
            } catch (error) {
              sabotage = error;
            }
            return counts;
          });
        }
        await denial(await request(surface === "roster" ? `/events/${EVENT_KEY}` : "/"));
        await assertDenialThrows(Promise.reject(sabotage));
      },
    );

    it.each(["comment", "mutation", "builder"])(
      "a %s statement cannot evade the read prefix inside an existing roster handler",
      async (mode) => {
        let sabotage: unknown;
        const original = reads.listRoster;
        vi.spyOn(reads, "listRoster").mockImplementationOnce(async (db, key) => {
          const rows = await original(db, key);
          try {
            await memberReads.keyedMemberRead<unknown>(() =>
              mode === "builder"
                ? db.update(users).set({ username: "mutated-private-name" }).returning()
                : db.execute(
                    mode === "comment"
                      ? sql`/* added query */ select id, username from users`
                      : sql`update users set username = 'mutated-private-name' returning id, username`,
                  ),
            );
          } catch (error) {
            sabotage = error;
          }
          return rows;
        });
        await denial(await request(`/events/${EVENT_KEY}`));
        await assertDenialThrows(Promise.reject(sabotage));
        expect(
          (await fixture.db.select().from(users).where(eq(users.id, SUBJECT.userId)))[0]!.username,
        ).toBe(SUBJECT.username);
      },
    );

    it.each([
      "events",
      "featured",
      "join-funnel",
      "going-counts",
      "roster-count",
      "search-widget",
      "timeouts",
    ] as const)(
      "%s classification cannot authorize a sensitive projection",
      async (classification) => {
        let sabotage: unknown;
        const original = reads.listRoster;
        vi.spyOn(reads, "listRoster").mockImplementationOnce(async (db, key) => {
          const rows = await original(db, key);
          try {
            await memberReads.nonSensitiveRead(classification, () => db.select().from(users));
          } catch (error) {
            sabotage = error;
          }
          return rows;
        });
        await denial(await request(`/events/${EVENT_KEY}`));
        await assertDenialThrows(Promise.reject(sabotage));
      },
    );

    it("mounted join list/detail retain pre-identity rows while auditing the actual members only", async () => {
      const [attempt] = await fixture.db
        .insert(joinAttempts)
        .values({ discordId: null, requestId: "pre-identity-trace", outcome: "denied" })
        .returning();
      for (const path of ["/join-attempts", `/join-attempts/${attempt!.id}`]) {
        const response = await request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.text()).toContain("pre-identity-trace");
      }
      expect(await logs()).toMatchObject([
        { subjectUserIds: [SUBJECT.userId], subjectCount: 1, route: "admin.join-attempts.index" },
      ]);
      expect(await logs()).toHaveLength(1);
    });

    it("mixed null/member rows still refuse contents when the real audit insert fails", async () => {
      await fixture.db
        .insert(joinAttempts)
        .values({ discordId: null, requestId: "pre-identity-trace", outcome: "denied" });
      await fixture.db.execute(
        sql`ALTER TABLE member_data_access_logs RENAME TO unavailable_access_logs`,
      );
      try {
        const response = await request("/join-attempts");
        const body = await response.clone().text();
        await denial(response, false);
        expect(body).not.toContain("pre-identity-trace");
      } finally {
        await fixture.db.execute(
          sql`ALTER TABLE unavailable_access_logs RENAME TO member_data_access_logs`,
        );
      }
      expect(await logs()).toEqual([]);
    });

    it.each(["", "invalid-owner", "123"])(
      "join list/detail refuse malformed non-null owner %s instead of dropping its subject",
      async (discordId) => {
        const [attempt] = await fixture.db
          .insert(joinAttempts)
          .values({ discordId, requestId: "unattributable-request", outcome: "denied" })
          .returning();
        for (const path of ["/join-attempts", `/join-attempts/${attempt!.id}`])
          await denial(await request(path));
      },
    );

    it("join detail attributes departed members without a current users row or extra lookup", async () => {
      await fixture.db.delete(users).where(eq(users.id, SUBJECT.userId));
      const [attempt] = await fixture.db.select().from(joinAttempts);
      const response = await request(`/join-attempts/${attempt!.id}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(SUBJECT.userId);
      expect(await logs()).toMatchObject([
        {
          viewerDiscordId: MODERATOR.userId,
          viewerUserId: MODERATOR.userId,
          subjectUserIds: [SUBJECT.userId],
          subjectCount: 1,
          route: "admin.join-attempts.show",
        },
      ]);
    });

    it("explicit event/content/funnel classifications serve buffers without resource-id subjects", async () => {
      const [featured] = await fixture.db
        .insert(featuredContents)
        .values({ title: "Public editorial card" })
        .returning();
      for (const path of [
        "/",
        "/events",
        "/events?fill=has_seats",
        "/events/new",
        "/featured",
        "/featured/new",
        `/featured/${featured!.id}`,
      ]) {
        const response = await request(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
      expect(await logs()).toHaveLength(0);
    });

    it.each([true, false])(
      "saved featured preview stays buffered and classified without resource-id subjects (published: %s)",
      async (published) => {
        const [featured] = await fixture.db
          .insert(featuredContents)
          .values({
            title: "Saved public preview",
            body: "Saved editorial body",
            isPublished: published,
            imageUrl: "https://cdn.discordapp.com/preview.png",
          })
          .returning();
        const response = await request(`/featured/${featured!.id}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).toContain('data-testid="featured-preview"');
        expect(body).toContain("Last saved content");
        if (published) {
          expect(body).toContain('data-testid="featured-item"');
          expect(body).toContain('src="https://cdn.discordapp.com/preview.png"');
          expect(body).not.toContain('data-testid="featured-preview-hidden"');
        } else {
          expect(body).toContain('data-testid="featured-preview-hidden"');
          expect(body).not.toContain('data-testid="featured-item"');
        }
        expect(await logs()).toHaveLength(0);
      },
    );

    it.each(["literal", "member"])(
      "precision classification cannot authorize an added %s SQL projection in the existing featured handler",
      async (mode) => {
        let sabotage: unknown;
        const [featured] = await fixture.db
          .insert(featuredContents)
          .values({ title: "Public editorial card" })
          .returning();
        const original = store.getFeatured;
        vi.spyOn(store, "getFeatured").mockImplementationOnce(async (db, id) => {
          const row = await original(db, id);
          try {
            await memberReads.nonSensitiveRead("featured", () =>
              db
                .select({
                  id: featuredContents.id,
                  text:
                    mode === "member"
                      ? sql<string>`(select username from users limit 1)`
                      : sql<string>`'unreviewed expression'`,
                })
                .from(featuredContents)
                .where(eq(featuredContents.id, id)),
            );
          } catch (error) {
            sabotage = error;
          }
          return row;
        });
        await denial(await request(`/featured/${featured!.id}`));
        await assertDenialThrows(Promise.reject(sabotage));
      },
    );

    it.each(["self", "empty"])("explicit %s roster has no subject row", async (mode) => {
      if (mode === "self") await fixture.db.update(rsvps).set({ userId: MODERATOR.userId });
      else await fixture.db.delete(rsvps);
      const response = await request(`/events/${EVENT_KEY}`);
      expect(response.status).toBe(200);
      expect(await logs()).toHaveLength(0);
    });

    it.each(["/events/invalid", "/join-attempts/0", "/featured/not-an-id"])(
      "%s remains a buffered 404 with no subject row",
      async (path) => {
        expect((await request(path)).status).toBe(404);
        expect(await logs()).toHaveLength(0);
      },
    );

    it.each(["/", `/events/${EVENT_KEY}`])(
      "refuses an undeclared/declared stream replacement on %s before producer pull",
      async (path) => {
        let pulls = 0;
        vi.spyOn(memberReads, "bufferedMemberHtml").mockImplementationOnce(async (c) => {
          c.res = new Response(
            new ReadableStream(
              {
                pull(controller) {
                  pulls++;
                  controller.enqueue(new TextEncoder().encode(PERSONAL_STRINGS[1]));
                },
              },
              { highWaterMark: 0 },
            ),
          );
          return c.res;
        });
        await denial(await request(path));
        expect(pulls).toBe(0);
      },
    );

    it("a controlled not-found shell cannot erase a prior unwrapped sensitive read", async () => {
      let sabotage: unknown;
      const original = reads.listRoster;
      vi.spyOn(reads, "listRoster").mockImplementationOnce(async (db, key) => {
        const rows = await original(db, key);
        try {
          await db.select().from(users);
        } catch (error) {
          sabotage = error;
        }
        return rows;
      });
      vi.spyOn(memberReads, "bufferedMemberHtml").mockImplementationOnce(async (c) =>
        notFoundResponse(c),
      );
      await denial(await request(`/events/${EVENT_KEY}`));
      await assertDenialThrows(Promise.reject(sabotage));
    });

    it("an arbitrary 404 replacement cannot inherit buffered approval", async () => {
      vi.spyOn(memberReads, "bufferedMemberHtml").mockImplementationOnce(async (c) => {
        c.res = new Response(PERSONAL_STRINGS[1], { status: 404 });
        return c.res;
      });
      await denial(await request(`/events/${EVENT_KEY}`));
    });

    it("a REAL failed roster audit INSERT still refuses contents with enforcement flag off", async () => {
      const rollback = new Error("rollback admin failed INSERT");
      await fixture.db
        .transaction(async (tx) => {
          await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
          await denial(await request(`/events/${EVENT_KEY}`, tx as unknown as Db), false);
          const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
          expect(diagnostics).toContain("DrizzleQueryError");
          for (const token of [
            ...PERSONAL_STRINGS,
            SUBJECT.userId,
            MODERATOR.userId,
            "insert into",
            "subject_count",
          ])
            expect(diagnostics).not.toContain(token);
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      expect(await logs()).toHaveLength(0);
    });

    it.each([
      [`/e/${EVENT_KEY}`, "added"],
      [`/e/${EVENT_KEY}`, "already_member"],
      [`/members/${SUBJECT.userId}`, "added"],
      [`/members/${SUBJECT.userId}`, "already_member"],
    ])(
      "%s preserves %s after a REAL failed audit INSERT until one visible response",
      async (path, result) => {
        const flash = (
          await serializeSigned(JOIN_RESULT_COOKIE, result, env.SESSION_SECRET, {
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          })
        ).split(";")[0]!;
        const jar = new Map(
          [cookie, flash].map((pair) => [pair.slice(0, pair.indexOf("=")), pair]),
        );
        const get = (db: Db = fixture.db) =>
          app.request(
            path,
            { headers: { cookie: [...jar.values()].join("; ") } },
            {
              ...env,
              ADMIN_DB: db,
              SESSION_STORE: sessions,
            },
          );
        const apply = (response: Response) => {
          for (const value of response.headers.getSetCookie()) {
            const pair = value.split(";")[0]!;
            const name = pair.slice(0, pair.indexOf("="));
            if (/max-age=0/i.test(value)) jar.delete(name);
            else jar.set(name, pair);
          }
        };
        const rollback = new Error("rollback join-result failed INSERT");
        await fixture.db
          .transaction(async (tx) => {
            await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
            const refused = await get(tx as unknown as Db);
            await denial(refused, false);
            apply(refused);
            expect(jar.get(JOIN_RESULT_COOKIE)).toBe(flash);
            throw rollback;
          })
          .catch((error: unknown) => {
            if (error !== rollback) throw error;
          });
        expect(await logs()).toHaveLength(0);
        const allowed = await get();
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("cache-control")).toBe("private, no-store");
        expect(await allowed.text()).toContain('data-testid="join-result"');
        expect(await logs()).toMatchObject([
          { viewerDiscordId: MODERATOR.userId, subjectUserIds: [SUBJECT.userId], subjectCount: 1 },
        ]);
        apply(allowed);
        expect(jar.has(JOIN_RESULT_COOKIE)).toBe(false);
        const second = await get();
        expect(second.status).toBe(200);
        expect(await second.text()).not.toContain('data-testid="join-result"');
        expect(await logs()).toHaveLength(2);
      },
    );

    it.each([`/admin/events/${EVENT_KEY}`, `/members/${SUBJECT.userId}`])(
      "HEAD captures actual subjects on %s, even with an empty response body",
      async (path) => {
        const response = await app.request(
          path,
          { method: "HEAD", headers: { cookie } },
          {
            ...env,
            ADMIN_DB: fixture.db,
            SESSION_STORE: sessions,
          },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
        expect(await logs()).toMatchObject([
          { viewerDiscordId: MODERATOR.userId, subjectUserIds: [SUBJECT.userId], subjectCount: 1 },
        ]);
      },
    );

    it.each([`/admin/events/${EVENT_KEY}`, `/members/${SUBJECT.userId}`])(
      "HEAD refuses %s when the real audit INSERT fails",
      async (path) => {
        const rollback = new Error("rollback HEAD failed INSERT");
        await fixture.db
          .transaction(async (tx) => {
            await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
            const response = await app.request(
              path,
              { method: "HEAD", headers: { cookie } },
              {
                ...env,
                ADMIN_DB: tx as unknown as Db,
                SESSION_STORE: sessions,
              },
            );
            expect(response.status).toBe(503);
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            expect(await response.text()).toBe("");
            throw rollback;
          })
          .catch((error: unknown) => {
            if (error !== rollback) throw error;
          });
        expect(await logs()).toHaveLength(0);
      },
    );

    it("a REAL failed admin SELECT sanitizes diagnostics before the global handler", async () => {
      const rollback = new Error("rollback admin failed SELECT");
      await fixture.db
        .transaction(async (tx) => {
          await tx.execute(sql`alter table join_attempts drop column request_id`);
          await denial(
            await request(`/join-attempts?q=${SUBJECT.userId}`, tx as unknown as Db),
            false,
          );
          const calls = vi.mocked(console.error).mock.calls;
          const alerts = calls
            .map(([line]) =>
              typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null,
            )
            .filter((line) => line?.event === "error.alert");
          expect(alerts).toHaveLength(1);
          expect(alerts[0]).toMatchObject({
            event: "error.alert",
            exception: "DrizzleQueryError",
            method: "GET",
          });
          expect(alerts[0].request_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
          expect(console.error).toHaveBeenCalledWith("Member request failed; refusing contents.", {
            exception: "DrizzleQueryError",
            request_id: alerts[0].request_id,
          });
          const diagnostics = JSON.stringify(calls);
          expect(diagnostics).toContain("DrizzleQueryError");
          // "request_id" appears as the validated correlation-ID key above; the
          // dropped-column SQL/message must not leak around it.
          for (const token of [
            ...PERSONAL_STRINGS,
            SUBJECT.userId,
            MODERATOR.userId,
            "select",
            "params:",
            "column",
            "does not exist",
            "of relation",
            "join_attempts",
            "alter table",
            "drop column",
          ])
            expect(diagnostics).not.toContain(token);
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      expect(await logs()).toHaveLength(0);
    });

    it.each(["/admin/does-not-exist", "/members/does/not/exist"])(
      "%s keeps a controlled branded 404",
      async (path) => {
        const response = await app.request(
          path,
          { headers: { cookie } },
          {
            ...env,
            ADMIN_DB: fixture.db,
            SESSION_STORE: sessions,
          },
        );
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.text()).toContain("We cannot find that page");
        expect(await logs()).toHaveLength(0);
      },
    );

    it("forced-overlap roster/join reads rendezvous after distinct sensitive reads", async () => {
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

      for (const first of ["join", "roster"] as const) {
        await fixture.reset();
        await seed(fixture.db);
        const memberCookie = await cookieFor(sessions, { ...MEMBER, moderator: true });
        const bindings = { ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions };
        const gateRoster = { arrived: deferred(), release: deferred() };
        const gateJoin = { arrived: deferred(), release: deferred() };
        // Park each handler after its distinct sensitive read, while its
        // capture is still open and before its buffered response releases.
        const originalRoster = reads.listRoster;
        const originalJoin = reads.listJoinAttempts;
        const rosterSpy = vi
          .spyOn(reads, "listRoster")
          .mockImplementationOnce(async (...args: Parameters<typeof originalRoster>) => {
            const result = await originalRoster(...args);
            gateRoster.arrived.resolve();
            await withTimeout(gateRoster.release.promise, 5000, "release roster");
            return result;
          });
        const joinSpy = vi
          .spyOn(reads, "listJoinAttempts")
          .mockImplementationOnce(async (...args: Parameters<typeof originalJoin>) => {
            const result = await originalJoin(...args);
            gateJoin.arrived.resolve();
            await withTimeout(gateJoin.release.promise, 5000, "release join");
            return result;
          });
        let settledRoster = false;
        let settledJoin = false;
        const promiseRoster: Promise<Response> = Promise.resolve(
          app.request(`/admin/events/${EVENT_KEY}`, { headers: { cookie } }, bindings),
        );
        const promiseJoin: Promise<Response> = Promise.resolve(
          app.request("/admin/join-attempts", { headers: { cookie: memberCookie } }, bindings),
        );
        promiseRoster.then(
          () => {
            settledRoster = true;
          },
          () => {
            settledRoster = true;
          },
        );
        promiseJoin.then(
          () => {
            settledJoin = true;
          },
          () => {
            settledJoin = true;
          },
        );
        try {
          // Both sensitive reads completed and both handlers are parked:
          // neither buffered response has been released yet.
          await withTimeout(
            Promise.all([gateRoster.arrived.promise, gateJoin.arrived.promise]),
            5000,
            `rendezvous (first=${first})`,
          );
          expect(settledRoster, `roster must stay parked until release (first=${first})`).toBe(
            false,
          );
          expect(settledJoin, `join must stay parked until release (first=${first})`).toBe(false);
          if (first === "join") {
            gateJoin.release.resolve();
            const resJoin = await withTimeout(promiseJoin, 5000, `join response (first=${first})`);
            expect(resJoin.status).toBe(200);
            const joinBody = await resJoin.text();
            expect(joinBody).toContain("w15-request");
            expect(joinBody).toContain(SUBJECT.userId);
            expect(
              settledRoster,
              `roster must stay parked while join completes (first=${first})`,
            ).toBe(false);
            gateRoster.release.resolve();
            const resRoster = await withTimeout(
              promiseRoster,
              5000,
              `roster response (first=${first})`,
            );
            expect(resRoster.status).toBe(200);
            expect(await resRoster.text()).toContain(SUBJECT.username);
          } else {
            gateRoster.release.resolve();
            const resRoster = await withTimeout(
              promiseRoster,
              5000,
              `roster response (first=${first})`,
            );
            expect(resRoster.status).toBe(200);
            expect(await resRoster.text()).toContain(SUBJECT.username);
            expect(
              settledJoin,
              `join must stay parked while roster completes (first=${first})`,
            ).toBe(false);
            gateJoin.release.resolve();
            const resJoin = await withTimeout(promiseJoin, 5000, `join response (first=${first})`);
            expect(resJoin.status).toBe(200);
            const joinBody = await resJoin.text();
            expect(joinBody).toContain("w15-request");
            expect(joinBody).toContain(SUBJECT.userId);
          }
          expect(
            (await logs())
              .map((row) => [row.viewerDiscordId, row.route, row.subjectUserIds])
              .sort(),
          ).toEqual(
            [
              [MODERATOR.userId, "admin.events.edit", [SUBJECT.userId]],
              [MEMBER.userId, "admin.join-attempts.index", [SUBJECT.userId]],
            ].sort(),
          );
          // No leftover receipt: sequential empty screens serve without
          // writing another audit row.
          for (const path of ["/", "/events/new", "/featured/new"])
            expect((await request(path)).status, `${path} (first=${first})`).toBe(200);
          expect(await logs()).toHaveLength(2);
        } finally {
          gateRoster.release.resolve();
          gateJoin.release.resolve();
          await Promise.allSettled([promiseRoster, promiseJoin]);
          rosterSpy.mockRestore();
          joinSpy.mockRestore();
        }
      }
    }, 15000);
  },
);
