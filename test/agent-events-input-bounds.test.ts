// route-inventory: POST /api/agent-events
// Synthetic rows only, in an owned schema on the guarded test container.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { parseEventForm, ValidationError } from "../src/admin/validation";
import { DEFAULT_CONFIG, validateFields } from "../src/agent-events/service";
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

const MAX_CAPACITY = 2147483647;
const CALLER = "bounds-test-agent";
const TOKEN = "synthetic-bounds-credential";
const FIELDS = {
  title: "Synthetic bounds event",
  game: null,
  description: null,
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "UTC",
  location: "Synthetic voice",
  capacity: 1,
};

// At the varchar boundary, missing keys still get a bounded receipt. Overwide
// keys and invalid PostgreSQL text must never become a truncated event identity.
const UNKNOWN_KEYS = [
  { label: "25 characters", key: "Z".repeat(25), auditKey: "Z".repeat(25) },
  { label: "26 characters", key: "Z".repeat(26), auditKey: "Z".repeat(26) },
  { label: "27 characters", key: "Z".repeat(27), auditKey: null },
  { label: "4096 characters", key: "Z".repeat(4096), auditKey: null },
  { label: "NUL", key: "Z\u0000", auditKey: null },
  { label: "lone surrogate", key: "Z\ud800", auditKey: null },
  { label: "empty string", key: "", auditKey: null },
  { label: "non-string", key: 123, auditKey: null },
];

describe("machine capacity bounds (pure)", () => {
  it.each([1, MAX_CAPACITY, null, undefined])(
    "accepts %s without changing unlimited capacity",
    (capacity) => {
      const result = validateFields({ ...FIELDS, capacity });
      expect(result).toMatchObject({ ok: true, fields: { capacity: capacity ?? null } });
    },
  );

  it.each([0, -1, 1.5, MAX_CAPACITY + 1, Number.MAX_SAFE_INTEGER, 1e20, Infinity, NaN, "1"])(
    "rejects %s",
    (capacity) => {
      expect(validateFields({ ...FIELDS, capacity })).toMatchObject({
        ok: false,
        errors: { capacity: [expect.any(String)] },
      });
    },
  );
});

describe("machine control and bidi character rules (pure)", () => {
  it.each(["title", "description", "location"] as const)(
    "rejects NUL in %s with the field named",
    (field) => {
      expect(validateFields({ ...FIELDS, [field]: "Game\u0000night" })).toMatchObject({
        ok: false,
        errors: { [field]: [expect.any(String)] },
      });
    },
  );

  it.each(["title", "description", "location"] as const)(
    "rejects a U+202E bidi override in %s with the field named",
    (field) => {
      expect(validateFields({ ...FIELDS, [field]: "Game\u202enight" })).toMatchObject({
        ok: false,
        errors: { [field]: [expect.any(String)] },
      });
    },
  );

  it.each([
    ["title", "   "],
    ["location", " \t "],
  ] as const)("rejects whitespace-only %s as missing", (field, value) => {
    expect(validateFields({ ...FIELDS, [field]: value })).toMatchObject({
      ok: false,
      errors: { [field]: [`The ${field} field is required.`] },
    });
  });

  it("accepts a newline in description", () => {
    const description = "Line one\nLine two";
    expect(validateFields({ ...FIELDS, description })).toMatchObject({
      ok: true,
      fields: { description },
    });
  });

  it("accepts a genuine emoji ZWJ sequence in title", () => {
    const title = "👩‍💻 game night";
    expect(validateFields({ ...FIELDS, title })).toMatchObject({ ok: true, fields: { title } });
  });

  it("leaves a whitespace-only game null, like the human form", () => {
    expect(validateFields({ ...FIELDS, game: "   " })).toMatchObject({
      ok: true,
      fields: { game: null },
    });
  });

  it("stores a padded title trimmed", () => {
    expect(validateFields({ ...FIELDS, title: "  Game night  " })).toMatchObject({
      ok: true,
      fields: { title: "Game night" },
    });
  });

  it("measures the length limit on the trimmed title", () => {
    const padded = `  ${"G".repeat(100)}  `;
    expect(validateFields({ ...FIELDS, title: padded })).toMatchObject({
      ok: true,
      fields: { title: "G".repeat(100) },
    });
  });
});

describe("human/machine shared-field parity (pure)", () => {
  const cases: Array<{
    label: string;
    field: "title" | "description" | "location";
    value: string;
  }> = [
    { label: "NUL in title", field: "title", value: "Game\u0000night" },
    { label: "NUL in description", field: "description", value: "Game\u0000night" },
    { label: "NUL in location", field: "location", value: "Game\u0000night" },
    { label: "U+202E in title", field: "title", value: "Game\u202enight" },
    { label: "U+202E in description", field: "description", value: "Game\u202enight" },
    { label: "U+202E in location", field: "location", value: "Game\u202enight" },
    { label: "leading BOM in title", field: "title", value: "\uFEFFGame" },
    { label: "trailing BOM in title", field: "title", value: "Game\uFEFF" },
    { label: "leading BOM in description", field: "description", value: "\uFEFFGame" },
    { label: "trailing BOM in description", field: "description", value: "Game\uFEFF" },
    { label: "leading BOM in location", field: "location", value: "\uFEFFGame" },
    { label: "trailing BOM in location", field: "location", value: "Game\uFEFF" },
    { label: "zero-width space in title", field: "title", value: "\u200bGame" },
    { label: "whitespace-only title", field: "title", value: "   " },
    // No whitespace-only location row: the machine ingress requires location
    // while the human form leaves it optional, a deliberate pre-existing
    // divergence outside this change (covered by the required-check test above).
    { label: "whitespace-only description", field: "description", value: "  " },
    { label: "newline in description", field: "description", value: "Line one\nLine two" },
    { label: "tab inside title", field: "title", value: "Game\tnight" },
    { label: "emoji ZWJ in title", field: "title", value: "👩‍💻 game night" },
    { label: "emoji ZWJ in description", field: "description", value: "👩‍💻 workshop" },
    { label: "plain title", field: "title", value: "Game night" },
  ];
  it.each(cases)("$label: parseEventForm and validateFields agree", ({ field, value }) => {
    let humanFields: Record<string, string> | null = null;
    try {
      parseEventForm({ ...FIELDS, [field]: value });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      humanFields = error.fields;
    }
    const machine = validateFields({ ...FIELDS, [field]: value });
    if (humanFields === null) {
      if (!machine.ok) expect(Object.keys(machine.errors)).not.toContain(field);
    } else {
      expect(Object.keys(humanFields)).toEqual([field]);
      expect(machine.ok).toBe(false);
      if (machine.ok === false) expect(Object.keys(machine.errors)).toEqual([field]);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("machine input bounds (mounted route / SQL)", () => {
  let fixture: MemberDataFixture;
  let sql: MemberDataFixture["client"];
  let url: string;
  let grantId: string;

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
    const [grant] =
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'synthetic-company', ${DEFAULT_CONFIG.stagingGuildId}, ${await sha256Hex(TOKEN)}) RETURNING id`;
    grantId = grant!.id as string;
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
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } finally {
      await Promise.all(pending);
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
    }
  }

  async function create(capacity: number | null = 1, idempotencyKey = "seed-create") {
    const result = await call({
      op: "create",
      idempotency_key: idempotencyKey,
      fields: { ...FIELDS, capacity },
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

  it.each([1, MAX_CAPACITY, null])(
    "persists and updates representable capacity %s",
    async (capacity) => {
      const eventKey = await create(capacity);
      expect(
        (await sql`SELECT capacity FROM events WHERE event_key = ${eventKey}`)[0]!.capacity,
      ).toBe(capacity);
      const updated = await call({
        op: "update",
        idempotency_key: "valid-update",
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, capacity },
      });
      expect(updated.status).toBe(200);
      expect(
        (await sql`SELECT capacity, agent_version FROM events WHERE event_key = ${eventKey}`)[0],
      ).toMatchObject({ capacity, agent_version: 2 });
    },
  );

  for (const op of ["create", "update"] as const) {
    it.each([MAX_CAPACITY + 1, Number.MAX_SAFE_INTEGER, 1e20])(
      `${op} audits oversized capacity %s without mutation or replay; corrected payload reuses the key`,
      async (capacity) => {
        const eventKey = op === "update" ? await create() : null;
        const before = await sql`SELECT * FROM events`;
        const request = {
          op,
          idempotency_key: "capacity-retry",
          ...(eventKey ? { event_key: eventKey, version: 1 } : {}),
        };
        const rejected = await call({ ...request, fields: { ...FIELDS, capacity } });
        await expectDenial(rejected, 422, "validation_failed", eventKey);
        expect(rejected.body.errors).toMatchObject({ capacity: [expect.any(String)] });
        expect(await sql`SELECT * FROM events`).toEqual(before);
        expect(
          await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'capacity-retry'`,
        ).toHaveLength(0);
        const corrected = await call({ ...request, fields: { ...FIELDS, capacity: MAX_CAPACITY } });
        expect(corrected.status).toBe(op === "create" ? 201 : 200);
        expect(corrected.body).not.toHaveProperty("replayed");
        expect(
          await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'capacity-retry'`,
        ).toHaveLength(1);
        expect((await sql`SELECT capacity FROM events`)[0]!.capacity).toBe(MAX_CAPACITY);
      },
    );
  }

  for (const op of ["read", "update", "publish", "cancel"] as const) {
    it.each(UNKNOWN_KEYS)(
      `${op} returns audited 404 for $label without storing success`,
      async ({ key, auditKey }) => {
        const before = await sql`SELECT * FROM events`;
        const rejected = await call({
          op,
          idempotency_key: "key-retry",
          event_key: key,
          version: 1,
          fields: FIELDS,
        });
        await expectDenial(rejected, 404, "event_not_found", auditKey);
        expect(await sql`SELECT * FROM events`).toEqual(before);
        expect(await sql`SELECT key FROM agent_event_idempotency_keys`).toHaveLength(0);
      },
    );

    it(`${op} does not truncate a real key plus suffix and allows retry with the owned 26-character key`, async () => {
      const eventKey = await create();
      const before = await sql`SELECT * FROM events`;
      const request = { op, idempotency_key: "owned-retry", version: 1, fields: FIELDS };
      const rejected = await call({ ...request, event_key: eventKey + "Z" });
      await expectDenial(rejected, 404, "event_not_found", null);
      expect(await sql`SELECT * FROM events`).toEqual(before);
      expect(
        await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'owned-retry'`,
      ).toHaveLength(0);
      const corrected = await call({ ...request, event_key: eventKey });
      expect(corrected.status).toBe(200);
      expect(corrected.body).not.toHaveProperty("replayed");
      expect(
        await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'owned-retry'`,
      ).toHaveLength(1);
    });
  }

  it("still denies a valid 26-character key owned by another grant, with its identity intact in the audit", async () => {
    const eventKey = await create();
    const [other] =
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'synthetic-company', ${DEFAULT_CONFIG.stagingGuildId}, ${await sha256Hex("synthetic-other")}) RETURNING id`;
    await sql`UPDATE events SET agent_grant_id = ${other!.id} WHERE event_key = ${eventKey}`;
    const denied = await call({ op: "cancel", idempotency_key: "foreign", event_key: eventKey });
    await expectDenial(denied, 403, "foreign_event", eventKey);
    expect((await sql`SELECT status FROM events WHERE event_key = ${eventKey}`)[0]!.status).toBe(
      "draft",
    );
  });

  it.each([undefined, null])(
    "keeps the omitted/null key fallback (%s) on the grant's owned event",
    async (event_key) => {
      const eventKey = await create();
      const read = await call({ op: "read", idempotency_key: "fallback", event_key });
      expect(read.status).toBe(200);
      expect(read.body.event).toMatchObject({ event_key: eventKey });
      expect(
        (await sql`SELECT agent_grant_id FROM events WHERE event_key = ${eventKey}`)[0]!
          .agent_grant_id,
      ).toBe(grantId);
    },
  );
});
