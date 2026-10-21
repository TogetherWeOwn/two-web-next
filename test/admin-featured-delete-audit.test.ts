// Featured delete audit: full slot snapshot through the admin route (roadmap
// acceptance, route level). POST /featured/:id/delete must leave the same
// full-snapshot audit as the store delete; a second delete and a missing-row
// delete answer 404 and audit nothing. Response and redirect behavior are
// unchanged.
//
// FAIL-FIRST: the snapshot test below is RED until the delete audit carries
// the full snapshot. The 404-silence tests pin unchanged behavior and pass
// both before and after.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { EnvWithAdminDb } from "../src/admin/db";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const STARTS_AT_TEXT = "2026-10-08 18:00:00.000000";
const ENDS_AT_TEXT = "2026-10-09 18:00:00.000000";

const FULL_SLOT = {
  title: "Routed headline",
  body: "Routed body",
  url: "https://example.test/routed",
  imageUrl: "/images/routed.png",
  imageAlt: "Routed alt text",
  isPublished: true,
  position: 4,
  startsAt: new Date("2026-10-08T18:00:00.000Z"),
  endsAt: new Date("2026-10-09T18:00:00.000Z"),
} as const;

type AuditProps = Record<string, { before: unknown; after: unknown }>;

function expectSnapshotField(props: AuditProps, key: string, expectedBefore: unknown) {
  const entry = props[key];
  if (expectedBefore === null) {
    if (entry === undefined) return;
    expect(entry, key).toEqual({ before: null, after: null });
    return;
  }
  expect(entry, key).toEqual({ before: expectedBefore, after: null });
}

describe.skipIf(!process.env.DATABASE_URL)("admin featured delete audit (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions: SessionStore;
  let modCookie = "";
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
  const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
  const del = (id: number | string) =>
    admin().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie: modCookie, origin: env.APP_URL } },
      bindings(),
    );

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    sessions = createMemorySessionStore();
    modCookie = await cookieFor(sessions, MODERATOR);
  });
  afterAll(() => fixture?.dispose());

  it("route delete audits the full slot snapshot with after:null, envelope unchanged", async () => {
    const [seeded] = await fixture.db
      .insert(featuredContents)
      .values({ ...FULL_SLOT })
      .returning();
    const id = seeded!.id;

    const res = await del(id);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/featured");
    expect(await fixture.db.select().from(featuredContents)).toHaveLength(0);

    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      logName: "default",
      subjectType: "FeaturedContent",
      subjectId: String(id),
      causerId: MODERATOR.userId,
      description: "deleted featured content Routed headline",
    });
    const props = audits[0]!.properties as AuditProps;
    expectSnapshotField(props, "title", FULL_SLOT.title);
    expectSnapshotField(props, "body", FULL_SLOT.body);
    expectSnapshotField(props, "url", FULL_SLOT.url);
    expectSnapshotField(props, "imageUrl", FULL_SLOT.imageUrl);
    expectSnapshotField(props, "imageAlt", FULL_SLOT.imageAlt);
    expectSnapshotField(props, "isPublished", FULL_SLOT.isPublished);
    expectSnapshotField(props, "position", FULL_SLOT.position);
    expectSnapshotField(props, "startsAt", STARTS_AT_TEXT);
    expectSnapshotField(props, "endsAt", ENDS_AT_TEXT);
  });

  it("route second delete 404s and audits nothing", async () => {
    const [seeded] = await fixture.db
      .insert(featuredContents)
      .values({ title: "Routed headline", position: 1 })
      .returning();
    const id = seeded!.id;

    const first = await del(id);
    expect(first.status).toBe(303);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);

    const second = await del(id);
    expect(second.status).toBe(404);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
  });

  it("route delete of a missing row 404s and audits nothing", async () => {
    const res = await del(424242);
    expect(res.status).toBe(404);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(0);
  });
});
