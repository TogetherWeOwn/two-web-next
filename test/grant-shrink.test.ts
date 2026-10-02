// route-inventory: POST /api/agent-events
// TOG-12102: agent-grant-owned capacity shrink floor (ledger W15 A2, EventCapacityFloorTest line 82).
//
// The occupied-seat floor was proved for JSON/admin moderator edits
// (test/event-mutation-invariants.test.ts); this suite proves the grant-owned
// path refuses the same shrink. Grant proof events live on the shared `events`
// rows, so real Going rsvps attach to `events.id` and the grant `update` floor
// (`goingCount` behind the row lock) applies.
//
// Contract note: the grant path returns the shared CAPACITY_BELOW_GOING text
// exactly; unlike the admin store it does not append the occupied-seat count.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressEffects } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { CAPACITY_BELOW_GOING } from "../src/events/waitlist";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const CALLER = "grant-shrink-agent";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 2000 };
const FIELDS = {
  title: "Synthetic grant event",
  game: null,
  description: null,
  starts_at: "2099-10-01 20:00",
  ends_at: "2099-10-01 22:00",
  timezone: "UTC",
  location: "Synthetic voice",
};

describe.skipIf(!process.env.DATABASE_URL)(
  "agent-grant capacity shrink floor (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let credential: string;
    const dispatched: unknown[] = [];
    const effects: IngressEffects = {
      writeBack: async (wb) => {
        dispatched.push(wb);
      },
    };

    const call = (op: string, rest: Record<string, unknown> = {}) =>
      handleAgentEvent(
        fixture.client,
        cfg,
        { op, idempotency_key: randomUUID(), ...rest },
        credential,
        null,
        effects,
      );
    const create = async (capacity: number | null = 8) => {
      const result = await call("create", { fields: { ...FIELDS, capacity } });
      expect(result.status).toBe(201);
      return result.body.event_key as string;
    };
    const eventId = async (eventKey: string) =>
      (await fixture.client`SELECT id FROM events WHERE event_key = ${eventKey}`)[0]!.id as number;
    const occupy = (id: number, n: number, prefix: string) =>
      fixture.db.insert(rsvps).values(
        Array.from({ length: n }, (_, i) => ({
          eventId: id,
          userId: `${prefix}-${i}`,
          status: "going",
        })),
      );
    const snapshot = async (eventKey: string, id: number) => ({
      event:
        await fixture.client`SELECT event_key, capacity, agent_version, status FROM events WHERE event_key = ${eventKey}`,
      answers: await fixture.client`SELECT count(*)::int AS n FROM rsvps WHERE event_id = ${id}`,
      stored:
        await fixture.client`SELECT count(*)::int AS n FROM agent_event_idempotency_keys WHERE event_key = ${eventKey}`,
    });

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 8 });
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`DELETE FROM agent_event_idempotency_keys`;
      await clearAuditRows(fixture.client, ["agent_event_audits"]);
      await fixture.client`DELETE FROM agent_event_hits`;
      await fixture.client`DELETE FROM agent_event_grants`;
      dispatched.length = 0;
      credential = `fixture-${randomUUID()}`;
      await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${await sha256Hex(credential)})`;
    });

    it("refuses a grant-driven shrink below Going: 422, rows unchanged, no write-back", async () => {
      const eventKey = await create(8);
      const id = await eventId(eventKey);
      await occupy(id, 5, "seat");
      const before = await snapshot(eventKey, id);
      const shrunk = await call("update", {
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, capacity: 2 },
      });
      expect(shrunk.status).toBe(422);
      expect(shrunk.body).toMatchObject({
        reason: "validation_failed",
        errors: { capacity: [CAPACITY_BELOW_GOING] },
      });
      expect(shrunk.body).not.toHaveProperty("replayed");
      expect(await snapshot(eventKey, id)).toEqual(before);
      const denials =
        await fixture.client`SELECT result, reason_code FROM agent_event_audits WHERE request_id = ${shrunk.body.request_id as string}`;
      expect(denials).toEqual([{ result: "denied", reason_code: "validation_failed" }]);
      expect(dispatched).toEqual([]);
    });

    it("accepts equal, higher and unlimited grant edits", async () => {
      const eventKey = await create(8);
      await occupy(await eventId(eventKey), 5, "seat");
      for (const [version, capacity] of [
        [1, 8],
        [2, 10],
        [3, null],
      ] as const) {
        const updated = await call("update", {
          event_key: eventKey,
          version,
          fields: { ...FIELDS, capacity },
        });
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({ event_key: eventKey, agent_version: version + 1 });
      }
      expect(
        await fixture.client`SELECT capacity, agent_version FROM events WHERE event_key = ${eventKey}`,
      ).toEqual([{ capacity: null, agent_version: 4 }]);
    });

    it("a stale grant version loses to the committed winner (no lost update)", async () => {
      const eventKey = await create(8);
      const winner = await call("update", {
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, title: "Winner" },
      });
      expect(winner.status).toBe(200);
      const stale = await call("update", {
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, title: "Stale" },
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });
      expect(
        await fixture.client`SELECT title, agent_version FROM events WHERE event_key = ${eventKey}`,
      ).toEqual([{ title: "Winner", agent_version: 2 }]);
    });

    it("recounts behind the lock: an edit queued behind a new Going seat cannot strand it", async () => {
      const eventKey = await create(8);
      const id = await eventId(eventKey);
      await occupy(id, 5, "seat");
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holder = fixture.client.begin(async (tx) => {
        await tx`SELECT id FROM events WHERE id = ${id} FOR UPDATE`;
        await tx`INSERT INTO rsvps (event_id, user_id, status) VALUES (${id}, 'concurrent-member', 'going')`;
        ready();
        await held;
      });
      await Promise.race([locked, holder]);
      const pending = call("update", {
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, capacity: 5 },
      });
      // Let the edit queue on the held row lock, then commit the sixth seat first.
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await holder;
      const result = await pending;
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        reason: "validation_failed",
        errors: { capacity: [CAPACITY_BELOW_GOING] },
      });
      expect(
        await fixture.client`SELECT capacity, agent_version FROM events WHERE event_key = ${eventKey}`,
      ).toEqual([{ capacity: 8, agent_version: 1 }]);
    });

    it("the mounted route refuses the shrink end to end", async () => {
      const eventKey = await create(8);
      await occupy(await eventId(eventKey), 5, "seat");
      const sent: SyncMessage[] = [];
      const env = {
        APP_URL: "https://next.example.test",
        SESSION_SECRET: "fixture-session-secret-long-enough-for-tests",
        DISCORD_CLIENT_ID: "fixture",
        DISCORD_GUILD_ID: cfg.stagingGuildId,
        DISCORD_INVITE_URL: "https://discord.gg/fixture",
        DISCORD_CLIENT_SECRET: "fixture",
        DISCORD_BOT_TOKEN: "fixture",
        AGENT_EVENTS_ENABLED: "true",
        AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
        AGENT_EVENT_SQL: fixture.client,
        ADMIN_DB: fixture.db,
        SESSION_STORE: createMemorySessionStore(),
        EVENT_SYNC_QUEUE: {
          send: async (message: SyncMessage) => {
            sent.push(message);
          },
        },
      } as unknown as Env;
      const response = await app.request(
        "/api/agent-events",
        {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({
            op: "update",
            idempotency_key: randomUUID(),
            event_key: eventKey,
            version: 1,
            fields: { ...FIELDS, capacity: 2 },
          }),
        },
        env,
      );
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        reason: "validation_failed",
        errors: { capacity: [CAPACITY_BELOW_GOING] },
      });
      expect(sent).toEqual([]);
    });
  },
);
