// route-inventory: GET /events.ics
// route-inventory: GET /events/:file{.+\.ics}
// Ledger DraftIcsConditionalAuthorizationTest (docs/w15-events-acceptance-ledger.md:137),
// collection half: the per-event draft pins already live in
// test/draft-ics-conditional-authz.test.ts (real DB: guest/member replay of a
// moderator draft validator stays 403, never 304/200, no draft bytes; the
// moderator's unchanged replay settles to an empty 304). This suite pins the
// collection surface (/events.ics) against the same validator: the collection
// is sessionless and draft-free by design (listFeed over published/cancelled
// only), so a 403 here would break public readers and is not the contract.
// The security property this proves instead is that a real moderator draft
// validator replayed on the collection can never yield 304 or draft bytes —
// it answers 200 with exactly the public feed — while the collection's own
// validator still settles to an empty 304. Real app + agent-testdb/CI
// Postgres only.
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
const PUBLISHED_KEY = "01J0000000000000000000PXB1";
const DRAFT_KEY = "01K0000000000000000000CA71";
const PUBLISHED_TITLE = "Public Friday game night";
const DRAFT_TITLE = "Private draft planning night";
const DRAFT_DESCRIPTION = "Moderator-only planning details";
const COLLECTION_PATH = "/events.ics";
const DRAFT_PATH = `/events/${DRAFT_KEY}.ics`;
const SHA256_ETAG_RE = /^"[a-f0-9]{64}"$/;

describe.skipIf(!process.env.DATABASE_URL)(
  "draft validator against the collection feed (agent-testdb)",
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

    const request = (path: string, cookie?: string, etag?: string) => {
      const headers = new Headers();
      if (cookie) headers.set("cookie", cookie);
      if (etag) headers.set("if-none-match", etag);
      return app.request(path, { headers }, env);
    };

    const cookieFor = async (moderator: boolean) => {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: moderator ? "w15-draft-feed-mod" : "w15-draft-feed-member",
        username: moderator ? "w15-draft-feed-mod" : "w15-draft-feed-member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      // The per-event draft read rotates, so every authed request mints a
      // fresh cookie; the sessionless collection ignores cookies entirely.
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    };

    const seed = () =>
      fixture.db.insert(events).values([
        {
          eventKey: PUBLISHED_KEY,
          title: PUBLISHED_TITLE,
          startsAt: new Date("2099-01-10T20:00:00Z"),
          endsAt: new Date("2099-01-10T22:00:00Z"),
          timezone: "UTC",
          location: "Voice: General",
          status: "published",
        },
        {
          eventKey: DRAFT_KEY,
          title: DRAFT_TITLE,
          description: DRAFT_DESCRIPTION,
          startsAt: new Date("2099-01-11T20:00:00Z"),
          endsAt: new Date("2099-01-11T22:00:00Z"),
          timezone: "UTC",
          location: "Private voice channel",
          status: "draft",
        },
      ]);

    const captureValidators = async () => {
      await fixture.reset();
      await seed();
      const draft = await request(DRAFT_PATH, await cookieFor(true));
      expect(draft.status).toBe(200);
      const draftBody = await draft.text();
      expect(draftBody).toContain(DRAFT_TITLE);
      const draftEtag = draft.headers.get("etag");
      expect(draftEtag).toMatch(SHA256_ETAG_RE);

      const collection = await request(COLLECTION_PATH);
      expect(collection.status).toBe(200);
      expect(collection.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
      expect(collection.headers.get("set-cookie")).toBeNull();
      const collectionBody = await collection.text();
      expect(collectionBody).toContain("BEGIN:VEVENT");
      expect(collectionBody).toContain(PUBLISHED_TITLE);
      expect(collectionBody).not.toContain(DRAFT_TITLE);
      expect(collectionBody).not.toContain(DRAFT_DESCRIPTION);
      expect(collectionBody).not.toContain(DRAFT_KEY);
      const collectionEtag = collection.headers.get("etag");
      expect(collectionEtag).toMatch(SHA256_ETAG_RE);
      expect(collectionEtag).not.toBe(draftEtag);
      return { draftEtag: draftEtag!, collectionEtag: collectionEtag!, collectionBody };
    };

    it("answers a replayed moderator draft validator with the public feed, never 304 or draft bytes", async () => {
      const { draftEtag, collectionEtag, collectionBody } = await captureValidators();

      for (const actor of ["guest", "member"] as const) {
        const response = await request(
          COLLECTION_PATH,
          actor === "member" ? await cookieFor(false) : undefined,
          draftEtag,
        );
        // The draft validator matches nothing on the draft-free collection:
        // 200 with exactly the public bytes — never a 304 oracle, never
        // draft bytes, and never a 403 that would break public readers.
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe(collectionEtag);
        const body = await response.text();
        expect(body).toBe(collectionBody);
        expect(body).not.toContain(DRAFT_TITLE);
        expect(body).not.toContain(DRAFT_DESCRIPTION);
        expect(body).not.toContain(DRAFT_KEY);
      }
    });

    it("still settles the collection's own validator to an empty 304 for guest and member", async () => {
      const { collectionEtag } = await captureValidators();

      for (const actor of ["guest", "member"] as const) {
        const unchanged = await request(
          COLLECTION_PATH,
          actor === "member" ? await cookieFor(false) : undefined,
          collectionEtag,
        );
        expect(unchanged.status).toBe(304);
        expect(await unchanged.text()).toBe("");
        expect(unchanged.headers.get("etag")).toBe(collectionEtag);
        expect(unchanged.headers.get("set-cookie")).toBeNull();
      }

      // Wildcard semantics stay intact on the public surface: an empty 304
      // carries no bytes of any kind.
      const wildcard = await request(COLLECTION_PATH, undefined, "*");
      expect(wildcard.status).toBe(304);
      expect(await wildcard.text()).toBe("");
    });

    it("keeps draft edits from perturbing the public collection validator or bytes", async () => {
      const { collectionEtag, collectionBody } = await captureValidators();

      await fixture.client`update events set title = 'Renamed draft planning night' where event_key = ${DRAFT_KEY}`;
      const after = await request(COLLECTION_PATH);
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).toBe(collectionEtag);
      expect(await after.text()).toBe(collectionBody);

      const settled = await request(COLLECTION_PATH, undefined, collectionEtag);
      expect(settled.status).toBe(304);
      expect(await settled.text()).toBe("");
    });
  },
);
