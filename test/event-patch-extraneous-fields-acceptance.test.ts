// route-inventory: PATCH /events/:key
// Acceptance: a moderator PATCH on /events/:key that carries an extraneous
// `status` or `rsvpOpen` field is refused with a JSON 422 naming the
// extraneous field, and the stored row (plus audit log, RSVPs and queued
// sync work) is left exactly unchanged — including any otherwise-valid
// field sent alongside it. Presence of the field is what is refused, even
// when its value equals the stored value. A valid `{title}` PATCH still
// returns 200 and preserves the stored status/rsvpOpen. Error message
// wording is intentionally not pinned; the 422 envelope and the named
// field are the contract.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const STORED_EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MOD_ID = "extraneous-field-moderator";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

describe.skipIf(!process.env.DATABASE_URL)(
  "event PATCH extraneous status/rsvpOpen (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    const store = createMemorySessionStore();
    const sent: QueueMessage[] = [];
    let env: Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      env = {
        APP_URL,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_BOT_TOKEN: "bot-token",
        SESSION_SECRET,
        ADMIN_DB: fixture.db,
        SESSION_STORE: store,
        SYNC_EVENT_QUEUE: {
          send: async (message: unknown) => {
            sent.push(message as QueueMessage);
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
          },
        },
      } as unknown as Env;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      await fixture.reset();
      sent.length = 0;
      // A published, RSVP-open fixture: the case where a silently-ignored
      // {status:'cancelled'} or {rsvpOpen:false} misleads the moderator.
      await fixture.db.insert(events).values({
        eventKey: STORED_EVENT,
        title: "Game night",
        startsAt: new Date("2026-11-04T20:00:00.000Z"),
        endsAt: new Date("2026-11-04T22:00:00.000Z"),
        timezone: "Europe/London",
        location: "Voice",
        status: "published",
        rsvpOpen: true,
      });
    });
    afterEach(() => vi.restoreAllMocks());

    async function cookieFor() {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: MOD_ID,
        username: "Moderator",
        avatar: null,
        member: true,
        moderator: true,
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

    async function patch(body: unknown) {
      return app.request(
        `/events/${STORED_EVENT}`,
        {
          method: "PATCH",
          headers: {
            cookie: await cookieFor(),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        env,
      );
    }

    const snapshot = async () => ({
      events: await fixture.db.select().from(events),
      audit: await fixture.db.select().from(activityLog),
      rsvps: await fixture.db.select().from(rsvps),
    });

    async function expect422Naming(res: Response, fields: string[]) {
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as {
        error?: unknown;
        fields?: Record<string, unknown>;
      };
      expect(body.error).toBe("invalid");
      for (const field of fields) {
        expect(typeof body.fields?.[field]).toBe("string");
        expect(String(body.fields?.[field]).length).toBeGreaterThan(0);
      }
      expect(sent).toEqual([]);
    }

    it("PATCH {status:'cancelled'} is 422 naming status and leaves the row unchanged", async () => {
      const before = await snapshot();
      const res = await patch({ status: "cancelled" });
      await expect422Naming(res, ["status"]);
      expect(await snapshot()).toEqual(before);
    });

    it("PATCH {rsvpOpen:false} is 422 naming rsvpOpen and leaves the row unchanged", async () => {
      const before = await snapshot();
      const res = await patch({ rsvpOpen: false });
      await expect422Naming(res, ["rsvpOpen"]);
      expect(await snapshot()).toEqual(before);
    });

    it("PATCH with both extraneous fields is 422 naming both and leaves the row unchanged", async () => {
      const before = await snapshot();
      const res = await patch({ status: "cancelled", rsvpOpen: false });
      await expect422Naming(res, ["status", "rsvpOpen"]);
      expect(await snapshot()).toEqual(before);
    });

    it("PATCH {status:'published'} is refused even though it repeats the stored value", async () => {
      const before = await snapshot();
      const res = await patch({ status: "published" });
      await expect422Naming(res, ["status"]);
      expect(await snapshot()).toEqual(before);
    });

    it("PATCH {rsvpOpen:true} is refused even though it repeats the stored value", async () => {
      const before = await snapshot();
      const res = await patch({ rsvpOpen: true });
      await expect422Naming(res, ["rsvpOpen"]);
      expect(await snapshot()).toEqual(before);
    });

    it("an extraneous status is not smuggled in alongside a valid title", async () => {
      const before = await snapshot();
      const res = await patch({ title: "Smuggled rename", status: "cancelled" });
      await expect422Naming(res, ["status"]);
      expect(await snapshot()).toEqual(before);
    });

    it("an extraneous rsvpOpen is not smuggled in alongside a valid title", async () => {
      const before = await snapshot();
      const res = await patch({ title: "Smuggled rename", rsvpOpen: false });
      await expect422Naming(res, ["rsvpOpen"]);
      expect(await snapshot()).toEqual(before);
    });

    it("a valid {title} PATCH still returns 200 and preserves status and rsvpOpen", async () => {
      const res = await patch({ title: "Renamed game night" });
      expect(res.status).toBe(200);
      const [row] = await fixture.db.select().from(events);
      expect(row?.title).toBe("Renamed game night");
      expect(row?.status).toBe("published");
      expect(row?.rsvpOpen).toBe(true);
    });
  },
);
