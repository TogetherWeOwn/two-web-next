// route-inventory: (none; service-level)
// Agent replay with a corrupt stored body: acceptance suite, written from the
// spec before the fix. One bad row in `agent_event_idempotency_keys` must not
// wedge its idempotency key forever.
//
// The contract pinned here (each test names the production change that would
// make it fail):
// - A stored body that cannot be decoded back into the original response
//   object — a string that is not JSON, truncated JSON, an empty string, or
//   JSON that decodes to a non-object (string/number/boolean/array/null) —
//   answers `409 { reason: "idempotency_conflict" }` with a fresh
//   `request_id`, never a throw / unhandled 500, and never a fabricated
//   "replayed" body spread out of a scalar. Re-executing is NOT an acceptable
//   substitute: the original operation may already have committed its
//   effects, so the key keeps exactly-once semantics and the client must use
//   a new key. Removing the corrupt-body guard (or answering 500/429/201)
//   fails these tests.
// - The conflict is audited (result "conflict", reason
//   "idempotency_conflict") and the audit commits: a retry after a corrupt
//   answer gets the same stable 409, not another throw, and the stored row
//   (the only evidence of the original response) is left byte-untouched.
//   Answering the conflict inside a transaction that still rolls back, or
//   rewriting/deleting the stored row, fails the DB-backed tests.
// - Healthy keys are unchanged: valid object bodies and legacy
//   double-encoded (JSON-string) bodies replay byte-identically apart from
//   `replayed: true` and a fresh `request_id`; a mismatched payload keeps
//   its 409 conflict (including against a corrupt row, where the digest
//   check runs before any decode); an original + identical retry mutates
//   exactly once. Weakening any of those fails the positive controls.
//
// Scope guard (same as the sibling replay suites): drive only the public
// `handleAgentEvent`; never import the idempotency internals directly. The
// hermetic block runs everywhere; the DB block runs only under the guarded
// disposable test database and skips cleanly without it.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { makeFakeAgentDb, type FakeReplayRow } from "./helpers/fake-agent-ingress-db";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const CALLER = "agent-replay-corrupt-fixture";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-replay-corrupt-001";
const GRANT_ID = "grant-replay-corrupt-1";
const EVENT_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAA";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Corrupt replay proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled corrupt-replay proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const GRANT = {
  id: GRANT_ID,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
};

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the replay paths");
    }),
  );
}

function expectConflict(a: Answer) {
  expect(a.status).toBe(409);
  expect(a.body.reason).toBe("idempotency_conflict");
  expect(typeof a.body.request_id).toBe("string");
  expect(String(a.body.request_id).length).toBeGreaterThan(0);
  expect(a.body).not.toHaveProperty("replayed");
}

function expectReplayedBody(a: Answer, stored: Record<string, unknown>) {
  const { request_id, ...rest } = a.body as Record<string, unknown>;
  expect(typeof request_id).toBe("string");
  expect(String(request_id).length).toBeGreaterThan(0);
  expect(rest).toEqual({ ...stored, replayed: true });
}

// ---------------------------------------------------------------------------
// Hermetic block: in-memory fake store, no DATABASE_URL.
// ---------------------------------------------------------------------------

describe("agent replay with a corrupt stored body (DB-free)", () => {
  const UNDECODABLE: Array<[string, string]> = [
    ["plain non-JSON text", "this is not json {{{"],
    ["truncated JSON object", '{"event_key":"AAAAAAAAAAAAAAAAAAAAAAAAAA","status":'],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["JSON string scalar", '"just a string"'],
    ["JSON number scalar", "12345"],
    ["JSON boolean scalar", "true"],
    ["JSON null", "null"],
    ["JSON array", "[1,2,3]"],
  ];

  it.each(UNDECODABLE)(
    "an undecodable stored body (%s) answers a stable audited 409, never a throw",
    async (_label, storedBody) => {
      noFetch();
      const fake = makeFakeAgentDb();
      await fake.addGrant(CRED, GRANT);
      // Spent mutating budgets must not turn the answer into a 429: a stored
      // replay (even a corrupt one) is answered before the limiter.
      fake.prespend(`mutating:${GRANT_ID}`);
      fake.prespend("service-mutating");

      const body = { op: "create", idempotency_key: "corrupt-001", fields: FIELDS };
      fake.seedReplay(GRANT_ID, "corrupt-001", {
        payload_digest: await digest(body),
        status: 201,
        body: storedBody,
        event_key: EVENT_KEY,
      });

      const first = await handleAgentEvent(fake.sql, cfg, body, CRED);
      expectConflict(first);
      // The wedge is gone: a second retry answers the same way instead of
      // throwing again, and each answer is audited as a conflict.
      const second = await handleAgentEvent(fake.sql, cfg, body, CRED);
      expectConflict(second);
      expect(second.body.request_id).not.toBe(first.body.request_id);
      expect(fake.audits.map((a) => a.reason)).toEqual([
        "idempotency_conflict",
        "idempotency_conflict",
      ]);
      // No re-execution and no rate-budget spend on either answer.
      expect(fake.hits.filter((h) => h.bucket.startsWith("mutating:"))).toHaveLength(999);
    },
  );

  it("a mismatched payload against a corrupt row keeps the plain 409 conflict", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const original = { op: "create", idempotency_key: "corrupt-mismatch-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "corrupt-mismatch-001", {
      payload_digest: await digest(original),
      status: 201,
      body: "definitely not json",
      event_key: EVENT_KEY,
    });
    const changed = {
      ...original,
      fields: { ...FIELDS, title: "A different payload entirely" },
    };
    const a = await handleAgentEvent(fake.sql, cfg, changed, CRED);
    expectConflict(a);
    expect(fake.audits.map((x) => x.reason)).toEqual(["idempotency_conflict"]);
  });

  it("a valid legacy double-encoded (string) body still replays byte-identically", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const stored = { event_key: EVENT_KEY, status: "draft", note: "keep me verbatim" };
    const body = { op: "create", idempotency_key: "corrupt-legacy-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "corrupt-legacy-001", {
      payload_digest: await digest(body),
      status: 201,
      body: JSON.stringify(stored),
      event_key: EVENT_KEY,
    });
    const a = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(a.status).toBe(201);
    expectReplayedBody(a, stored);
    // Evidence untouched: a further retry replays the same fields again.
    const b = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(b.status).toBe(201);
    expectReplayedBody(b, stored);
    expect(b.body.request_id).not.toBe(a.body.request_id);
    expect(fake.audits.map((x) => x.reason)).toEqual([null, null]);
  });

  it("a valid object body still replays byte-identically with its stored status", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const stored = { event_key: EVENT_KEY, status: "published", version: 3 };
    const body = { op: "create", idempotency_key: "corrupt-object-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "corrupt-object-001", {
      payload_digest: await digest(body),
      status: 202,
      // Modern rows arrive from jsonb already decoded; the fake row type is
      // string-only, so pass the object through verbatim.
      body: stored as unknown as FakeReplayRow["body"],
      event_key: EVENT_KEY,
    });
    const a = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(a.status).toBe(202);
    expectReplayedBody(a, stored);
    expect(fake.audits.map((x) => x.reason)).toEqual([null]);
  });

  it("a mismatched payload against a healthy row keeps the plain 409 conflict", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const original = { op: "create", idempotency_key: "corrupt-healthy-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "corrupt-healthy-001", {
      payload_digest: await digest(original),
      status: 201,
      body: JSON.stringify({ event_key: EVENT_KEY, status: "draft" }),
      event_key: EVENT_KEY,
    });
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { ...original, fields: { ...FIELDS, capacity: 9 } },
      CRED,
    );
    expectConflict(a);
  });

  it("an original create plus an identical retry still mutates exactly once", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const body = { op: "create", idempotency_key: "corrupt-fresh-001", fields: FIELDS };
    const first = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(first.status).toBe(201);
    expect(first.body).not.toHaveProperty("replayed");
    const retry = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(retry.status).toBe(201);
    const { request_id: _firstId, ...firstRest } = first.body as Record<string, unknown>;
    expectReplayedBody(retry, firstRest);
    expect(retry.body.request_id).not.toBe(first.body.request_id);
  });
});

// ---------------------------------------------------------------------------
// DB block: real transactions on the guarded disposable test database. This
// is where "never an unhandled 500" also means the conflict audit commits
// instead of rolling back with a throw, and the stored evidence survives.
// ---------------------------------------------------------------------------

const dbCfg: IngressConfig = { ...cfg, lockWaitMs: 5000 };

describe.skipIf(!process.env.DATABASE_URL)(
  "agent replay with a corrupt stored body (isolated test DB)",
  () => {
    let fixture: MemberDataFixture;
    let sql: postgres.Sql;
    let eventTable: "agent_events" | "events";
    const writeBack = vi.fn(async () => {});
    const observe = vi.fn(async () => ({
      unavailable: "verification_unavailable",
      reason: "fixture",
    }));

    beforeAll(async () => {
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      fixture = await createMemberDataFixture(url.href, { max: 8 });
      sql = postgres(url.href, {
        max: 8,
        port: 5432,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      const [tables] = await sql`SELECT to_regclass('agent_events') AS standalone`;
      eventTable = tables!.standalone ? "agent_events" : "events";
    });
    afterAll(async () => {
      await sql?.end();
      await fixture?.dispose();
    });

    async function caller() {
      const credential = `synthetic-corrupt-${randomUUID()}`;
      const verifier = await sha256Hex(credential);
      const [grant] =
        await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${CALLER}, 'fixture-company', ${dbCfg.stagingGuildId}, ${verifier}) RETURNING id`;
      const grantId = grant!.id as string;
      const call = (body: unknown): Promise<Answer> =>
        Reflect.apply(handleAgentEvent, undefined, [
          sql,
          dbCfg,
          body,
          credential,
          null,
          { writeBack, observe },
        ]);
      const receipts = (key: string) => sql`SELECT * FROM agent_event_audits
        WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;
      const stored = (key: string) => sql`SELECT * FROM agent_event_idempotency_keys
        WHERE grant_id = ${grantId} AND key = ${key}`;
      const events = () =>
        sql.unsafe(`SELECT * FROM ${eventTable} WHERE agent_grant_id = $1`, [grantId]);
      // Rewrite the stored body to an arbitrary jsonb value, given as JSON
      // text (`"123"` stores a number, `JSON.stringify("x")` a string, ...).
      const corrupt = async (key: string, jsonText: string) => {
        await sql`UPDATE agent_event_idempotency_keys SET body = ${jsonText}::text::jsonb
          WHERE grant_id = ${grantId} AND key = ${key}`;
        return stored(key);
      };
      return { call, receipts, stored, events, corrupt, grantId };
    }

    const CORRUPT_ROWS: Array<[string, string]> = [
      // A jsonb string whose contents are not JSON at all.
      ["non-JSON string body", JSON.stringify("{{{ not json at all")],
      ["truncated JSON string body", JSON.stringify('{"event_key":"AAA","status":')],
      ["empty string body", JSON.stringify("")],
      // Native jsonb values that decode to a non-object.
      ["jsonb number body", "12345"],
      ["jsonb array body", '["not","an","object"]'],
      ["jsonb null body", "null"],
    ];

    it.each(CORRUPT_ROWS)(
      "a %s answers an audited 409 twice, mutates nothing and preserves the row",
      async (_label, jsonText) => {
        const c = await caller();
        const key = randomUUID();
        const body = { op: "create", idempotency_key: key, fields: FIELDS };
        const first = await c.call(body);
        expect(first.status).toBe(201);
        const originalEvents = await c.events();
        expect(originalEvents).toHaveLength(1);

        const corruptedRow = await c.corrupt(key, jsonText);

        const retry = await c.call(body);
        expectConflict(retry);
        // Wedge gone: the next retry is answered, not thrown, in the same way.
        const retryAgain = await c.call(body);
        expectConflict(retryAgain);
        expect(retryAgain.body.request_id).not.toBe(retry.body.request_id);

        // Both conflict audits committed (a rolled-back throw would leave 1).
        const rows = await c.receipts(key);
        expect(rows.map((r) => [r.result, r.reason_code])).toEqual([
          ["ok", null],
          ["conflict", "idempotency_conflict"],
          ["conflict", "idempotency_conflict"],
        ]);
        expect(rows.map((r) => r.request_id)).toEqual([
          first.body.request_id,
          retry.body.request_id,
          retryAgain.body.request_id,
        ]);
        // Stored evidence and the original event are untouched: no rewrite,
        // no delete, no re-execution.
        expect(await c.stored(key)).toEqual(corruptedRow);
        expect(await c.events()).toEqual(originalEvents);
      },
    );

    it("a mismatched payload against a corrupt row keeps the plain 409 conflict", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields: FIELDS };
      const first = await c.call(body);
      expect(first.status).toBe(201);
      const corruptedRow = await c.corrupt(key, JSON.stringify("not json"));
      const conflict = await c.call({
        ...body,
        fields: { ...FIELDS, title: "Changed payload" },
      });
      expectConflict(conflict);
      const rows = await c.receipts(key);
      expect(rows.map((r) => [r.result, r.reason_code])).toEqual([
        ["ok", null],
        ["conflict", "idempotency_conflict"],
      ]);
      expect(await c.stored(key)).toEqual(corruptedRow);
    });

    it("healthy controls: valid and double-encoded bodies replay byte-identically, row untouched", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields: FIELDS };
      const first = await c.call(body);
      expect(first.status).toBe(201);
      const saved = await c.stored(key);

      const replay = await c.call(body);
      expect(replay).toEqual({
        status: first.status,
        body: { ...first.body, replayed: true, request_id: replay.body.request_id },
      });
      expect(replay.body.request_id).not.toBe(first.body.request_id);
      expect(await c.stored(key)).toEqual(saved);

      // Legacy double-encoded evidence: decode for the answer, never rewrite.
      const legacyRow = await c.corrupt(key, JSON.stringify(JSON.stringify(first.body)));
      const legacyReplay = await c.call(body);
      expect(legacyReplay).toEqual({
        status: first.status,
        body: { ...first.body, replayed: true, request_id: legacyReplay.body.request_id },
      });
      expect(await c.stored(key)).toEqual(legacyRow);
      expect((await c.receipts(key)).map((r) => r.result)).toEqual(["ok", "replayed", "replayed"]);
      expect(await c.events()).toHaveLength(1);
    });
  },
);
