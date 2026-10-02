// Ledger DraftIcsConditionalAuthorizationTest (docs/w15-events-acceptance-ledger.md:129):
// capture a real moderator draft ETag from agent-testdb/CI Postgres, then prove
// authorization runs before conditional success: guest/member replay stays 403
// (never 304/200, no draft bytes), an unchanged moderator replay is an empty 304,
// and a title edit invalidates the validator.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const KEY = "01K0000000000000000000CA71";
const PATH = `/events/${KEY}.ics`;
const TITLE = "Private draft chess night";
const DESCRIPTION = "Moderator-only planning details";

describe.skipIf(!process.env.DATABASE_URL)(
  "draft ICS conditional authorization (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let store: SessionStore;
    let env: Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      store = createMemorySessionStore();
      env = {
        APP_URL,
        SESSION_SECRET,
        SESSION_STORE: store,
        ADMIN_DB: fixture.db,
      } as unknown as Env;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const request = (cookie?: string, etag?: string) => {
      const headers = new Headers();
      if (cookie) headers.set("cookie", cookie);
      if (etag) headers.set("if-none-match", etag);
      return app.request(PATH, { headers }, env);
    };

    const cookieFor = async (moderator: boolean) => {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: moderator ? "w15-draft-mod" : "w15-draft-member",
        username: moderator ? "w15-draft-mod" : "w15-draft-member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      // Sessions rotate on every authenticated view, so each request mints a fresh cookie.
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    };

    const seedDraft = () =>
      fixture.db.insert(events).values({
        eventKey: KEY,
        title: TITLE,
        description: DESCRIPTION,
        startsAt: new Date("2099-01-10T20:00:00Z"),
        endsAt: new Date("2099-01-10T22:00:00Z"),
        timezone: "UTC",
        location: "Private voice channel",
        status: "draft",
      });

    const moderatorEtag = async () => {
      await fixture.reset();
      await seedDraft();
      const first = await request(await cookieFor(true));
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
      const body = await first.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain(TITLE);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      return { etag: etag!, body };
    };

    it("replays a real moderator draft ETag as guest/member to a 403, never 304/200, with no draft bytes", async () => {
      const { etag } = await moderatorEtag();

      for (const [actor, cookie] of [
        ["guest", undefined],
        ["guest-wildcard", undefined],
        ["member", await cookieFor(false)],
      ] as const) {
        const inm = actor === "guest-wildcard" ? "*" : etag;
        const response = await request(cookie, inm);
        expect(response.status).toBe(403);
        expect(response.headers.get("etag")).toBeNull();
        expect(response.headers.get("content-type")).not.toContain("text/calendar");
        const body = await response.text();
        expect(body).toBe("Forbidden");
        expect(body).not.toContain("BEGIN:VCALENDAR");
        expect(body).not.toContain(TITLE);
        expect(body).not.toContain(DESCRIPTION);
      }
    });

    it("returns an empty 304 when the moderator replays the unchanged draft ETag", async () => {
      const { etag } = await moderatorEtag();

      const unchanged = await request(await cookieFor(true), etag);
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(unchanged.headers.get("cache-control")).toBe("max-age=300, private");
    });

    it("invalidates the moderator draft ETag after a title edit", async () => {
      const { etag } = await moderatorEtag();

      await fixture.client`update events set title = 'Renamed draft chess night' where event_key = ${KEY}`;
      const edited = await request(await cookieFor(true), etag);
      expect(edited.status).toBe(200);
      const next = edited.headers.get("etag");
      expect(next).toMatch(/^"[a-f0-9]{64}"$/);
      expect(next).not.toBe(etag);
      const body = await edited.text();
      expect(body).toContain("Renamed draft chess night");
      expect(body).not.toContain(TITLE);

      const settled = await request(await cookieFor(true), next!);
      expect(settled.status).toBe(304);
      expect(await settled.text()).toBe("");
      expect(settled.headers.get("etag")).toBe(next);
    });
  },
);
