// Featured create outcomes (TOG-22147): the Hono POST /admin/featured
// controller stays the single write authority while the Kit GET
// /admin/featured/new form migrates. These pins prove the exact HTTPS
// image-host policy, window rules, preserved-values 422s, no-JS 303s,
// moderator denial and the guarded legacy 301 all survive the slice with
// server validation unchanged (parseFeaturedForm + createFeatured).
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
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

describe("featured create guard pins (memory store, no DB)", () => {
  it("bounces guests from the new form into Discord OAuth", async () => {
    const res = await adminApp(createMemorySessionStore()).request("/featured/new", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
  });

  it("403s a signed-in non-moderator on the new form and the create POST", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, PLEB);
    const headers = { cookie };
    expect(await app.request("/featured/new", { headers }, env)).toMatchObject({ status: 403 });
    expect(await app.request("/featured", { method: "POST", headers }, env)).toMatchObject({
      status: 403,
    });
  });

  it("serves the Hono new form to a moderator with the create action", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request("/featured/new", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/featured"');
    expect(html).toContain('data-testid="save-featured"');
  });

  it("keeps the legacy create alias as a guarded 301 to the new form", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const guest = await app.request("/featured-contents/create", {}, env);
    expect(guest.status).toBe(302);
    const cookie = await cookieFor(store, MOD);
    const res = await app.request("/featured-contents/create", { headers: { cookie } }, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin/featured/new");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("featured create outcomes (agent-testdb)", () => {
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

  it("creates with an allowed HTTPS image host and 303s to the edit page with values preserved", async () => {
    const fields = {
      title: "Game night",
      body: "Bring a friend",
      url: "https://example.test/games",
      image_url: "https://cdn.discordapp.com/attachments/board.jpg",
      image_alt: "A chess board ready for play",
      is_published: "on",
      position: "2",
      starts_at: "2026-11-04 09:05",
      ends_at: "2026-11-04 11:15",
    };
    const res = await app().request("/featured", form(fields), liveEnv());
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/admin\/featured\/\d+$/);
    const id = Number(location.split("/").pop());
    const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row).toMatchObject({
      title: fields.title,
      imageUrl: fields.image_url,
      imageAlt: fields.image_alt,
      position: 2,
    });
  });

  it("422s a disallowed image host with the field error and preserved values", async () => {
    const res = await app().request(
      "/featured",
      form({ title: "Bad host slot", image_url: "https://evil.test/pic.jpg", position: "0" }),
      liveEnv(),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('data-testid="form-errors"');
    expect(html).toContain("Image URL must be HTTPS on an approved public host");
    expect(html).toContain("Bad host slot");
    expect(html).toContain("https://evil.test/pic.jpg");
    expect(await db.select().from(featuredContents)).toHaveLength(0);
  });

  it("422s an inverted publish window with preserved values and no row", async () => {
    const res = await app().request(
      "/featured",
      form({
        title: "Backwards window",
        position: "0",
        starts_at: "2026-11-04 11:15",
        ends_at: "2026-11-04 09:05",
      }),
      liveEnv(),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("The window ends after it starts.");
    expect(html).toContain("Backwards window");
    expect(await db.select().from(featuredContents)).toHaveLength(0);
  });

  it("422s a missing headline as no-JS HTML with the entered body preserved", async () => {
    const res = await app().request(
      "/featured",
      form({ title: "", body: "Kept draft body", position: "0" }),
      liveEnv(),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Give it a headline.");
    expect(html).toContain("Kept draft body");
  });

  it("escapes rendered content: a script in the body stores raw but never renders raw", async () => {
    const payload = '<script>alert("xss")</script>';
    const res = await app().request(
      "/featured",
      form({ title: "XSS slot", body: payload, position: "0" }),
      liveEnv(),
    );
    expect(res.status).toBe(303);
    const id = Number(res.headers.get("location")!.split("/").pop());
    const list = await app().request("/featured", { headers: { cookie } }, liveEnv());
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("XSS slot");
    const edit = await app().request(`/featured/${id}`, { headers: { cookie } }, liveEnv());
    const editHtml = await edit.text();
    expect(editHtml).not.toContain(payload);
    expect(editHtml).toContain("&lt;script&gt;");
  });
});
