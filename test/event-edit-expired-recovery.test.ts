// route-inventory: PATCH /events/:key
// route-inventory: POST /events
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/cancel
// route-inventory: POST /events/:key/rsvp-pause
// route-inventory: POST /events/:key/rsvp-reopen
// Expired-session recovery for moderator event JSON writes (TOG-12621): a
// presented bearer with no live row is an expired guest, not an unknown
// guest — the gate bounces through expiredWriteBounce, so JSON callers keep
// 401 with a recovery link (TOG-10357 profile / TOG-12399 admin precedent).
// No-cookie guests keep the bare refusal, live non-moderators keep 403, and
// the OAuth round trip restores a working session with the one-shot banner.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import { fixtureDiscord, mergeCookies } from "./fixtures/session-recovery";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MOD_ROLE = "100000000000000010";
const MEMBER = "100000000000000001";
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
  SESSION_SECRET,
};

describe.skipIf(!process.env.DATABASE_URL)(
  "event JSON edit expired-write recovery (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    const store = createMemorySessionStore();
    type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;
    const sent: SyncMessage[] = [];
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      SYNC_EVENT_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) },
    } as unknown as Env;

    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, init, { ...env, ADMIN_DB: fixture.db });

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      sent.length = 0;
      await fixture.db.insert(events).values({
        eventKey: EVENT_KEY,
        title: "Game night",
        game: "Chess",
        description: "Bring a board",
        startsAt: new Date("2026-10-25T01:30:17Z"),
        endsAt: new Date("2026-10-25T01:50:29Z"),
        timezone: "Europe/London",
        location: "Voice",
        capacity: 8,
        status: "draft",
        discordEventId: "123456789012345678",
        createdBy: "event-moderator",
        rsvpOpen: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });
    });

    async function cookieFor(
      userId: string,
      moderator: boolean,
      expiresAt = new Date(Date.now() + 3600_000),
    ) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId,
        username: userId,
        avatar: null,
        member: true,
        moderator,
        expiresAt,
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

    const patch = (cookie: string | undefined, body: unknown) =>
      req(`/events/${EVENT_KEY}`, {
        method: "PATCH",
        headers: {
          ...(cookie ? { cookie } : {}),
          origin: APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });

    const titles = async () => (await fixture.db.select().from(events)).map((row) => row.title);

    it("an expired moderator bearer gets 401 with a recovery link and writes nothing", async () => {
      const before = await titles();
      const dead = await cookieFor("event-moderator", true, new Date(0));
      const res = await patch(dead, { title: "Unsaved edit" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized",
        recovery: "/auth/recover?next=%2Fevents",
      });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await titles()).toEqual(before);
      expect(sent).toEqual([]);
    });

    it("a request with no cookie keeps the bare unauthenticated refusal", async () => {
      const res = await patch(undefined, { title: "Unsaved edit" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });

    // JSON-only routes never negotiate: a header-less fetch must not follow a
    // 303 to a 200 page and read a dropped write as success.
    const recoveryBody = { error: "Unauthorized", recovery: "/auth/recover?next=%2Fevents" };
    const expectJsonRecovery = async (res: Response) => {
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual(recoveryBody);
    };
    const rows = async () =>
      (await fixture.db.select().from(events)).map(({ title, status, rsvpOpen }) => ({
        title,
        status,
        rsvpOpen,
      }));

    it.each(["publish", "cancel", "rsvp-pause", "rsvp-reopen"])(
      "an expired bearer on bodiless %s with no Accept gets the JSON 401",
      async (action) => {
        const before = await rows();
        const dead = await cookieFor("event-moderator", true, new Date(0));
        const res = await req(`/events/${EVENT_KEY}/${action}`, {
          method: "POST",
          headers: { cookie: dead, origin: APP_URL },
        });
        await expectJsonRecovery(res);
        expect(await rows()).toEqual(before);
        expect(sent).toEqual([]);
      },
    );

    it.each([
      ["PATCH", `/events/${EVENT_KEY}`],
      ["POST", "/events"],
    ])("an expired bearer on a form-bodied %s %s gets the JSON 401", async (method, path) => {
      const before = await rows();
      const dead = await cookieFor("event-moderator", true, new Date(0));
      const res = await req(path, {
        method,
        headers: {
          cookie: dead,
          origin: APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ title: "Unsaved edit" }).toString(),
      });
      await expectJsonRecovery(res);
      expect(await rows()).toEqual(before);
      expect(sent).toEqual([]);
    });

    it("a live non-moderator still gets 403", async () => {
      const res = await patch(await cookieFor("event-member", false), { title: "Unsaved edit" });
      expect(res.status).toBe(403);
      expect(await titles()).toEqual(["Game night"]);
    });

    it("recovery landing, moderator OAuth login, fresh write, banner exactly once", async () => {
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = String(input).replace(
            "https://discord.com/api/v10/",
            "https://discord.com/api/",
          );
          if (url.includes(`/guilds/326474832151838730/members/${MEMBER}`)) {
            if (init?.method === "PUT") return new Response(null, { status: 204 });
            return Response.json({ roles: [MOD_ROLE], joined_at: "2024-01-01T00:00:00Z" });
          }
          return fixtureDiscord(input, init);
        },
      );
      try {
        const dead = await cookieFor("event-moderator", true, new Date(0));
        const bounce = await patch(dead, { title: "Unsaved edit" });
        expect(bounce.status).toBe(401);
        const recovery = (await bounce.json()) as { recovery: string };

        let jar = mergeCookies("", await req(recovery.recovery));
        expect(jar).not.toContain("Unsaved");
        const start = await req(`/auth/discord?next=${encodeURIComponent("/events")}`, {
          headers: { cookie: jar },
        });
        jar = mergeCookies(jar, start);
        const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
        const callback = await req(`/auth/discord/callback?state=${state}&code=fixture`, {
          headers: { cookie: jar },
        });
        expect(callback.headers.get("location")).toBe("/events");
        jar = mergeCookies(jar, callback);
        expect(jar.split("; ").find((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toContain(
          "restored",
        );

        // A fresh session after recovery edits successfully.
        const sessionCookie = jar.split("; ").find((c) => c.startsWith("__Host-two_session="))!;
        const retry = await patch(sessionCookie, { title: "Recovered edit" });
        expect(retry.status).toBe(200);
        expect(await titles()).toEqual(["Recovered edit"]);

        // The one-shot banner lands on the return page, then is gone.
        const page = await req("/events", { headers: { cookie: jar } });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('data-testid="auth-error"');
        jar = mergeCookies(jar, page);
        expect(await (await req("/events", { headers: { cookie: jar } })).text()).not.toContain(
          'data-testid="auth-error"',
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  },
);
