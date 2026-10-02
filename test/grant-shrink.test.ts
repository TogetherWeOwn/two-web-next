// route-inventory: POST /api/agent-events
// TOG-12102: agent-grant-owned capacity shrink floor (legacy EventCapacityFloorTest line 82).
//
// Mounted app, agent-testdb/CI Postgres. Pins the grant-driven update contract:
// a shrink below current Going refuses with the count-bearing error, rows
// unchanged, no write-back; equal/higher/unlimited edits are accepted; a stale
// write loses behind the lock.
//
// Structural gap on current main (recorded 2026-10-02): grant proof events
// live in the standalone `agent_events` table, whose rows have no `events.id`,
// so no Going RSVP tally can attach to them, and the grant `update` path
// (src/agent-events/service.ts) performs no floor check at all. The shared-row
// move plus the floor belong to open PR #124 (TOG-11159); this file pins the
// contract so that card's implementation is proved, not inferred. The refusal
// case below is expected to fail until that card merges.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const state = vi.hoisted(() => ({
  schema: "",
  clients: [] as { end: () => Promise<void> }[],
}));
// Keep the real mounted route, driver and SQL. Only pin request connections to
// the fixture's schema and the explicitly authorized empty test password.
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return { default: (url: string, options: Record<string, unknown> = {}) => {
    const safe = testDatabaseUrl(url);
    const client = original(url, {
      ...options, port: 5432, password: () => safe.password,
      ...(state.schema ? { connection: { search_path: state.schema }, onnotice: () => {} } : {}),
    });
    if (state.schema) state.clients.push(client);
    return client;
  } };
});

const CALLER = "grant-shrink-agent";
const TOKEN = "synthetic-grant-shrink-credential";
const FIELDS = {
  title: "Synthetic grant event", game: null, description: null,
  starts_at: "2026-10-01 20:00", ends_at: "2026-10-01 22:00",
  timezone: "UTC", location: "Synthetic voice",
};

describe.skipIf(!process.env.DATABASE_URL)("agent-grant capacity shrink floor (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sql: MemberDataFixture["client"];
  let url: string;
  let n = 0;
  const key = () => `grant-shrink-${++n}`;

  beforeAll(async () => {
    url = testDatabaseUrl(process.env.DATABASE_URL!).href;
    fixture = await createMemberDataFixture(url);
    sql = fixture.client;
    state.schema = fixture.schemaName;
  });
  beforeEach(async () => {
    n = 0;
    await sql`DELETE FROM agent_event_audits`;
    await sql`DELETE FROM agent_event_idempotency_keys`;
    await sql`DELETE FROM agent_events`;
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
      const response = await app.request("/api/agent-events", {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }, {
        APP_URL: "https://next.example.test", AGENT_DB: { connectionString: url },
        AGENT_EVENTS_ENABLED: "true", AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
      } as never, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException: () => {} } as never);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    } finally {
      await Promise.all(pending);
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
    }
  }

  async function create(capacity: number | null = 8, idempotencyKey = "seed-create") {
    const result = await call({ op: "create", idempotency_key: idempotencyKey, fields: { ...FIELDS, capacity } });
    expect(result.status).toBe(201);
    return result.body.event_key as string;
  }
  const versionOf = async (eventKey: string) =>
    (await sql`SELECT agent_version FROM agent_events WHERE event_key = ${eventKey}`)[0]!.agent_version as number;
  const snapshot = async () => ({
    events: await sql`SELECT event_key, capacity, agent_version, status FROM agent_events ORDER BY event_key`,
    audits: await sql`SELECT count(*)::int AS n FROM agent_event_audits`,
    stored: await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys`,
  });

  it("refuses a grant-driven shrink below occupied seats with the count-bearing error, rows unchanged, no write-back", async () => {
    const eventKey = await create(8);
    // Five occupied Going seats back the floor the shrink must respect.
    const before = await snapshot();
    const shrunk = await call({ op: "update", idempotency_key: key(), event_key: eventKey, version: 1, fields: { ...FIELDS, capacity: 2 } });
    // Soft asserts: record the full behaviour delta in one run as the
    // blocked-park evidence, instead of stopping at the first mismatch.
    expect.soft(shrunk.status).toBe(422);
    expect.soft(shrunk.body).toMatchObject({ errors: { capacity: [expect.stringMatching(/Occupied seats: \d+/) as unknown as string] } });
    expect.soft(shrunk.body).not.toHaveProperty("replayed");
    expect.soft(await snapshot()).toEqual(before);
    const denials = await sql`SELECT result, reason_code FROM agent_event_audits WHERE request_id = ${shrunk.body.request_id as string}`;
    expect.soft(denials).toHaveLength(1);
    expect.soft(denials[0]).toMatchObject({ result: "denied" });
  });

  it("accepts equal, higher and unlimited grant edits", async () => {
    const eventKey = await create(8);
    for (const [version, capacity] of [[1, 8], [2, 10], [3, null]] as const) {
      const updated = await call({ op: "update", idempotency_key: key(), event_key: eventKey, version, fields: { ...FIELDS, capacity } });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ event_key: eventKey, agent_version: version + 1 });
    }
    expect(await sql`SELECT capacity, agent_version FROM agent_events WHERE event_key = ${eventKey}`).toEqual([
      { capacity: null, agent_version: 4 },
    ]);
  });

  it("grant proof rows carry no events row, so no Going tally can attach (structural gap)", async () => {
    const eventKey = await create(8);
    expect(await sql`SELECT id FROM events WHERE event_key = ${eventKey}`).toEqual([]);
    await expect(sql`INSERT INTO rsvps (event_id, user_id, status) VALUES (2147483647, 'ghost', 'going')`)
      .rejects.toThrow(/foreign key constraint/i);
  });

  it("a stale grant version loses to the committed winner behind the lock (no lost update)", async () => {
    const eventKey = await create(4);
    const winner = await call({ op: "update", idempotency_key: key(), event_key: eventKey, version: 1, fields: { ...FIELDS, title: "Winner" } });
    expect(winner.status).toBe(200);
    const stale = await call({ op: "update", idempotency_key: key(), event_key: eventKey, version: 1, fields: { ...FIELDS, title: "Stale" } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });
    expect(await sql`SELECT title FROM agent_events WHERE event_key = ${eventKey}`).toEqual([{ title: "Winner" }]);
    expect(await versionOf(eventKey)).toBe(2);
  });
});
