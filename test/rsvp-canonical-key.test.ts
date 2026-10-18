// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// RSVP writes tell the truth on every key spelling.
//
// ULIDs are stored uppercase and the per-key read routes (detail, .ics)
// 301 a valid key in another letter case to the canonical URL before any
// session or DB read. The RSVP resource must do the same on PUT and
// DELETE: a lowercased or mixed-case spelling of a live event key is one
// redirect hop away from the canonical RSVP URL, never a 404 against an
// event that exists and never a write against the wrong spelling.
//
// A DELETE that deletes nothing must also say so. When the caller has no
// RSVP row for the key — the event exists but they never answered, only
// another member answered, the key names no event, or the key is forged —
// the answer is the same honest not-found the PUT already returns, never
// a 204 that implies a withdrawal happened. A DELETE that really removes
// the caller's row still answers 204, and the honeypot decoy still
// answers its byte-identical implied success without touching rows,
// budget or auth.
//
// Live against the disposable Postgres fixture (skipped without
// DATABASE_URL, like test/rsvp.test.ts). Never point this at anything
// but a test container.
import { serializeSigned } from "hono/utils/cookie";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";

// RSVP route tests isolate dispatch; other suites prove the real producer.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { RSVP_HONEY_FIELD } from "../src/islands/contracts";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
// Well-formed ULID no seeded event ever uses (allowlisted fixture value).
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// 26 chars but outside the ULID alphabet (I is excluded): garbage, never
// a non-canonical spelling of anything.
const BAD_ALPHABET_KEY = `${UNKNOWN_KEY.slice(0, 25)}I`;

async function cookieFor(store: SessionStore, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
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
}

// Alternating letter case, not just all-lowercase: still one hop to canonical.
const mixedCase = (key: string) =>
  key
    .split("")
    .map((ch, i) => (i % 2 ? ch.toLowerCase() : ch))
    .join("");
// Fully percent-encoded lowercase key: the route param decodes before any
// canonical decision, so the redirect still fires in a single hop.
const encodedLower = (key: string) =>
  key
    .toLowerCase()
    .split("")
    .map((ch) => `%${ch.charCodeAt(0).toString(16)}`)
    .join("");

describe.skipIf(!process.env.DATABASE_URL)(
  "rsvp canonical key + honest DELETE (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let client: MemberDataFixture["client"];
    const store = createMemorySessionStore();
    const sent: QueueMessage[] = [];
    const env = {
      APP_URL,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET,
      get ADMIN_DB() {
        return db;
      },
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      db = fixture.db;
      client = fixture.client;
    });
    beforeEach(async () => {
      await fixture.reset();
      await client`delete from web_throttle_hits`;
      sent.length = 0;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    // Sessions rotate on each authenticated view, so every request mints a
    // fresh cookie, as in test/rsvp.test.ts. `as: null` sends no cookie.
    const request = async (path: string, method: string, as: string | null, body?: unknown) =>
      app.request(
        path,
        {
          method,
          headers: {
            ...(as ? { cookie: await cookieFor(store, as) } : {}),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    const put = (key: string, as: string | null, status: unknown = "going", query = "") =>
      request(`/events/${key}/rsvp${query}`, "PUT", as, { status });
    const del = (key: string, as: string | null, query = "") =>
      request(`/events/${key}/rsvp${query}`, "DELETE", as);

    const hits = async (userId: string): Promise<number> => {
      const [{ n }] =
        (await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${userId}`}`) as unknown as [
          { n: number },
        ];
      return n;
    };
    const rows = (eventId: number) => db.select().from(rsvps).where(eq(rsvps.eventId, eventId));
    const rowUsers = async (eventId: number) => (await rows(eventId)).map((r) => r.userId);

    async function seed(
      over: Partial<typeof events.$inferInsert> = {},
    ): Promise<{ id: number; key: string }> {
      const key = `01W9${Math.random().toString(36).slice(2, 14).toUpperCase()}`
        .padEnd(26, "0")
        .slice(0, 26)
        .replace(/[ILOU]/g, "7");
      const [row] = await db
        .insert(events)
        .values({
          eventKey: key,
          title: "Canonical key night",
          startsAt: new Date(Date.now() + 3600_000),
          endsAt: new Date(Date.now() + 2 * 3600_000),
          timezone: "UTC",
          location: "Voice",
          status: "published",
          ...over,
        })
        .returning();
      return { id: row!.id, key };
    }

    describe("non-canonical key spellings redirect before any lookup", () => {
      it("PUT a lowercase ULID 301s to the canonical RSVP URL, writes nothing, then succeeds there", async () => {
        const ev = await seed();
        const user = "lower-put";
        const moved = await put(ev.key.toLowerCase(), user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        // The redirect is not a write: no row, no budget spent, no sync queued.
        expect(await rows(ev.id)).toHaveLength(0);
        expect(await hits(user)).toBe(0);
        expect(sent).toHaveLength(0);

        const landed = await request(moved.headers.get("location")!, "PUT", user, {
          status: "going",
        });
        expect(landed.status).toBe(201);
        expect(await landed.json()).toEqual({
          data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
        });
        expect(await rowUsers(ev.id)).toEqual([user]);
      });

      it("PUT a mixed-case ULID 301s to the canonical RSVP URL and writes nothing", async () => {
        const ev = await seed();
        const user = "mixed-put";
        const spelling = mixedCase(ev.key);
        expect(spelling).not.toBe(ev.key);
        expect(spelling).not.toBe(ev.key.toLowerCase());
        const moved = await put(spelling, user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        expect(await rows(ev.id)).toHaveLength(0);
        expect(await hits(user)).toBe(0);
      });

      it("PUT a percent-encoded lowercase ULID 301s to the plain canonical RSVP URL in one hop", async () => {
        const ev = await seed();
        const moved = await put(encodedLower(ev.key), "encoded-put");
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("the canonical redirect preserves the query string", async () => {
        const ev = await seed();
        const moved = await put(ev.key.toLowerCase(), "query-put", "going", "?src=share");
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp?src=share`);
      });

      it("PUT a lowercase ULID redirects before auth: a guest gets 301, not 401, and nothing is written", async () => {
        const ev = await seed();
        const moved = await put(ev.key.toLowerCase(), null);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("PUT a lowercase ULID redirects before lookup even when no such event exists", async () => {
        const user = "lower-unknown-put";
        const moved = await put(UNKNOWN_KEY.toLowerCase(), user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${UNKNOWN_KEY}/rsvp`);
        expect(await hits(user)).toBe(0);
        // The canonical spelling then answers the ordinary not-found.
        const landed = await request(moved.headers.get("location")!, "PUT", user, {
          status: "going",
        });
        expect(landed.status).toBe(404);
        expect(await landed.json()).toEqual({ error: "not_found" });
      });

      it("PUT a lowercase ULID on a closed event redirects first; the canonical URL still refuses as closed", async () => {
        const ev = await seed({ status: "cancelled" });
        const user = "lower-closed-put";
        const moved = await put(ev.key.toLowerCase(), user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        const landed = await request(moved.headers.get("location")!, "PUT", user, {
          status: "going",
        });
        expect(landed.status).toBe(403);
        expect(await landed.json()).toMatchObject({ reason: "event_not_open", why: "cancelled" });
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("DELETE a lowercase ULID 301s to the canonical RSVP URL with the row intact, then deletes there", async () => {
        const ev = await seed();
        const user = "lower-delete";
        expect((await put(ev.key, user)).status).toBe(201);
        const hitsAfterPut = await hits(user);
        sent.length = 0;

        const moved = await del(ev.key.toLowerCase(), user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        // The redirect is not a withdrawal: the row survives, no budget spent.
        expect(await rowUsers(ev.id)).toEqual([user]);
        expect(await hits(user)).toBe(hitsAfterPut);
        expect(sent).toHaveLength(0);

        const landed = await request(moved.headers.get("location")!, "DELETE", user);
        expect(landed.status).toBe(204);
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("DELETE a mixed-case ULID 301s to the canonical RSVP URL with the row intact", async () => {
        const ev = await seed();
        const user = "mixed-delete";
        expect((await put(ev.key, user)).status).toBe(201);
        const moved = await del(mixedCase(ev.key), user);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        expect(await rowUsers(ev.id)).toEqual([user]);
      });

      it("DELETE a lowercase ULID redirects before auth: a guest gets 301, not 401, and the row survives", async () => {
        const ev = await seed();
        expect((await put(ev.key, "row-owner")).status).toBe(201);
        const moved = await del(ev.key.toLowerCase(), null);
        expect(moved.status).toBe(301);
        expect(moved.headers.get("location")).toBe(`/events/${ev.key}/rsvp`);
        expect(await rowUsers(ev.id)).toEqual(["row-owner"]);
      });
    });

    describe("DELETE answers honestly when it deletes nothing", () => {
      it("an existing event with no caller row answers 404 not_found, never an implied-withdrawal 204", async () => {
        const ev = await seed();
        const res = await del(ev.key, "never-answered");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
        expect(await rows(ev.id)).toHaveLength(0);
        expect(sent).toHaveLength(0);
      });

      it("only another member's row answers 404 and leaves that row untouched", async () => {
        const ev = await seed();
        expect((await put(ev.key, "someone-else")).status).toBe(201);
        const res = await del(ev.key, "not-the-owner");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
        expect(await rowUsers(ev.id)).toEqual(["someone-else"]);
      });

      it("a well-formed key naming no event answers 404 and spends no budget", async () => {
        const user = "unknown-delete";
        const res = await del(UNKNOWN_KEY, user);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
        expect(await hits(user)).toBe(0);
      });

      it("forged and malformed keys answer 404, never a redirect and never a quiet 204, and spend no budget", async () => {
        const user = "forged-delete";
        for (const key of ["not-a-key", BAD_ALPHABET_KEY, "seed-calendar-01"]) {
          const res = await del(key, user);
          expect(res.status, key).toBe(404);
          expect(res.headers.get("location"), key).toBeNull();
          expect(await res.json(), key).toEqual({ error: "not_found" });
        }
        expect(await hits(user)).toBe(0);
      });

      it("a second DELETE after a real withdrawal answers 404: the first 204 was the withdrawal", async () => {
        const ev = await seed();
        const user = "twice-delete";
        expect((await put(ev.key, user)).status).toBe(201);
        const first = await del(ev.key, user);
        expect(first.status).toBe(204);
        expect(await rows(ev.id)).toHaveLength(0);
        const second = await del(ev.key, user);
        expect(second.status).toBe(404);
        expect(await second.json()).toEqual({ error: "not_found" });
      });
    });

    describe("positive controls: canonical behavior is unchanged", () => {
      it("canonical PUT 201s, re-answer 200s, and canonical DELETE with a row 204s with the row gone", async () => {
        const ev = await seed();
        const user = "canonical-flow";
        const first = await put(ev.key, user, "going");
        expect(first.status).toBe(201);
        expect(first.headers.get("location")).toBeNull();
        const again = await put(ev.key, user, "maybe");
        expect(again.status).toBe(200);
        expect(await rows(ev.id)).toHaveLength(1);
        const gone = await del(ev.key, user);
        expect(gone.status).toBe(204);
        expect(await gone.text()).toBe("");
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("canonical PUT and DELETE still refuse guests with 401", async () => {
        const ev = await seed();
        expect((await put(ev.key, null)).status).toBe(401);
        expect((await del(ev.key, null)).status).toBe(401);
        expect(await rows(ev.id)).toHaveLength(0);
      });

      it("canonical PUT on an unknown or forged key still answers 404 not_found without redirecting", async () => {
        const user = "canonical-missing-put";
        for (const key of [UNKNOWN_KEY, BAD_ALPHABET_KEY, "not-a-key", "seed-calendar-01"]) {
          const res = await put(key, user);
          expect(res.status, key).toBe(404);
          expect(res.headers.get("location"), key).toBeNull();
          expect(await res.json(), key).toEqual({ error: "not_found" });
        }
      });

      it("canonical PUT still refuses an invalid status 422 and a closed event 403", async () => {
        const ev = await seed();
        const invalid = await put(ev.key, "bad-status", "definitely");
        expect(invalid.status).toBe(422);
        expect(await rows(ev.id)).toHaveLength(0);

        const closedEv = await seed({ rsvpOpen: false });
        const closed = await put(closedEv.key, "paused-put");
        expect(closed.status).toBe(403);
        expect(await closed.json()).toMatchObject({ reason: "event_not_open", why: "paused" });
        expect(await rows(closedEv.id)).toHaveLength(0);
      });

      it("honeypot PUT still answers the guest decoy 201 and writes nothing", async () => {
        const ev = await seed();
        const decoy = await request(`/events/${ev.key}/rsvp`, "PUT", null, {
          status: "going",
          [RSVP_HONEY_FIELD]: "http://spam.test",
        });
        expect(decoy.status).toBe(201);
        expect(await decoy.json()).toEqual({
          data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
        });
        expect(await rows(ev.id)).toHaveLength(0);
        expect(sent).toHaveLength(0);
      });

      it("honeypot DELETE still answers the decoy 204 and keeps the row it pretended to withdraw", async () => {
        const ev = await seed();
        const user = "decoy-delete";
        expect((await put(ev.key, user)).status).toBe(201);
        const decoy = await del(ev.key, user, `?${RSVP_HONEY_FIELD}=x`);
        expect(decoy.status).toBe(204);
        expect(await rowUsers(ev.id)).toEqual([user]);
      });

      it("honeypot DELETE with no caller row still answers the decoy 204, not the honest 404", async () => {
        const ev = await seed();
        const decoy = await del(ev.key, "decoy-no-row", `?${RSVP_HONEY_FIELD}=x`);
        expect(decoy.status).toBe(204);
        expect(await rows(ev.id)).toHaveLength(0);
      });
    });
  },
);
