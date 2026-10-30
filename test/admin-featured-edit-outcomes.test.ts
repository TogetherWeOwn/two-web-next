// Featured edit/delete outcomes: the Hono POST /admin/featured/:id and
// POST /admin/featured/:id/delete controllers stay the single write
// authorities while the Kit GET /admin/featured/:id form migrates. These pins
// prove valid edits 303, invalid image/window/headline 422s with preserved
// values, delete 303s, missing/stale IDs 404, the legacy-id alias mapping
// with query dropped, no-JS plain-POST behavior, guard denial and the
// error visuals all survive the slice with server validation unchanged
// (parseFeaturedForm + updateFeatured/deleteFeatured, transactional + audited).
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { featuredBaselineFields } from "./helpers/featured-baseline";
import { clearAuditRows } from "./helpers/audit-rows";
import { events } from "../src/db/admin-schema";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: ReturnType<typeof createMemorySessionStore>,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const PLEB = { userId: "222", username: "pleb", moderator: false };

describe("featured edit/delete guard pins (memory store, no DB)", () => {
  it("bounces guests from the edit form into Discord OAuth", async () => {
    const res = await adminApp(createMemorySessionStore()).request("/featured/7", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
  });

  it("403s a signed-in non-moderator on edit reads and both write POSTs", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, PLEB);
    const headers = { cookie };
    expect(await app.request("/featured/7", { headers }, env)).toMatchObject({ status: 403 });
    const writeHeaders = {
      cookie,
      origin: APP_URL,
      "content-type": "application/x-www-form-urlencoded",
    };
    expect(
      await app.request(
        "/featured/7",
        { method: "POST", headers: writeHeaders, body: new URLSearchParams({ title: "x" }) },
        env,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await app.request("/featured/7/delete", { method: "POST", headers: writeHeaders }, env),
    ).toMatchObject({ status: 403 });
  });

  it("answers the shared 503 outage envelope on the edit form with no database", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request("/featured/7", { headers: { cookie } }, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Admin temporarily unavailable");
  });

  it("keeps the legacy edit alias as a guarded 301 that drops the query", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const guest = await app.request(
      "/featured-contents/7/edit?next=%2Fevents&filter=drop",
      {},
      env,
    );
    expect(guest.status).toBe(302);
    const cookie = await cookieFor(store, MOD);
    const res = await app.request(
      "/featured-contents/7/edit?next=%2Fevents&filter=drop",
      { headers: { cookie } },
      env,
    );
    // Without a database the alias cannot resolve: the shared 503 outage.
    expect(res.status).toBe(503);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("featured edit/delete outcomes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore(() => Date.now());
  const modId = "100000000000000111";
  let cookie = "";
  const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
  const app = () => adminApp({ sessionStore: store, db });
  const form = (fields: Record<string, string>) => ({
    method: "POST" as const,
    headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const seed = (fields: Record<string, unknown> = {}) =>
    db
      .insert(featuredContents)
      .values({
        title: "Original slot",
        body: "Original body",
        url: null,
        imageUrl: null,
        imageAlt: null,
        isPublished: false,
        position: 4,
        startsAt: null,
        endsAt: null,
        ...fields,
      })
      .returning();

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(() => fixture?.dispose());

  beforeEach(async () => {
    await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
    await db.delete(events);
    await db.delete(featuredContents);
    cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
  });

  it("applies a valid edit with a 303 back to the edit page", async () => {
    const [seeded] = await seed();
    const id = seeded!.id;
    const res = await app().request(
      `/featured/${id}`,
      form({
        ...(await featuredBaselineFields(db, id)),
        title: "Renamed slot",
        body: "Kept body",
        position: "1",
        is_published: "on",
      }),
      liveEnv(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/featured/${id}`);
    const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row).toMatchObject({ title: "Renamed slot", position: 1, isPublished: true });
  });

  it("422s a disallowed edit image host with the field error and preserved values", async () => {
    const [seeded] = await seed();
    const id = seeded!.id;
    const res = await app().request(
      `/featured/${id}`,
      form({
        ...(await featuredBaselineFields(db, id)),
        title: "Edited title",
        image_url: "https://evil.test/pic.jpg",
        position: "4",
      }),
      liveEnv(),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('data-testid="form-errors"');
    expect(html).toContain("Image URL must be HTTPS on an approved public host");
    expect(html).toContain("Edited title");
    expect(html).toContain("https://evil.test/pic.jpg");
    const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row?.title).toBe("Original slot");
  });

  it("422s an inverted edit window and a missing edit headline with preserved values", async () => {
    const [seeded] = await seed();
    const id = seeded!.id;
    const flipped = await app().request(
      `/featured/${id}`,
      form({
        ...(await featuredBaselineFields(db, id)),
        title: "Backwards edit",
        position: "4",
        starts_at: "2026-11-04 11:15",
        ends_at: "2026-11-04 09:05",
      }),
      liveEnv(),
    );
    expect(flipped.status).toBe(422);
    expect(await flipped.text()).toContain("The window ends after it starts.");
    const blank = await app().request(
      `/featured/${id}`,
      form({
        ...(await featuredBaselineFields(db, id)),
        title: "",
        body: "Kept draft body",
        position: "4",
      }),
      liveEnv(),
    );
    expect(blank.status).toBe(422);
    const html = await blank.text();
    expect(html).toContain("Give it a headline.");
    expect(html).toContain("Kept draft body");
    const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row?.title).toBe("Original slot");
  });

  it("404s edit and delete for missing IDs and a stale row deleted between reads", async () => {
    const [seeded] = await seed();
    const id = seeded!.id;
    expect(await app().request("/featured/0x1", { headers: { cookie } }, liveEnv())).toMatchObject({
      status: 404,
    });
    expect(
      await app().request("/featured/42424242", { headers: { cookie } }, liveEnv()),
    ).toMatchObject({ status: 404 });
    const del = await app().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie, origin: APP_URL } },
      liveEnv(),
    );
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe("/admin/featured");
    expect(
      await db.select().from(featuredContents).where(eq(featuredContents.id, id)),
    ).toHaveLength(0);
    // Stale repeat: the edit form and both writes 404 once the row is gone.
    expect(
      await app().request(`/featured/${id}`, { headers: { cookie } }, liveEnv()),
    ).toMatchObject({ status: 404 });
    expect(
      await app().request(`/featured/${id}`, form({ title: "Too late", position: "0" }), liveEnv()),
    ).toMatchObject({ status: 404 });
    expect(
      await app().request(
        `/featured/${id}/delete`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      ),
    ).toMatchObject({ status: 404 });
  });

  it("resolves the legacy-id alias to the current ID, drops the query on 301, and 404s unknown aliases", async () => {
    const [nativeRow] = await seed({ title: "Native slot" });
    const [imported] = await seed({ title: "Imported slot", legacyId: "91001" });
    const res = await app().request(
      `/featured-contents/91001/edit?next=%2Fevents&filter=drop`,
      { headers: { cookie } },
      liveEnv(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/admin/featured/${imported!.id}`);
    // The native numeric ID is never an alias: it 404s instead of aliasing.
    expect(
      await app().request(
        `/featured-contents/${nativeRow!.id}/edit`,
        { headers: { cookie } },
        liveEnv(),
      ),
    ).toMatchObject({ status: 404 });
    expect(
      await app().request("/featured-contents/nope/edit", { headers: { cookie } }, liveEnv()),
    ).toMatchObject({ status: 404 });
  });

  it("a repeat delete cannot apply twice: the second POST 404s with no extra audit", async () => {
    const [seeded] = await seed();
    const id = seeded!.id;
    const headers = { cookie, origin: APP_URL };
    expect(
      await app().request(`/featured/${id}/delete`, { method: "POST", headers }, liveEnv()),
    ).toMatchObject({ status: 303 });
    expect(
      await app().request(`/featured/${id}/delete`, { method: "POST", headers }, liveEnv()),
    ).toMatchObject({ status: 404 });
  });
});
