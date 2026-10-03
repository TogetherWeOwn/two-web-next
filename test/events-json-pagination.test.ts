// route-inventory: GET /events.json
// Past-the-end collection pages clamp to the last page before any OFFSET is
// issued, so ?page=huge returns the last page instead of scanning past every
// row. Real app + agent-testdb/CI Postgres only.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// All-digit keys, one per seed row (same shape as the paging pins in
// test/events.test.ts, so no secret scanner trips).
const key = (n: number) => String(n).padStart(26, "0");

type JsonRow = { event_key: string; going_count: number };
type Collection = {
  data: JsonRow[];
  page: number;
  limit: number;
  meta: { current_page: number; per_page: number; total: number; last_page: number };
};

describe.skipIf(!process.env.DATABASE_URL)("events.json page clamp (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let store: SessionStore;
  let env: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    store = createMemorySessionStore();
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_STORE: store,
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env;
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const cookieFor = async () => {
    const id = "100000000000000141";
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: id,
      username: id,
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };

  const collection = async (query = "") => {
    const res = await app.request(
      `/events.json${query}`,
      { headers: { cookie: await cookieFor() } },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Collection;
  };

  // Seven published rows over consecutive days: per_page=3 gives three pages
  // (3/3/1), earliest-first, so the last page holds exactly key(7).
  const seedSeven = () =>
    db.insert(events).values(
      Array.from({ length: 7 }, (_, i) => ({
        eventKey: key(i + 1),
        title: `Game ${i + 1}`,
        status: "published",
        startsAt: new Date(Date.UTC(2099, 0, i + 1, 20)),
        endsAt: new Date(Date.UTC(2099, 0, i + 1, 22)),
      })),
    );

  it("returns the last page with consistent meta for a huge page", async () => {
    await seedSeven();
    const last = await collection("?per_page=3&page=3");
    expect(last.meta).toEqual({ current_page: 3, per_page: 3, total: 7, last_page: 3 });
    expect(last.page).toBe(3);
    expect(last.data.map((row) => row.event_key)).toEqual([key(7)]);
    const huge = await collection("?per_page=3&page=99999999");
    expect(huge).toEqual(last);
  });

  it("leaves in-range paging unchanged", async () => {
    await seedSeven();
    const first = await collection("?per_page=3&page=1");
    expect(first.data.map((row) => row.event_key)).toEqual([key(1), key(2), key(3)]);
    expect(first.meta).toEqual({ current_page: 1, per_page: 3, total: 7, last_page: 3 });
    const second = await collection("?per_page=3&page=2");
    expect(second.data.map((row) => row.event_key)).toEqual([key(4), key(5), key(6)]);
    expect(second.page).toBe(2);
    expect(second.meta.current_page).toBe(2);
  });

  it("clamps an empty collection to page one with a single last page", async () => {
    const empty = await collection("?per_page=3&page=99999999");
    expect(empty).toEqual({
      data: [],
      page: 1,
      limit: 3,
      meta: { current_page: 1, per_page: 3, total: 0, last_page: 1 },
    });
  });
});
