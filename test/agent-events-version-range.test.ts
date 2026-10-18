// route-inventory: POST /api/agent-events
// Builder-owned int4 boundary regressions: an update `version` outside the
// PostgreSQL signed 32-bit integer range must take the existing 422
// validation_failed refusal before any event UPDATE runs, never a driver 500.
// Synthetic rows only, in an owned schema on the guarded test container.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { DEFAULT_CONFIG, INT4_MAX, INT4_MIN, isAgentVersion } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { clearAuditRows } from "./helpers/audit-rows";

const state = vi.hoisted(() => ({
  schema: "",
  clients: [] as { end: () => Promise<void> }[],
}));
// Keep the real mounted route, driver and SQL. Only pin request connections to
// the fixture's schema and the explicitly authorized empty test password.
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (url: string, options: Record<string, unknown> = {}) => {
      const safe = testDatabaseUrl(url);
      const client = original(url, {
        ...options,
        port: 5432,
        password: () => safe.password,
        ...(state.schema ? { connection: { search_path: state.schema }, onnotice: () => {} } : {}),
      });
      if (state.schema) state.clients.push(client);
      return client;
    },
  };
});

const CALLER = "version-range-test-agent";
const TOKEN = "synthetic-version-range-credential";
const FIELDS = {
  title: "Synthetic version range event",
  game: null,
  description: null,
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "UTC",
  location: "Synthetic voice",
  capacity: 1,
};

describe("update version int4 range (pure)", () => {
  it.each([INT4_MIN, INT4_MIN + 1, -1, 0, 1, 2, INT4_MAX - 1, INT4_MAX])(
    "accepts in-range integer %s",
    (version) => {
      expect(isAgentVersion(version)).toBe(true);
    },
  );

  it.each([
    INT4_MIN - 1,
    INT4_MAX + 1,
    Number.MAX_SAFE_INTEGER,
    1e20,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    "1",
    null,
    undefined,
    true,
    {},
  ])("rejects %s without touching the store", (version) => {
    expect(isAgentVersion(version)).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "update version int4 range (mounted route / SQL)",
  () => {
    let fixture: MemberDataFixture;
    let sql: MemberDataFixture["client"];
    let url: string;

    beforeAll(async () => {
      url = testDatabaseUrl(process.env.DATABASE_URL!).href;
      fixture = await createMemberDataFixture(url);
      sql = fixture.client;
      state.schema = fixture.schemaName;
    });
    beforeEach(async () => {
      await fixture.reset();
      await clearAuditRows(sql, ["agent_event_audits"]);
      await sql`DELETE FROM agent_event_grants`;
      await sql`DELETE FROM agent_event_hits`;
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'synthetic-company', ${DEFAULT_CONFIG.stagingGuildId}, ${await sha256Hex(TOKEN)})`;
    });
    afterAll(async () => {
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
      state.schema = "";
      await fixture?.dispose();
    });

    async function call(body: Record<string, unknown>) {
      const pending: Promise<unknown>[] = [];
      try {
        const response = await app.request(
          "/api/agent-events",
          {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          {
            APP_URL: "https://next.example.test",
            DATABASE_URL: url,
            AGENT_EVENTS_ENABLED: "true",
            AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
          } as never,
          {
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
            passThroughOnException: () => {},
          } as never,
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      } finally {
        await Promise.all(pending);
        await Promise.all(state.clients.splice(0).map((client) => client.end()));
      }
    }

    async function create(idempotencyKey = "version-range-seed") {
      const result = await call({
        op: "create",
        idempotency_key: idempotencyKey,
        fields: FIELDS,
      });
      expect(result.status).toBe(201);
      expect(result.body.event_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      return result.body.event_key as string;
    }

    async function expectDenial(
      result: Awaited<ReturnType<typeof call>>,
      status: number,
      reason: string,
      eventKey: string | null,
    ) {
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({
        reason,
        message: expect.any(String),
        request_id: expect.any(String),
      });
      expect(result.body).not.toHaveProperty("replayed");
      const rows =
        await sql`SELECT event_key, result, reason_code FROM agent_event_audits WHERE request_id = ${result.body.request_id as string}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event_key: eventKey, result: "denied", reason_code: reason });
    }

    it.each([INT4_MAX + 1, INT4_MIN - 1, Number.MAX_SAFE_INTEGER, 1e20])(
      "refuses out-of-range update version %s with 422 and no mutation",
      async (version) => {
        const eventKey = await create(`seed-${version}`);
        const before = await sql`SELECT * FROM events`;
        const refused = await call({
          op: "update",
          idempotency_key: `version-range-${version}`,
          event_key: eventKey,
          version,
          fields: FIELDS,
        });
        await expectDenial(refused, 422, "validation_failed", eventKey);
        // The submitted value is never echoed back: the body carries only the
        // reason, the standing message and the request id.
        expect(Object.keys(refused.body).sort()).toEqual(["message", "reason", "request_id"]);
        // No event mutation, no idempotency write and no write-back: the refusal
        // stores nothing, so only the seed create holds a key.
        expect(await sql`SELECT * FROM events`).toEqual(before);
        expect(await sql`SELECT key FROM agent_event_idempotency_keys`).toHaveLength(1);
        // A corrected payload under the same key still executes.
        const corrected = await call({
          op: "update",
          idempotency_key: `version-range-${version}`,
          event_key: eventKey,
          version: 1,
          fields: { ...FIELDS, title: "Corrected after range refusal" },
        });
        expect(corrected.status).toBe(200);
        expect(corrected.body).not.toHaveProperty("replayed");
        expect(corrected.body).toMatchObject({ agent_version: 2 });
      },
    );

    it.each([INT4_MIN, INT4_MAX])(
      "keeps in-range int4 limit %s on the existing stale path",
      async (version) => {
        const eventKey = await create(`seed-limit-${version}`);
        const before = await sql`SELECT * FROM events`;
        const stale = await call({
          op: "update",
          idempotency_key: `version-limit-${version}`,
          event_key: eventKey,
          version,
          fields: FIELDS,
        });
        // Inside int4 the value reaches the version comparison, not the 422:
        // the stored version (1) is echoed, never the submitted limit.
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 1 });
        expect(await sql`SELECT * FROM events`).toEqual(before);
      },
    );

    it("keeps current, stale and non-integer version behavior", async () => {
      const eventKey = await create("seed-controls");
      for (const version of [1.5, "1", null, undefined]) {
        const refused = await call({
          op: "update",
          idempotency_key: `version-control-${String(version)}`,
          event_key: eventKey,
          version: version as never,
          fields: FIELDS,
        });
        await expectDenial(refused, 422, "validation_failed", eventKey);
      }
      const current = await call({
        op: "update",
        idempotency_key: "version-control-current",
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, title: "Version range edit" },
      });
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({ agent_version: 2 });
      const stale = await call({
        op: "update",
        idempotency_key: "version-control-stale",
        event_key: eventKey,
        version: 1,
        fields: FIELDS,
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });
    });
  },
);
