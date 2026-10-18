// route-inventory: POST /api/agent-events
// Acceptance: control bytes (Unicode Cc) in the stored event key resolve to
// null. A key carrying LF, CR, TAB, DEL or any other Cc character must take
// the existing event_not_found / null-audit paths — no new refusal shapes,
// no control bytes in denied-audit `event_key` values, and no control bytes
// in advisory-lock names (every control variant shares the null-key lock).
// Clean ULID keys are unaffected. Synthetic rows only, in an owned schema
// on the guarded test container.
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { storedEventKey } from "../src/agent-events/payload";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  ulid,
  validateFields,
  type IngressConfig,
} from "../src/agent-events/service";
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

// The full Unicode Cc category: C0 controls plus DEL and the C1 range.
const CC_CODE_POINTS = [
  ...Array.from({ length: 0x20 }, (_, i) => i),
  ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
];
const ccName = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
// Embed the control in an otherwise clean 26-character key so a null result
// can only be caused by the control character, never by the length bound.
const embed = (ch: string) => `${"Z".repeat(12)}${ch}${"Z".repeat(13)}`;

const REPRESENTATIVES = [
  { label: "LF", ch: "\n" },
  { label: "CR", ch: "\r" },
  { label: "TAB", ch: "\t" },
  { label: "DEL", ch: "\u007f" },
  { label: "ESC", ch: "\u001b" },
  { label: "NEL (C1)", ch: "\u0085" },
];

describe("stored event key control bytes (pure)", () => {
  it.each(CC_CODE_POINTS.map((cp) => ({ cp, key: embed(String.fromCodePoint(cp)) })))(
    "resolves a key carrying $cp to null",
    ({ cp, key }) => {
      expect(key, ccName(cp)).toHaveLength(26);
      expect(storedEventKey(key), ccName(cp)).toBeNull();
    },
  );

  for (const { label, ch } of REPRESENTATIVES) {
    it.each([
      { placement: "leading", key: ch + "Z".repeat(25) },
      { placement: "trailing", key: "Z".repeat(25) + ch },
      { placement: "embedded", key: embed(ch) },
      { placement: "whole value", key: ch },
    ])(`resolves a ${label} key ($placement) to null`, ({ key }) => {
      expect(storedEventKey(key)).toBeNull();
    });
  }

  it("keeps clean ULID keys exactly as given", () => {
    for (let i = 0; i < 8; i++) {
      const key = ulid();
      expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(storedEventKey(key)).toBe(key);
    }
  });

  it.each(["Z".repeat(25), "Z".repeat(26), "human-event"])(
    "keeps the clean non-control key %j exactly as given",
    (key) => {
      expect(storedEventKey(key)).toBe(key);
    },
  );

  // Regression controls: these already resolve to null today and must stay null.
  it.each([
    { label: "lone surrogate", key: "Z\ud800" },
    { label: "empty string", key: "" },
    { label: "27 characters", key: "Z".repeat(27) },
    { label: "non-string", key: 123 },
    { label: "null", key: null },
    { label: "undefined", key: undefined },
  ])("still resolves $label to null", ({ key }) => {
    expect(storedEventKey(key)).toBeNull();
  });

  // Out of scope guard: the event-key rule is stricter than the field
  // validators on its own terms; field validation must not change with it.
  it("leaves field validation accepting a newline in description", () => {
    const result = validateFields({
      title: "Synthetic event",
      description: "Line one\nLine two",
      starts_at: "2099-07-01 20:00",
      ends_at: "2099-07-01 22:00",
      timezone: "UTC",
      location: "Synthetic voice",
      capacity: 1,
    });
    expect(result).toMatchObject({ ok: true, fields: { description: "Line one\nLine two" } });
  });
});

const CALLER = "event-key-control-fixture";
const TOKEN = "synthetic-event-key-control-credential";
const FIELDS = {
  title: "Synthetic control-key event",
  game: null,
  description: null,
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "UTC",
  location: "Synthetic voice",
  capacity: 1,
};
const svcCfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  serviceMutatingPerMinute: 1000,
  serviceReadsPerMinute: 1000,
};

describe.skipIf(!process.env.DATABASE_URL)(
  "stored event key control bytes (mounted route / SQL)",
  () => {
    let fixture: MemberDataFixture;
    let sql: MemberDataFixture["client"];
    let url: string;
    let grantId: string;

    beforeAll(async () => {
      url = testDatabaseUrl(process.env.DATABASE_URL!).href;
      // max > 1 so a lock-holder transaction and the requests contending
      // with it can run on the same scoped pool.
      fixture = await createMemberDataFixture(url, { max: 8 });
      sql = fixture.client;
      state.schema = fixture.schemaName;
    });
    beforeEach(async () => {
      await fixture.reset();
      await sql`DELETE FROM agent_event_idempotency_keys`;
      await clearAuditRows(sql, ["agent_event_audits"]);
      await sql`DELETE FROM agent_event_hits`;
      await sql`DELETE FROM agent_event_grants`;
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

    type Answer = { status: number; body: Record<string, unknown> };

    async function httpCall(body: Record<string, unknown>): Promise<Answer> {
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

    const serviceCall = (body: Record<string, unknown>, cfg: IngressConfig = svcCfg) =>
      handleAgentEvent(sql, cfg, body, TOKEN) as Promise<Answer>;

    async function createOwned(): Promise<string> {
      const result = await serviceCall({
        op: "create",
        idempotency_key: randomUUID(),
        fields: FIELDS,
      });
      expect(result.status).toBe(201);
      expect(result.body.event_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      return result.body.event_key as string;
    }

    async function expectAudit(
      result: Answer,
      eventKey: string | null,
      auditResult: string,
      reason: string | null,
    ) {
      const rows =
        await sql`SELECT event_key, result, reason_code FROM agent_event_audits WHERE request_id = ${result.body.request_id as string}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_key: eventKey,
        result: auditResult,
        reason_code: reason,
      });
    }

    async function expectNotFound(result: Answer) {
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({
        reason: "event_not_found",
        message: expect.any(String),
        request_id: expect.any(String),
      });
      expect(result.body).not.toHaveProperty("replayed");
      await expectAudit(result, null, "denied", "event_not_found");
    }

    // The headline contract over real HTTP: no new refusal shape, the audit
    // row carries a null event_key, never the control-bearing key verbatim.
    for (const { label, ch } of REPRESENTATIVES.slice(0, 4)) {
      it(`mounted read with a ${label} key answers 404 with a null-key audit row`, async () => {
        const result = await httpCall({
          op: "read",
          idempotency_key: randomUUID(),
          event_key: embed(ch),
        });
        await expectNotFound(result);
        expect(await sql`SELECT key FROM agent_event_idempotency_keys`).toHaveLength(0);
        expect(await sql`SELECT event_key FROM events`).toHaveLength(0);
      });
    }

    for (const op of ["read", "update", "publish", "cancel"] as const) {
      it.each(REPRESENTATIVES)(
        `${op} with a $label key answers audited 404 without mutation or a stored replay`,
        async ({ ch }) => {
          const idempotency_key = randomUUID();
          const result = await serviceCall({
            op,
            idempotency_key,
            event_key: embed(ch),
            version: 1,
            fields: FIELDS,
          });
          await expectNotFound(result);
          expect(await sql`SELECT event_key FROM events`).toHaveLength(0);
          expect(
            await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = ${idempotency_key}`,
          ).toHaveLength(0);
        },
      );
    }

    for (const { label, ch } of [REPRESENTATIVES[0]!, REPRESENTATIVES[2]!, REPRESENTATIVES[3]!]) {
      it.each([
        { placement: "leading", make: (c: string) => c + "Z".repeat(25) },
        { placement: "trailing", make: (c: string) => "Z".repeat(25) + c },
        { placement: "whole value", make: (c: string) => c },
      ])(`read with a ${label} key ($placement) answers audited 404`, async ({ make }) => {
        const result = await serviceCall({
          op: "read",
          idempotency_key: randomUUID(),
          event_key: make(ch),
        });
        await expectNotFound(result);
      });
    }

    // A near miss must never resolve to the owned event: one character of a
    // real ULID replaced by a control byte is a null key, not that event.
    for (const op of ["read", "update", "publish", "cancel"] as const) {
      it(`${op} with an LF-mutated owned key misses the event, then the clean key reuses the idempotency key`, async () => {
        const eventKey = await createOwned();
        const before = await sql`SELECT * FROM events WHERE event_key = ${eventKey}`;
        const idempotency_key = randomUUID();
        const request = { op, idempotency_key, version: 1, fields: FIELDS };
        const mutated = eventKey.slice(0, 25) + "\n";
        expect(mutated).toHaveLength(26);
        const rejected = await serviceCall({ ...request, event_key: mutated });
        await expectNotFound(rejected);
        expect(await sql`SELECT * FROM events WHERE event_key = ${eventKey}`).toEqual(before);
        expect(
          await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = ${idempotency_key}`,
        ).toHaveLength(0);
        const corrected = await serviceCall({ ...request, event_key: eventKey });
        expect(corrected.status).toBe(200);
        expect(corrected.body).not.toHaveProperty("replayed");
        expect(
          await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = ${idempotency_key}`,
        ).toHaveLength(1);
      });
    }

    it("cancel with an embedded-DEL owned key leaves the event a draft", async () => {
      const eventKey = await createOwned();
      const mutated = eventKey.slice(0, 13) + "\u007f" + eventKey.slice(14);
      expect(mutated).toHaveLength(26);
      const rejected = await serviceCall({
        op: "cancel",
        idempotency_key: randomUUID(),
        event_key: mutated,
      });
      await expectNotFound(rejected);
      expect((await sql`SELECT status FROM events WHERE event_key = ${eventKey}`)[0]!.status).toBe(
        "draft",
      );
    });

    it("no denied-audit row from control-key attempts carries a control byte in event_key", async () => {
      await createOwned();
      for (const [op, ch] of [
        ["read", "\n"],
        ["update", "\t"],
        ["publish", "\r"],
        ["cancel", "\u007f"],
      ] as const) {
        const result = await serviceCall({
          op,
          idempotency_key: randomUUID(),
          event_key: embed(ch),
          version: 1,
          fields: FIELDS,
        });
        expect(result.status).toBe(404);
      }
      const rows = await sql`SELECT event_key FROM agent_event_audits WHERE result = 'denied'`;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.event_key).toBeNull();
    });

    it("valid control: the owned ULID lifecycle is unaffected and audits carry the clean key", async () => {
      const eventKey = await createOwned();
      const read = await serviceCall({
        op: "read",
        idempotency_key: randomUUID(),
        event_key: eventKey,
      });
      expect(read.status).toBe(200);
      expect(read.body.event).toMatchObject({ event_key: eventKey });
      const updated = await serviceCall({
        op: "update",
        idempotency_key: randomUUID(),
        event_key: eventKey,
        version: 1,
        fields: { ...FIELDS, title: "Clean key update" },
      });
      expect(updated.status).toBe(200);
      const published = await serviceCall({
        op: "publish",
        idempotency_key: randomUUID(),
        event_key: eventKey,
      });
      expect(published.status).toBe(200);
      await expectAudit(published, eventKey, "ok", null);
    });

    it("valid control: an unknown clean 26-character key keeps its identity in the audit", async () => {
      const clean = "Z".repeat(26);
      const result = await serviceCall({
        op: "read",
        idempotency_key: randomUUID(),
        event_key: clean,
      });
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ reason: "event_not_found" });
      await expectAudit(result, clean, "denied", "event_not_found");
    });

    it("valid control: the omitted key still falls back to the grant's owned event", async () => {
      const eventKey = await createOwned();
      const read = await serviceCall({ op: "read", idempotency_key: randomUUID() });
      expect(read.status).toBe(200);
      expect(read.body.event).toMatchObject({ event_key: eventKey });
    });

    function signal() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    // Hold one advisory lock in an open transaction for the duration of
    // `run`; the lock is released when the transaction ends.
    async function withHeldLock<T>(lockName: string, run: () => Promise<T>): Promise<T> {
      const locked = signal();
      const release = signal();
      const holding = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
        locked.resolve();
        await release.promise;
      });
      await Promise.race([locked.promise, holding]);
      try {
        return await run();
      } finally {
        release.resolve();
        await holding;
      }
    }

    const busyCfg: IngressConfig = { ...svcCfg, lockWaitMs: 300 };

    it("lock equivalence: every control variant waits on the same null-key (owned) lock", async () => {
      const eventKey = await createOwned();
      await withHeldLock(`agent-event:owned:${grantId}`, async () => {
        for (const [op, ch] of [
          ["update", "\n"],
          ["publish", "\t"],
          ["cancel", "\u007f"],
        ] as const) {
          const mutated = eventKey.slice(0, 25) + ch;
          const busy = await serviceCall(
            { op, idempotency_key: randomUUID(), event_key: mutated, version: 1, fields: FIELDS },
            busyCfg,
          );
          expect(busy.status, op).toBe(503);
          expect(busy.body).toMatchObject({ reason: "operation_busy" });
          await expectAudit(busy, null, "error", "operation_busy");
        }
      });
      // With the lock released the same shapes are plain null-key misses.
      const after = await serviceCall(
        {
          op: "cancel",
          idempotency_key: randomUUID(),
          event_key: eventKey.slice(0, 25) + "\n",
        },
        busyCfg,
      );
      await expectNotFound(after);
      expect((await sql`SELECT status FROM events WHERE event_key = ${eventKey}`)[0]!.status).toBe(
        "draft",
      );
    }, 15_000);

    it("lock controls: the omitted key waits on the owned lock and a clean key does not", async () => {
      const eventKey = await createOwned();
      await withHeldLock(`agent-event:owned:${grantId}`, async () => {
        const omitted = await serviceCall(
          { op: "publish", idempotency_key: randomUUID() },
          busyCfg,
        );
        expect(omitted.status).toBe(503);
        expect(omitted.body).toMatchObject({ reason: "operation_busy" });
        const cleanUnknown = await serviceCall(
          { op: "publish", idempotency_key: randomUUID(), event_key: "Z".repeat(26) },
          busyCfg,
        );
        expect(cleanUnknown.status).toBe(404);
        expect(cleanUnknown.body).toMatchObject({ reason: "event_not_found" });
        await expectAudit(cleanUnknown, "Z".repeat(26), "denied", "event_not_found");
        const cleanOwned = await serviceCall(
          { op: "read", idempotency_key: randomUUID(), event_key: eventKey },
          busyCfg,
        );
        expect(cleanOwned.status).toBe(200);
      });
    }, 15_000);

    it("lock names never carry the control bytes themselves", async () => {
      const eventKey = await createOwned();
      const mutated = eventKey.slice(0, 25) + "\n";
      // Holding the lock a control-bearing key would name today must not
      // block the request at all: that lock name is never taken.
      await withHeldLock(`agent-event:${mutated}`, async () => {
        const result = await serviceCall(
          { op: "cancel", idempotency_key: randomUUID(), event_key: mutated },
          busyCfg,
        );
        await expectNotFound(result);
      });
      expect((await sql`SELECT status FROM events WHERE event_key = ${eventKey}`)[0]!.status).toBe(
        "draft",
      );
    }, 15_000);
  },
);
