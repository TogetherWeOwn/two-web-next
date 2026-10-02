// route-inventory: GET /events.json
// route-inventory: PATCH /events/:key
// Ledger EventEtagTest gaps (docs/w15-events-acceptance-ledger.md:99):
// feed + unchanged-JSON validators are proved elsewhere; this pins the two
// JSON gaps — legacy title-edit invalidation (EventEtagTest.php:32-46) and
// member-vs-moderator validator separation when drafts are visible (:48-64).
// Real app + agent-testdb/CI Postgres only.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const PUBLISHED_KEY = "01K0000000000000000000E716";
const DRAFT_KEY = "01K0000000000000000000D317";
const PUBLISHED_TITLE = "Public game night";
const DRAFT_TITLE = "Private draft planning night";

const SHA1_ETAG_RE = /^"[a-f0-9]{40}"$/;

describe.skipIf(!process.env.DATABASE_URL)("event JSON ETag invalidation (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let store: SessionStore;
  let env: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    store = createMemorySessionStore();
    // No DATABASE_URL on the app env: throttle degrades to allow and the DB
    // comes from the injected ADMIN_DB, like test/rsvp-waitlist.test.ts.
    env = {
      APP_URL, SESSION_SECRET, SESSION_STORE: store, ADMIN_DB: fixture.db,
      DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730", DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SYNC_EVENT_QUEUE: { send: async () => {} },
    } as unknown as Env;
  });
  afterAll(async () => { await fixture?.dispose(); });

  const cookieFor = async (moderator: boolean, userId?: string) => {
    const id = userId ?? (moderator ? "w15-json-etag-mod" : "w15-json-etag-member");
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: id, username: id,
      avatar: null, member: true, moderator,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // Fragment sessions do not rotate, so one cookie serves the whole case.
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  };

  const jsonGet = (eventKey: string, cookie: string, etag?: string) => {
    const headers = new Headers({ cookie });
    if (etag) headers.set("if-none-match", etag);
    return app.request(`/events.json?event_key=${eventKey}`, { headers }, env);
  };

  const seed = async () => {
    await fixture.reset();
    await fixture.db.insert(events).values([
      {
        eventKey: PUBLISHED_KEY, title: PUBLISHED_TITLE, status: "published",
        startsAt: new Date("2099-03-10T20:00:00Z"), endsAt: new Date("2099-03-10T22:00:00Z"),
        timezone: "UTC", location: "Voice",
      },
      {
        eventKey: DRAFT_KEY, title: DRAFT_TITLE, status: "draft",
        startsAt: new Date("2099-03-11T20:00:00Z"), endsAt: new Date("2099-03-11T22:00:00Z"),
        timezone: "UTC", location: "Private voice channel",
      },
    ]);
  };

  it("invalidates the JSON ETag after a moderator title edit", async () => {
    await seed();
    const mod = await cookieFor(true);

    const first = await jsonGet(PUBLISHED_KEY, mod);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(SHA1_ETAG_RE);
    expect(await first.text()).toContain(PUBLISHED_TITLE);

    // Title edit through the real moderator PATCH route.
    const patched = await app.request(`/events/${PUBLISHED_KEY}`, {
      method: "PATCH",
      headers: { cookie: mod, origin: APP_URL, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed game night" }),
    }, env);
    expect(patched.status).toBe(200);

    // Stale validator: 200 with the renamed body and a changed ETag, never 304.
    const stale = await jsonGet(PUBLISHED_KEY, mod, etag!);
    expect(stale.status).toBe(200);
    const next = stale.headers.get("etag");
    expect(next).toMatch(SHA1_ETAG_RE);
    expect(next).not.toBe(etag);
    const staleBody = await stale.text();
    expect(staleBody).toContain("Renamed game night");
    expect(staleBody).not.toContain(PUBLISHED_TITLE);

    // Fresh validator settles back to an empty 304.
    const settled = await jsonGet(PUBLISHED_KEY, mod, next!);
    expect(settled.status).toBe(304);
    expect(await settled.text()).toBe("");
    expect(settled.headers.get("etag")).toBe(next);
  });

  it("refuses a moderator draft ETag replayed as member, with no cross-role 304", async () => {
    await seed();
    const mod = await cookieFor(true);
    const member = await cookieFor(false);

    const draft = await jsonGet(DRAFT_KEY, mod);
    expect(draft.status).toBe(200);
    const draftEtag = draft.headers.get("etag");
    expect(draftEtag).toMatch(SHA1_ETAG_RE);
    expect(await draft.text()).toContain(DRAFT_TITLE);

    // Authorization runs before conditional success: the member replay is a
    // 200 with an empty draft-filtered body — never 304, never draft bytes.
    const replay = await jsonGet(DRAFT_KEY, member, draftEtag!);
    expect(replay.status).toBe(200);
    const memberEtag = replay.headers.get("etag");
    expect(memberEtag).toMatch(SHA1_ETAG_RE);
    expect(memberEtag).not.toBe(draftEtag);
    const body = await replay.text();
    expect(body).not.toContain(DRAFT_TITLE);
    expect(JSON.parse(body).data).toEqual([]);

    // The moderator's own unchanged replay still settles to an empty 304.
    const modReplay = await jsonGet(DRAFT_KEY, mod, draftEtag!);
    expect(modReplay.status).toBe(304);
    expect(await modReplay.text()).toBe("");
    expect(modReplay.headers.get("etag")).toBe(draftEtag);
  });
});
