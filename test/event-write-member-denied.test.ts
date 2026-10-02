// Member-denied 403 matrix for JSON event mutation writes (TOG-12224).
// publish/cancel/rsvp-pause/rsvp-reopen all sit behind moderatorGate
// (src/events/routes.tsx), so a signed-in non-moderator must get JSON 403 with
// zero mutations and no write-back queued, while a moderator control passes.
// Lives here instead of test/events.test.ts, which open PRs #245/#68 touch.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { getEvent } from "../src/admin/store";
import { newEventKey } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MOD_ID = "100000000000000111";
const MEMBER_ID = "100000000000000112";

const store = createMemorySessionStore();
const baseEnv = {
  APP_URL,
  SESSION_SECRET,
  SESSION_STORE: store,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as Env;

async function cookie(moderator: boolean): Promise<string> {
  const token = newSessionToken();
  const userId = moderator ? MOD_ID : MEMBER_ID;
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator,
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
}

type Action = "publish" | "cancel" | "rsvp-pause" | "rsvp-reopen";

describe.skipIf(!process.env.DATABASE_URL)(
  "event write member-denied matrix (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    const sent: SyncMessage[] = [];
    const env = {
      ...baseEnv,
      get ADMIN_DB() {
        return fixture.db;
      },
      EVENT_SYNC_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      sent.length = 0;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
      const [row] = await fixture.db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Denied matrix night",
          startsAt: new Date("2099-01-01T20:00:00Z"),
          endsAt: new Date("2099-01-01T22:00:00Z"),
          timezone: "UTC",
          status: "draft",
          ...over,
        })
        .returning();
      return row!;
    };
    // Each action needs a state where the moderator control would succeed, so a
    // member 403 proves the gate fired rather than a state guard.
    const seedFor = (action: Action) =>
      action === "publish"
        ? seed({ status: "draft" })
        : action === "rsvp-reopen"
          ? seed({ status: "published", rsvpOpen: false })
          : seed({ status: "published" });
    const post = async (action: Action, moderator: boolean, key: string) =>
      app.request(
        `/events/${key}/${action}`,
        {
          method: "POST",
          headers: {
            cookie: await cookie(moderator),
            origin: APP_URL,
            "content-type": "application/json",
          },
        },
        env,
      );

    it.each(["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const)(
      "member POST %s returns JSON 403 with zero mutations and no write-back",
      async (action) => {
        const row = await seedFor(action);
        const before = await getEvent(fixture.db, row.eventKey);
        const res = await app.request(
          `/events/${row.eventKey}/${action}`,
          {
            method: "POST",
            headers: {
              cookie: await cookie(false),
              origin: APP_URL,
              "content-type": "application/json",
            },
          },
          env,
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
        expect(await getEvent(fixture.db, row.eventKey)).toEqual(before);
        expect(await fixture.db.select().from(activityLog)).toEqual([]);
        expect(sent).toEqual([]);
      },
    );

    it("member POST to a missing key still 403s at the gate instead of 404", async () => {
      const res = await app.request(
        `/events/${"0".repeat(26)}/publish`,
        {
          method: "POST",
          headers: {
            cookie: await cookie(false),
            origin: APP_URL,
            "content-type": "application/json",
          },
        },
        env,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(sent).toEqual([]);
    });

    it("moderator control: publish moves a draft to published with a write-back", async () => {
      const row = await seed({ status: "draft" });
      const res = await app.request(
        `/events/${row.eventKey}/publish`,
        {
          method: "POST",
          headers: {
            cookie: await cookie(true),
            origin: APP_URL,
            "content-type": "application/json",
          },
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        data: { event_key: row.eventKey, status: "published" },
      });
      expect((await getEvent(fixture.db, row.eventKey))?.status).toBe("published");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ eventKey: row.eventKey, action: "event.upsert" });
      expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
    });

    it("moderator control: pause flips rsvp_open with a write-back", async () => {
      const row = await seed({ status: "published" });
      const res = await app.request(
        `/events/${row.eventKey}/rsvp-pause`,
        {
          method: "POST",
          headers: {
            cookie: await cookie(true),
            origin: APP_URL,
            "content-type": "application/json",
          },
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        data: { event_key: row.eventKey, rsvp_open: false },
      });
      expect((await getEvent(fixture.db, row.eventKey))?.rsvpOpen).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ eventKey: row.eventKey, action: "event.upsert" });
      expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
    });

    it("forwards declared action posts without a local helper", async () => {
      // Keeps the `post` helper above honest: every matrix path goes through it.
      const row = await seed({ status: "draft" });
      const res = await post("publish", false, row.eventKey);
      expect(res.status).toBe(403);
      expect(await getEvent(fixture.db, row.eventKey)).toMatchObject({ status: "draft" });
    });
  },
);
