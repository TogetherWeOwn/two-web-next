// Acceptance: a valid stored interval survives a read -> non-time update
// round trip even when its minute-only wall serialization looks reversed
// or zero-length.
//
// Read serializes stored instants as wall text at minute precision. Two
// valid positive-duration stored windows therefore do not order as wall
// text:
//   - Europe/London autumn fold, 2099-10-25: 00:45:17.125Z (BST, wall
//     01:45) -> 01:15:43.875Z (GMT, wall 01:15) serializes as
//     01:45 -> 01:15, which reads as ends-before-starts;
//   - a sub-minute window 19:00:10.123Z -> 19:00:50.456Z serializes both
//     endpoints to the same wall minute, which reads as zero-length.
// An update that sends those read values back unchanged must be judged on
// the effective stored instants, not on the lexical order of the wall
// text, and must preserve both instants exactly (seconds, milliseconds
// and, at the fold, which occurrence an endpoint is).
//
// The production change that makes the RED tests pass: update no longer
// rejects `ends_at <= starts_at` as wall text before the stored row can
// be consulted; unchanged endpoints keep their stored instants and the
// duration judgement happens on the effective instants. Restoring an
// early lexical rejection ahead of that recovery must fail the RED tests
// below, while every control must keep passing: create stays strict on
// the same wall shapes, genuinely changed endpoints resolving to zero or
// negative duration still answer 422 with no version increment, no
// successful audit and no write-back, and ownership, optimistic version,
// gap validation and publish/cancel transitions are unchanged.
//
// Stored precise instants are seeded with a direct SQL update on an
// agent-created row (the agent create surface is minute-precision wall
// text, so it cannot mint them); everything after seeding goes through
// the public `handleAgentEvent` read/update flow. Live only against the
// disposable test database fixture (throwaway schema); skipped without
// DATABASE_URL.
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

const CALLER = "fold-roundtrip-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 1500 };
const BASE_FIELDS = {
  title: "Fold round-trip proof",
  game: "Chess",
  description: "Stored-instant preservation proof",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 4,
};

// Europe/London fold Sunday 2099-10-25 (verified with Intl): the start is
// the BST occurrence of wall 01:45, the end the GMT occurrence of 01:15.
const FOLD_START = "2099-10-25T00:45:17.125Z";
const FOLD_END = "2099-10-25T01:15:43.875Z";
// Positive 40-second window inside one BST wall minute (20:00).
const EQUAL_MINUTE_START = "2099-07-01T19:00:10.123Z";
const EQUAL_MINUTE_END = "2099-07-01T19:00:50.456Z";
// Ordinary window carrying sub-minute precision on both endpoints.
const PRECISE_START = "2099-07-01T19:00:27.125Z";
const PRECISE_END = "2099-07-01T21:00:44.875Z";

describe.skipIf(!process.env.DATABASE_URL)(
  "agent update preserves valid stored instants (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let credential: string;
    const writeBack = vi.fn(async () => {});
    const effects = { writeBack } as unknown as IngressEffects;

    const call = (
      op: string,
      rest: Record<string, unknown> = {},
      cred: string = credential,
    ): Promise<Answer> =>
      handleAgentEvent(
        fixture.client,
        cfg,
        { op, idempotency_key: randomUUID(), ...rest },
        cred,
        null,
        effects,
      );

    // Create one owned event through the agent surface, then move its
    // stored instants to the precise values under test.
    const seedOwned = async (startsIso: string, endsIso: string, publish = false) => {
      const created = await call("create", { fields: BASE_FIELDS });
      expect(created.status).toBe(201);
      const event_key = created.body.event_key as string;
      await fixture.client`UPDATE events
        SET starts_at = ${startsIso}::timestamptz, ends_at = ${endsIso}::timestamptz
        WHERE event_key = ${event_key}`;
      if (publish) {
        expect((await call("publish", { event_key })).status).toBe(200);
      }
      writeBack.mockClear();
      return event_key;
    };

    const readEvent = async (event_key: string) => {
      const read = await call("read", { event_key });
      expect(read.status).toBe(200);
      return read.body.event as Record<string, unknown>;
    };

    const storedRow = async (event_key: string) => {
      const [row] = await fixture.client`SELECT title, location, starts_at, ends_at,
        agent_version, status FROM events WHERE event_key = ${event_key}`;
      return {
        title: row!.title as string,
        location: row!.location as string,
        startsAt: new Date(row!.starts_at).toISOString(),
        endsAt: new Date(row!.ends_at).toISOString(),
        agentVersion: row!.agent_version as number,
        status: row!.status as string,
      };
    };

    const okUpdateAudits = async (event_key: string) =>
      (
        await fixture.client`SELECT count(*)::int AS n FROM agent_event_audits
          WHERE event_key = ${event_key} AND operation = 'update' AND result = 'ok'`
      )[0]!.n as number;

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

    describe("RED: unchanged endpoints are judged on stored instants, not wall text", () => {
      it("a published fold-spanning event survives a read -> title-only update with both instants exact", async () => {
        const event_key = await seedOwned(FOLD_START, FOLD_END, true);
        const event = await readEvent(event_key);
        // Premise: minute-only serialization really does invert the wall
        // order, and the end is the second (GMT) fold occurrence.
        expect(event).toMatchObject({
          starts_at: "2099-10-25 01:45",
          ends_at: "2099-10-25 01:15",
          timezone: "Europe/London",
        });
        const version = event.agent_version as number;

        const updated = await call("update", {
          event_key,
          version,
          fields: { ...event, title: "Renamed across the fold" },
        });
        expect(updated.status).toBe(200);
        expect(updated.body.agent_version).toBe(version + 1);

        const row = await storedRow(event_key);
        expect(row.title).toBe("Renamed across the fold");
        expect(row.startsAt).toBe(FOLD_START);
        expect(row.endsAt).toBe(FOLD_END);
        expect(row.agentVersion).toBe(version + 1);
        expect(row.status).toBe("published");
        expect(writeBack).toHaveBeenCalledTimes(1);
        expect(await okUpdateAudits(event_key)).toBe(1);
        expect((await readEvent(event_key)).title).toBe("Renamed across the fold");
      });

      it("a draft fold-spanning event survives a title-only update and still publishes", async () => {
        const event_key = await seedOwned(FOLD_START, FOLD_END);
        const event = await readEvent(event_key);
        const version = event.agent_version as number;

        const updated = await call("update", {
          event_key,
          version,
          fields: { ...event, title: "Draft renamed across the fold" },
        });
        expect(updated.status).toBe(200);
        expect(writeBack).not.toHaveBeenCalled();

        const row = await storedRow(event_key);
        expect(row.startsAt).toBe(FOLD_START);
        expect(row.endsAt).toBe(FOLD_END);
        expect(row.agentVersion).toBe(version + 1);

        expect((await call("publish", { event_key })).status).toBe(200);
        expect((await storedRow(event_key)).status).toBe("published");
        expect((await storedRow(event_key)).startsAt).toBe(FOLD_START);
        expect((await storedRow(event_key)).endsAt).toBe(FOLD_END);
      });

      it("an equal-minute positive-duration window survives a non-time edit with both instants exact", async () => {
        const event_key = await seedOwned(EQUAL_MINUTE_START, EQUAL_MINUTE_END, true);
        const event = await readEvent(event_key);
        // Premise: both endpoints serialize to the same wall minute.
        expect(event).toMatchObject({
          starts_at: "2099-07-01 20:00",
          ends_at: "2099-07-01 20:00",
        });
        const version = event.agent_version as number;

        const updated = await call("update", {
          event_key,
          version,
          fields: { ...event, location: "Voice: Stage" },
        });
        expect(updated.status).toBe(200);
        expect(updated.body.agent_version).toBe(version + 1);

        const row = await storedRow(event_key);
        expect(row.location).toBe("Voice: Stage");
        expect(row.startsAt).toBe(EQUAL_MINUTE_START);
        expect(row.endsAt).toBe(EQUAL_MINUTE_END);
        expect(row.agentVersion).toBe(version + 1);
        expect(writeBack).toHaveBeenCalledTimes(1);
        expect(await okUpdateAudits(event_key)).toBe(1);
      });
    });

    describe("controls: strictness and neighbouring behaviour are unchanged", () => {
      it("an ordinary window keeps its sub-minute precision through a title-only update", async () => {
        const event_key = await seedOwned(PRECISE_START, PRECISE_END, true);
        const event = await readEvent(event_key);
        expect(event).toMatchObject({
          starts_at: "2099-07-01 20:00",
          ends_at: "2099-07-01 22:00",
        });

        const updated = await call("update", {
          event_key,
          version: event.agent_version as number,
          fields: { ...event, title: "Precise window renamed" },
        });
        expect(updated.status).toBe(200);
        const row = await storedRow(event_key);
        expect(row.startsAt).toBe(PRECISE_START);
        expect(row.endsAt).toBe(PRECISE_END);
      });

      it("a genuinely changed end on a fold-spanning event resolves fresh while the unchanged start stays exact", async () => {
        const event_key = await seedOwned(FOLD_START, FOLD_END, true);
        const event = await readEvent(event_key);

        const updated = await call("update", {
          event_key,
          version: event.agent_version as number,
          fields: { ...event, ends_at: "2099-10-25 02:15" },
        });
        expect(updated.status).toBe(200);
        const row = await storedRow(event_key);
        // Unchanged BST start keeps its exact instant; the changed end is
        // the unambiguous GMT wall 02:15.
        expect(row.startsAt).toBe(FOLD_START);
        expect(row.endsAt).toBe("2099-10-25T02:15:00.000Z");
      });

      it("changed endpoints resolving to zero or negative duration answer 422 with no write, version bump, success audit or write-back", async () => {
        const event_key = await seedOwned(PRECISE_START, PRECISE_END, true);
        const event = await readEvent(event_key);
        const version = event.agent_version as number;
        const before = await storedRow(event_key);

        for (const ends_at of ["2099-07-01 20:00", "2099-07-01 19:30"]) {
          const refused = await call("update", {
            event_key,
            version,
            fields: { ...event, title: "Must not land", ends_at },
          });
          expect(refused.status).toBe(422);
          expect(refused.body).toMatchObject({ reason: "validation_failed" });
          expect(refused.body.errors).toHaveProperty("ends_at");
        }

        expect(await storedRow(event_key)).toEqual(before);
        expect(writeBack).not.toHaveBeenCalled();
        expect(await okUpdateAudits(event_key)).toBe(0);
      });

      it("create stays strict: equal, reversed and fold-reversed wall windows create nothing", async () => {
        const shapes = [
          { starts_at: "2099-07-01 20:00", ends_at: "2099-07-01 20:00" },
          { starts_at: "2099-07-01 22:00", ends_at: "2099-07-01 20:00" },
          // Fresh fold walls resolve to the second (GMT) occurrence, so
          // this pair is a negative interval on create even though the
          // same text is a valid *stored* window on update.
          { starts_at: "2099-10-25 01:45", ends_at: "2099-10-25 01:15" },
        ];
        for (const shape of shapes) {
          const refused = await call("create", { fields: { ...BASE_FIELDS, ...shape } });
          expect(refused.status).toBe(422);
          expect(refused.body.errors).toHaveProperty("ends_at");
        }
        expect((await fixture.client`SELECT count(*)::int AS n FROM events`)[0]!.n).toBe(0);
        expect(writeBack).not.toHaveBeenCalled();
      });

      it("a changed start inside the spring gap still answers 422 and writes nothing", async () => {
        const event_key = await seedOwned(PRECISE_START, PRECISE_END, true);
        const event = await readEvent(event_key);
        const before = await storedRow(event_key);

        const refused = await call("update", {
          event_key,
          version: event.agent_version as number,
          fields: { ...event, starts_at: "2030-03-31 01:30", ends_at: "2030-03-31 03:30" },
        });
        expect(refused.status).toBe(422);
        expect(refused.body.errors).toHaveProperty("starts_at");
        expect(await storedRow(event_key)).toEqual(before);
        expect(writeBack).not.toHaveBeenCalled();
        expect(await okUpdateAudits(event_key)).toBe(0);
      });

      it("optimistic version still gates updates: a stale version answers 409 and writes nothing", async () => {
        const event_key = await seedOwned(PRECISE_START, PRECISE_END, true);
        const event = await readEvent(event_key);
        const version = event.agent_version as number;
        const before = await storedRow(event_key);

        const stale = await call("update", {
          event_key,
          version: version + 5,
          fields: { ...event, title: "Must not land" },
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: version });
        expect(await storedRow(event_key)).toEqual(before);
        expect(writeBack).not.toHaveBeenCalled();
        expect(await okUpdateAudits(event_key)).toBe(0);
      });

      it("grant ownership still gates updates: another grant answers 403 and writes nothing", async () => {
        const event_key = await seedOwned(PRECISE_START, PRECISE_END, true);
        const event = await readEvent(event_key);
        const before = await storedRow(event_key);
        const foreignCredential = `fixture-foreign-${randomUUID()}`;
        await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
          VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${await sha256Hex(foreignCredential)})`;

        const foreign = await call(
          "update",
          {
            event_key,
            version: event.agent_version as number,
            fields: { ...event, title: "Must not land" },
          },
          foreignCredential,
        );
        expect(foreign.status).toBe(403);
        expect(foreign.body).toMatchObject({ reason: "foreign_event" });
        expect(await storedRow(event_key)).toEqual(before);
        expect(writeBack).not.toHaveBeenCalled();
        expect(await okUpdateAudits(event_key)).toBe(0);
      });

      it("a fold-spanning draft still publishes and cancels, keeping its stored instants", async () => {
        const event_key = await seedOwned(FOLD_START, FOLD_END);
        expect((await call("publish", { event_key })).status).toBe(200);
        expect(writeBack).toHaveBeenCalledTimes(1);
        expect((await storedRow(event_key)).status).toBe("published");

        writeBack.mockClear();
        expect((await call("cancel", { event_key })).status).toBe(200);
        expect(writeBack).toHaveBeenCalledTimes(1);
        const row = await storedRow(event_key);
        expect(row.status).toBe("cancelled");
        expect(row.startsAt).toBe(FOLD_START);
        expect(row.endsAt).toBe(FOLD_END);
      });
    });
  },
);
