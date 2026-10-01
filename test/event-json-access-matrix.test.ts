// route-inventory: GET /events.json
// TOG-11666: JSON event access matrix + field allowlist (collection surface).
// Ports the collection rows of legacy two-web
// `Feature/Events/EventJsonAccessTest.php` and the allowlist/aggregate/
// derivation rows of `Feature/Events/EventJsonContractTest.php` against the
// mounted Next app (agent-testdb/CI Postgres, isolated disposable schema).
// Deliberately out of scope (blocked TOG-11155 owns them): the GET
// /events/:key JSON show route, the per_page/meta paging contract, row
// ordering, and the browser-guest redirect. The draft/member HTML show rows
// below pin the shared view policy without duplicating that card's JSON show.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// Legacy EventResource order (event_key first, synced_to_discord last, never
// the autoincrement id), plus Next's viewer-specific waitlist_position trailer
// (already pinned by test/rsvp-waitlist.test.ts).
const EXPECTED_KEYS = [
  "event_key",
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "starts_at_local",
  "ends_at_local",
  "timezone",
  "location",
  "capacity",
  "going_count",
  "status",
  "rsvp_open",
  "synced_to_discord",
  "waitlist_position",
];

// 26-char Crockford keys (digits are a valid subset) distinct per seed row.
const key = (n: number) => `01J${String(n).padStart(23, "0")}`;

type Row = Record<string, unknown> & { event_key: string; status: string };

describe.skipIf(!process.env.DATABASE_URL)("event JSON access matrix (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  const store = createMemorySessionStore();
  const env = {
    APP_URL, SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730", DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_BOT_TOKEN: "bot-token", SESSION_STORE: store,
    get ADMIN_DB() { return db; },
  } as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => { await fixture?.dispose(); });

  async function cookieFor(userId: string, moderator: boolean): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId, username: userId, avatar: null,
      member: true, moderator, expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET,
      { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  }

  // /events.json never rotates the fragment session, but /e/:key HTML does, so
  // every request mints a fresh cookie rather than replaying one.
  async function get(path: string, userId: string | null, moderator = false) {
    const headers: Record<string, string> = {};
    if (userId) headers.cookie = await cookieFor(userId, moderator);
    return app.request(path, { headers }, env);
  }
  const asMember = (path: string) => get(path, "matrix-member", false);
  const asModerator = (path: string) => get(path, "matrix-moderator", true);
  const rowsOf = async (res: Response) => (await res.json() as { data: Row[] }).data;

  async function seedStatuses() {
    const seeds = [
      { n: 1, status: "draft", title: "Unannounced raid" },
      { n: 2, status: "published", title: "Friday night Helldivers" },
      { n: 3, status: "cancelled", title: "Called-off raid" },
      { n: 4, status: "past", title: "Last season finale" },
    ] as const;
    for (const [i, s] of seeds.entries()) {
      await db.insert(events).values({
        eventKey: key(s.n), title: s.title, status: s.status,
        startsAt: new Date(Date.UTC(2099, 5, 10 + i, 18)),
        endsAt: new Date(Date.UTC(2099, 5, 10 + i, 20)),
        timezone: "UTC",
      });
    }
    return { draftKey: key(1), publishedKey: key(2) };
  }

  it("refuses a guest over JSON with 401", async () => {
    await db.insert(events).values({
      eventKey: key(11), title: "Friday night Helldivers", status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
    });
    const res = await get("/events.json", null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("shows a member published, cancelled and past events but no drafts", async () => {
    await seedStatuses();
    const res = await asMember("/events.json");
    expect(res.status).toBe(200);
    const statuses = (await rowsOf(res)).map((r) => r.status).sort();
    // Cancelled stays visible: members who RSVP'd need to see that it is off,
    // and the collection only ever excludes drafts for non-moderators.
    expect(statuses).toEqual(["cancelled", "past", "published"]);
  });

  it("shows a moderator drafts alongside everything else", async () => {
    await seedStatuses();
    const res = await asModerator("/events.json");
    expect(res.status).toBe(200);
    const statuses = (await rowsOf(res)).map((r) => r.status).sort();
    expect(statuses).toEqual(["cancelled", "draft", "past", "published"]);
  });

  it("refuses a member the draft show while the moderator reads it; unknown/malformed keys 404", async () => {
    const { draftKey } = await seedStatuses();
    expect((await get(`/e/${draftKey}`, "matrix-member", false)).status).toBe(403);
    expect((await get(`/e/${draftKey}`, "matrix-moderator", true)).status).toBe(200);
    expect((await asMember("/e/01J00000000000000000000999")).status).toBe(404);
    expect((await asMember("/e/not-a-ulid")).status).toBe(404);
  });

  it("exposes exactly the allowlisted keys in order, with nulls as nulls and no internal ids", async () => {
    await db.insert(events).values({
      eventKey: key(21), title: "Sparse night", status: "published",
      game: null, description: null, location: null, capacity: null,
      startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
    });
    await db.insert(events).values({
      eventKey: key(22), title: "Full night", status: "published",
      game: "Helldivers 2", description: "Bring stims.", location: "Voice: General", capacity: 4,
      startsAt: new Date("2099-11-05T20:00:00Z"), endsAt: new Date("2099-11-05T22:00:00Z"),
    });
    for (const res of [await asMember("/events.json"), await asModerator("/events.json")]) {
      expect(res.status).toBe(200);
      const rows = await rowsOf(res);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        // Strict equality: a rename, removal, addition or reorder fails here.
        expect(Object.keys(row)).toEqual(EXPECTED_KEYS);
        expect(row).not.toHaveProperty("id");
      }
      const sparse = rows.find((r) => r.event_key === key(21))!;
      expect(sparse.game).toBeNull();
      expect(sparse.description).toBeNull();
      expect(sparse.location).toBeNull();
      expect(sparse.capacity).toBeNull();
    }
  });

  it("keeps the field types the consumers parse against, with both readings of the time", async () => {
    await db.insert(events).values({
      eventKey: key(31), title: "Friday night Helldivers", game: "Helldivers 2",
      description: "Bring stims.", timezone: "Europe/London", location: "Voice: General",
      capacity: 4, status: "published",
      startsAt: new Date("2099-07-15T18:00:00Z"), endsAt: new Date("2099-07-15T20:00:00Z"),
    });
    const res = await asMember("/events.json");
    const row = (await rowsOf(res)).find((r) => r.event_key === key(31))!;
    expect(row.event_key).toBe(key(31));
    expect(row.title).toBe("Friday night Helldivers");
    expect(typeof row.game).toBe("string");
    expect(typeof row.description).toBe("string");
    expect(row.timezone).toBe("Europe/London");
    expect(typeof row.location).toBe("string");
    expect(row.capacity).toBe(4);
    expect(row.going_count).toBe(0);
    expect(row.status).toBe("published");
    expect(row.rsvp_open).toBe(true);
    expect(row.synced_to_discord).toBe(false);
    expect(row.waitlist_position).toBeNull();
    expect(() => new Date(String(row.starts_at))).not.toThrow();
    expect(() => new Date(String(row.ends_at))).not.toThrow();
    // BST wall time beside the UTC instant: 18:00Z renders as 19:00 in London.
    expect(row.starts_at_local).toBe("2099-07-15 19:00");
    expect(row.ends_at_local).toBe("2099-07-15 21:00");
  });

  it("counts only going answers in going_count, on the listing as on one row", async () => {
    const [ev] = await db.insert(events).values({
      eventKey: key(41), title: "Counted night", status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
    }).returning();
    await db.insert(rsvps).values([
      { eventId: ev!.id, userId: "going-1", status: "going" },
      { eventId: ev!.id, userId: "going-2", status: "going" },
      { eventId: ev!.id, userId: "unsure", status: "maybe" },
      { eventId: ev!.id, userId: "declined", status: "not_going" },
      { eventId: ev!.id, userId: "queued", status: "waitlisted" },
    ]);
    await db.insert(events).values({
      eventKey: key(42), title: "Quiet night", status: "published",
      startsAt: new Date("2099-11-05T20:00:00Z"), endsAt: new Date("2099-11-05T22:00:00Z"),
    });
    const rows = await rowsOf(await asMember("/events.json"));
    // "maybe" is not a seat, and neither is a no or a queue place.
    expect(rows.find((r) => r.event_key === key(41))!.going_count).toBe(2);
    expect(rows.find((r) => r.event_key === key(42))!.going_count).toBe(0);
  });

  it("derives synced_to_discord from the mirror column without leaking the raw id", async () => {
    const mirrorId = "987654321098765432";
    await db.insert(events).values({
      eventKey: key(51), title: "Unmirrored night", status: "published", discordEventId: null,
      startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
    });
    await db.insert(events).values({
      eventKey: key(52), title: "Mirrored night", status: "published", discordEventId: mirrorId,
      startsAt: new Date("2099-11-05T20:00:00Z"), endsAt: new Date("2099-11-05T22:00:00Z"),
    });
    const res = await asMember("/events.json");
    const rows = await rowsOf(res);
    expect(rows.find((r) => r.event_key === key(51))!.synced_to_discord).toBe(false);
    expect(rows.find((r) => r.event_key === key(52))!.synced_to_discord).toBe(true);
    // Fresh body read: rowsOf consumed the first response, so re-request for
    // the raw-bytes leak check — the raw mirror id must never appear.
    const raw = await (await asMember("/events.json")).text();
    expect(raw).not.toContain(mirrorId);
  });

  it("filters keyed collection reads by visibility: malformed refused, drafts hidden from members", async () => {
    const { draftKey, publishedKey } = await seedStatuses();
    const picked = await rowsOf(await asMember(`/events.json?event_key=${publishedKey}`));
    expect(picked.map((r) => r.event_key)).toEqual([publishedKey]);
    expect(await rowsOf(await asMember(`/events.json?event_key=${draftKey}`))).toEqual([]);
    const shown = await rowsOf(await asModerator(`/events.json?event_key=${draftKey}`));
    expect(shown.map((r) => r.event_key)).toEqual([draftKey]);
    expect((await asMember("/events.json?event_key=nope")).status).toBe(422);
    expect(await rowsOf(await asMember("/events.json?event_key=01J00000000000000000000999"))).toEqual([]);
  });
});
