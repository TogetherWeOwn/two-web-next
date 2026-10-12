import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { recordAccess } from "../src/admin/store";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import { observeMemberReads } from "../src/db/member-reads";
import { users } from "../src/db/schema";
import { keyedMemberRead, memberReadResponse } from "../src/member-reads";
import { MEMBER, MODERATOR, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const meta = { method: "GET", route: "test.kit-member-page" };
const declaration = (viewer: string) => ({
  resource: "member",
  action: "list" as const,
  route: "test.kit-handler",
  viewer,
});

describe.skipIf(!process.env.DATABASE_URL)("Kit member-read boundary (real Postgres)", () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
    return fixture?.reset();
  });
  afterAll(() => fixture?.dispose());

  const page = (connection: typeof fixture.db) => async () => {
    const rows = await keyedMemberRead(() =>
      connection.select({ id: users.id, name: users.username }).from(users),
    );
    return new Response(rows.map((row) => row.name).join(" "));
  };

  it("a real Kit render audits the actual user keys, excludes the viewer, and writes one row", async () => {
    const connection = observeMemberReads(fixture.db);
    const res = await memberReadResponse(
      meta,
      declaration(MEMBER.userId),
      (entry) => recordAccess(fixture.db, entry),
      page(connection),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain(SUBJECT.username);
    expect(await logs()).toMatchObject([
      {
        viewerDiscordId: MEMBER.userId,
        viewerUserId: MEMBER.userId,
        subjectUserIds: [MODERATOR.userId, SUBJECT.userId, "100000000000000104"].sort(),
        subjectCount: 3,
        resource: "member",
        action: "list",
        route: "test.kit-handler",
      },
    ]);
  });

  it("a REAL failed audit INSERT refuses the Kit render and emits no bindings", async () => {
    const rollback = new Error("rollback failed INSERT fixture");
    await fixture.db
      .transaction(async (tx) => {
        await tx.execute(sql`alter table member_data_access_logs drop column subject_count`);
        const connection = observeMemberReads(tx as unknown as typeof fixture.db);
        const res = await memberReadResponse(
          meta,
          declaration(MEMBER.userId),
          (entry) => recordAccess(tx as unknown as typeof fixture.db, entry),
          page(connection),
        );
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const body = await res.text();
        expect(body).not.toContain(SUBJECT.username);
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

  it("an undeclared query inside a Kit render is refused before any row is written", async () => {
    const connection = observeMemberReads(fixture.db);
    const res = await memberReadResponse(
      meta,
      declaration(MEMBER.userId),
      (entry) => recordAccess(fixture.db, entry),
      async () => {
        const rows = await connection.select({ id: users.id, name: users.username }).from(users);
        return new Response(rows.map((row) => row.name).join(" "));
      },
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    for (const value of [...PERSONAL_STRINGS, SUBJECT.username]) expect(body).not.toContain(value);
    expect(await logs()).toHaveLength(0);
  });

  it("concurrent real Kit renders keep separate viewers and subject sets", async () => {
    const connection = observeMemberReads(fixture.db);
    const [first, second] = await Promise.all([
      memberReadResponse(
        meta,
        declaration(MEMBER.userId),
        (entry) => recordAccess(fixture.db, entry),
        page(connection),
      ),
      memberReadResponse(
        meta,
        declaration(MODERATOR.userId),
        (entry) => recordAccess(fixture.db, entry),
        page(connection),
      ),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await logs();
    expect(rows.map((row) => row.viewerDiscordId).sort()).toEqual(
      [MEMBER.userId, MODERATOR.userId].sort(),
    );
    for (const row of rows) {
      expect(row.subjectUserIds).not.toContain(row.viewerDiscordId);
      expect(row.subjectUserIds).toContain(SUBJECT.userId);
    }
  });
});
