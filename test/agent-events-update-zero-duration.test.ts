// Pins the exact zero-duration boundary of the agent update check.
//
// A minute-aligned stored window read back with `ends_at` set to its own
// start wall resolves to equal effective instants. That is a zero-length
// interval and must answer 422 with no write, version bump, success audit
// or write-back, so loosening the dispatch comparison from `<=` to `<`
// fails here. The sibling acceptance suite only reaches negative durations
// because its stored start carries sub-minute precision.
//
// Live only against the disposable test database fixture (throwaway
// schema); skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressEffects,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";

const CALLER = "zero-duration-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 1500 };
const BASE_FIELDS = {
  title: "Zero duration proof",
  game: "Chess",
  description: "Update zero-duration boundary proof",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 4,
};

// Minute-aligned BST window: wall 20:00 -> 22:00.
const ALIGNED_START = "2099-07-01T19:00:00.000Z";
const ALIGNED_END = "2099-07-01T21:00:00.000Z";

describe.skipIf(!process.env.DATABASE_URL)(
  "agent update refuses an exactly zero-length window (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let credential: string;
    const writeBack = vi.fn(async () => {});
    const effects = { writeBack } as unknown as IngressEffects;

    const call = (op: string, rest: Record<string, unknown> = {}): Promise<Answer> =>
      handleAgentEvent(
        fixture.client,
        cfg,
        { op, idempotency_key: randomUUID(), ...rest },
        credential,
        null,
        effects,
      );

    const seedPublished = async () => {
      const created = await call("create", { fields: BASE_FIELDS });
      expect(created.status).toBe(201);
      const event_key = created.body.event_key as string;
      await fixture.client`UPDATE events
        SET starts_at = ${ALIGNED_START}::timestamptz, ends_at = ${ALIGNED_END}::timestamptz
        WHERE event_key = ${event_key}`;
      expect((await call("publish", { event_key })).status).toBe(200);
      writeBack.mockClear();
      return event_key;
    };

    const storedRow = async (event_key: string) => {
      const [row] = await fixture.client`SELECT title, starts_at, ends_at, agent_version
        FROM events WHERE event_key = ${event_key}`;
      return {
        title: row!.title as string,
        startsAt: new Date(row!.starts_at).toISOString(),
        endsAt: new Date(row!.ends_at).toISOString(),
        agentVersion: row!.agent_version as number,
      };
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
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
      writeBack.mockClear();
      credential = `fixture-${randomUUID()}`;
      await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${await sha256Hex(credential)})`;
    });

    it("setting ends_at to the read start wall answers 422 and writes nothing", async () => {
      const event_key = await seedPublished();
      const read = await call("read", { event_key });
      expect(read.status).toBe(200);
      const event = read.body.event as Record<string, unknown>;
      expect(event).toMatchObject({ starts_at: "2099-07-01 20:00", ends_at: "2099-07-01 22:00" });
      const before = await storedRow(event_key);

      const refused = await call("update", {
        event_key,
        version: event.agent_version as number,
        fields: { ...event, title: "Must not land", ends_at: event.starts_at },
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ reason: "validation_failed" });
      expect(refused.body.errors).toHaveProperty("ends_at");

      expect(await storedRow(event_key)).toEqual(before);
      expect(writeBack).not.toHaveBeenCalled();
      const [audits] = await fixture.client`SELECT count(*)::int AS n FROM agent_event_audits
        WHERE event_key = ${event_key} AND operation = 'update' AND result = 'ok'`;
      expect(audits!.n).toBe(0);
    });
  },
);
