// Fold edit-route round-trip (TOG-11711): legacy
// Feature/Admin/EventEditFoldRoundTripTest.php. The parser boundary already
// pins carrier preservation in test/event-time-validation.test.ts; this suite
// proves the REAL edit route: GET renders minute wall text, POST pairs it with
// the stored instant server-side, so an unchanged save keeps the exact instant
// on either side of the fold, a deliberate wall edit drops the carrier, and
// sub-minute precision survives. Hermetic part: none — all route assertions
// need agent-testdb / CI Postgres.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "fold-roundtrip-test-secret-at-least-32-bytes";
// 2026-10-25: Europe/London falls back 02:00 BST -> 01:00 GMT, so wall 01:30
// names two instants: 00:30Z (first, BST) and 01:30Z (second, GMT).
const WALL = "2026-10-25 01:30";
const FIRST_OCCURRENCE = "2026-10-25T00:30:00.000Z";
const SECOND_OCCURRENCE = "2026-10-25T01:30:00.000Z";
const FORM = {
  title: "Fold night", game: "Chess", description: "Boards out", location: "Voice", capacity: "8",
  starts_at: WALL, ends_at: "2026-10-25 03:00", timezone: "Europe/London",
};

function inputValue(html: string, name: string): string {
  const patterns = [
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`),
    new RegExp(`value="([^"]*)"[^>]*name="${name}"`),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1]!;
  }
  throw new Error(`no input named ${name} in edit page`);
}

describe.skipIf(!process.env.DATABASE_URL)("fold edit-route round-trip (isolated test DB)", () => {
  let fixture: MemberDataFixture;
  let cookie: string;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  const store = createMemorySessionStore();

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: "fold-roundtrip-mod", username: "mod", avatar: null,
      member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000),
    });
    cookie = (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
    env = {
      APP_URL, SESSION_SECRET, DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "guild", DISCORD_INVITE_URL: "https://discord.gg/invite", DISCORD_BOT_TOKEN: "bot-token",
      ADMIN_DB: fixture.db,
    } as Env;
    app = new Hono<{ Bindings: Env }>().use("*", sameOrigin)
      .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
  });
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => { await fixture.reset(); });

  const seed = (key: string, startsAt: string, endsAt: string) =>
    fixture.db.insert(events).values({
      eventKey: key, title: "Fold night", timezone: "Europe/London", status: "draft",
      startsAt: new Date(startsAt), endsAt: new Date(endsAt),
    });
  const saved = async (key: string) =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, key)))[0]!;
  const post = (key: string, values: Record<string, string>) => app.request(APP_URL + `/admin/events/${key}`, {
    method: "POST", headers: { cookie, origin: APP_URL }, body: new URLSearchParams(values),
  }, env);

  // GET the real edit page, resubmit its rendered wall text unchanged: the
  // stored instant must survive byte-for-byte on either side of the fold.
  for (const [side, stored] of [["first (BST)", FIRST_OCCURRENCE], ["second (GMT)", SECOND_OCCURRENCE]] as const) {
    it(`unchanged edit-route save preserves the ${side} occurrence`, async () => {
      const key = `fold-keep-${stored === FIRST_OCCURRENCE ? "bst" : "gmt"}`;
      await seed(key, stored, "2026-10-25T03:00:00.000Z");
      const page = await app.request(APP_URL + `/admin/events/${key}`, { headers: { cookie } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(inputValue(html, "starts_at")).toBe(WALL);
      const res = await post(key, { ...FORM, starts_at: inputValue(html, "starts_at"), ends_at: inputValue(html, "ends_at") });
      expect(res.status).toBe(303);
      const row = await saved(key);
      expect(row.startsAt.toISOString()).toBe(stored);
      expect(row.endsAt.toISOString()).toBe("2026-10-25T03:00:00.000Z");
    });
  }

  it("unchanged edit-route save preserves sub-minute precision on both occurrences", async () => {
    await seed("fold-ms-bst", "2026-10-25T00:30:27.125Z", "2026-10-25T03:00:44.875Z");
    await seed("fold-ms-gmt", "2026-10-25T01:30:27.125Z", "2026-10-25T03:00:44.875Z");
    for (const [key, starts] of [
      ["fold-ms-bst", "2026-10-25T00:30:27.125Z"],
      ["fold-ms-gmt", "2026-10-25T01:30:27.125Z"],
    ] as const) {
      const page = await app.request(APP_URL + `/admin/events/${key}`, { headers: { cookie } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      const res = await post(key, { ...FORM, starts_at: inputValue(html, "starts_at"), ends_at: inputValue(html, "ends_at") });
      expect(res.status).toBe(303);
      const row = await saved(key);
      expect(row.startsAt.toISOString()).toBe(starts);
      expect(row.endsAt.toISOString()).toBe("2026-10-25T03:00:44.875Z");
    }
  });

  it("a deliberate wall-time edit drops the carrier and re-parses under first-occurrence policy", async () => {
    // Stored on the GMT side; the moderator moves 01:30 -> 01:45 inside the
    // fold. The wall text no longer matches the rendered carrier minute, so
    // the save takes the fresh-parse first (BST) occurrence, not the stored side.
    await seed("fold-drop", SECOND_OCCURRENCE, "2026-10-25T03:00:00.000Z");
    const res = await post("fold-drop", { ...FORM, starts_at: "2026-10-25 01:45" });
    expect(res.status).toBe(303);
    const row = await saved("fold-drop");
    expect(row.startsAt.toISOString()).toBe("2026-10-25T00:45:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2026-10-25T03:00:00.000Z");
  });

  it("a deliberate move out of the fold drops the carrier to the unambiguous instant", async () => {
    await seed("fold-leave", SECOND_OCCURRENCE, "2026-10-25T03:00:00.000Z");
    const res = await post("fold-leave", { ...FORM, starts_at: "2026-10-25 02:30" });
    expect(res.status).toBe(303);
    expect((await saved("fold-leave")).startsAt.toISOString()).toBe("2026-10-25T02:30:00.000Z");
  });
});
