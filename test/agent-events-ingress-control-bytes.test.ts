// route-inventory: POST /api/agent-events
// Acceptance: NUL/control bytes in the agent-ingress `op` and
// `idempotency_key` are refused with 422 at admission, before any audit
// INSERT, so a hostile envelope never turns a denial into a 500.
//
// Premise (from the paired build card, not from reading the ingress body):
// admission currently accepts any string `op` and any non-empty
// `idempotency_key` up to its length cap, and denial paths audit those raw
// values. PostgreSQL `text` rejects U+0000 (SQLSTATE 22021), so the audit
// INSERT itself throws on a NUL-bearing envelope — an unhandled 500 where
// every sibling refusal is an audited 4xx.
//
// The production change that makes the RED tests pass: an admission guard
// rejects an `op` or `idempotency_key` containing a control character
// (U+0000–U+001F non-whitespace representatives and U+007F are sampled
// here) with the existing envelope refusal shape — status 422, reason
// `validation_failed` — before auth, grant, replay, rate-limit and audit
// handling. Sanitising (stripping the byte and proceeding) must fail
// these tests, as must auditing the raw hostile value.
//
// Hermetic and DB-free: the in-memory fake store is wrapped in a
// PostgreSQL-text double that raises 22021 when any bound string value
// contains U+0000, exactly as a real `text` bind would, and records every
// value offered to the audit INSERT. No DATABASE_URL, no Discord, no
// network (fetch is stubbed to throw).
//
// Scope guard: drive only through the public `handleAgentEvent` seam and
// the mounted app (`test/app.ts`), like the sibling ingress suites; do
// not import ingress/grants/shield/rate-limit/idempotency internals.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-control-bytes-001";
const GRANT_ID = "grant-control-bytes-1";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled control-byte proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const liveGrant = (overrides: Partial<FakeGrant> = {}): FakeGrant => ({
  id: GRANT_ID,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
  ...overrides,
});

// Representative control characters: NUL plus non-whitespace C0 controls
// and DEL. Tab/LF/CR are deliberately not pinned either way for these
// machine fields.
const CONTROL_CASES = [
  { label: "NUL U+0000", ch: "\u0000" },
  { label: "SOH U+0001", ch: "\u0001" },
  { label: "BEL U+0007", ch: "\u0007" },
  { label: "BS U+0008", ch: "\u0008" },
  { label: "ESC U+001B", ch: "\u001b" },
  { label: "US U+001F", ch: "\u001f" },
  { label: "DEL U+007F", ch: "\u007f" },
] as const;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the ingress admission paths");
    }),
  );
}

// PostgreSQL `text` cannot carry U+0000: a real bind raises 22021. The
// plain fake accepts any string, so wrap it to reproduce that one driver
// behaviour and to record the values offered to the audit INSERT.
function pgTextDouble(fake: FakeAgentDb) {
  const auditValues: unknown[][] = [];
  const guard = (args: unknown[]) => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    if (head.includes("INSERT INTO agent_event_audits")) auditValues.push([...args.slice(1)]);
    for (const value of args.slice(1)) {
      if (typeof value === "string" && value.includes("\u0000")) {
        throw Object.assign(
          new Error(
            'invalid byte sequence for encoding "UTF8": 0x00 (simulated PostgreSQL text bind)',
          ),
          { code: "22021" },
        );
      }
    }
  };
  const wrap = (target: unknown): unknown =>
    new Proxy(target as object, {
      apply: async (t, thisArg, args: unknown[]) => {
        guard(args);
        return Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (t, prop) =>
        prop === "begin"
          ? (fn: (tx: unknown) => Promise<unknown>) =>
              (t as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(
                (tx) => fn(wrap(tx)),
              )
          : Reflect.get(t, prop),
    });
  return { sql: wrap(fake.sql) as FakeAgentDb["sql"], auditValues };
}

async function setup(grant: FakeGrant | null = liveGrant()) {
  noFetch();
  const fake = makeFakeAgentDb();
  if (grant) await fake.addGrant(CRED, grant);
  const { sql, auditValues } = pgTextDouble(fake);
  const call = (body: unknown, credential: string | null = CRED): Promise<Answer> =>
    handleAgentEvent(sql, cfg, body, credential);
  return { fake, sql, auditValues, call };
}

// No value offered to (or recorded by) the audit INSERT may carry the
// hostile bytes raw: the refusal is audited sanitised or not audited,
// never by persisting the attacker's control character.
function expectNoControlInAudit(fake: FakeAgentDb, auditValues: unknown[][]) {
  for (const row of auditValues) {
    for (const value of row) {
      if (typeof value === "string") expect(value).not.toMatch(CONTROL_RE);
    }
  }
  for (const audit of fake.audits) {
    expect(audit.operation).not.toMatch(CONTROL_RE);
  }
}

function expectAdmission422(a: Answer) {
  expect(a.status).not.toBeGreaterThanOrEqual(500);
  expect(a.status).toBe(422);
  expect(a.body).toMatchObject({
    reason: "validation_failed",
    message: expect.any(String),
    request_id: expect.any(String),
  });
  expect(a.body).not.toHaveProperty("replayed");
  // No credential material is echoed in the refusal.
  expect(JSON.stringify(a.body)).not.toContain(CRED);
}

describe("control bytes in idempotency_key (admission)", () => {
  it.each(CONTROL_CASES)(
    "create with $label inside the key answers 422, never 500",
    async ({ ch }) => {
      const { fake, auditValues, call } = await setup();
      const a = await call({ op: "create", idempotency_key: `x${ch}y`, fields: FIELDS });
      expectAdmission422(a);
      expectNoControlInAudit(fake, auditValues);
    },
  );

  it.each([
    { label: "the whole key is NUL", key: "\u0000" },
    { label: "leading NUL", key: "\u0000abc" },
    { label: "trailing NUL", key: "abc\u0000" },
  ])("create with $label answers 422", async ({ key }) => {
    const { fake, auditValues, call } = await setup();
    const a = await call({ op: "create", idempotency_key: key, fields: FIELDS });
    expectAdmission422(a);
    expectNoControlInAudit(fake, auditValues);
  });

  it('the exact hostile key "x\\0y" stores nothing: a corrected key then creates fresh, not replayed', async () => {
    const { fake, auditValues, call } = await setup();
    expectAdmission422(await call({ op: "create", idempotency_key: "x\u0000y", fields: FIELDS }));
    expectNoControlInAudit(fake, auditValues);
    const corrected = await call({ op: "create", idempotency_key: "xy-corrected", fields: FIELDS });
    expect(corrected.status).toBe(201);
    expect(corrected.body).not.toHaveProperty("replayed");
  });

  it.each(["read", "update", "publish", "cancel"] as const)(
    "%s with a NUL-bearing key answers 422, never 500",
    async (op) => {
      const { fake, auditValues, call } = await setup();
      const a = await call({
        op,
        idempotency_key: "x\u0000y",
        version: 1,
        fields: FIELDS,
      });
      expectAdmission422(a);
      expectNoControlInAudit(fake, auditValues);
    },
  );
});

describe("control bytes in op (admission)", () => {
  it.each(CONTROL_CASES)(
    "op with $label inside answers 422, never 500 and not the unknown-op 403",
    async ({ ch }) => {
      const { fake, auditValues, call } = await setup();
      const a = await call({
        op: `cre${ch}ate`,
        idempotency_key: "op-control-001",
        fields: FIELDS,
      });
      expectAdmission422(a);
      expectNoControlInAudit(fake, auditValues);
    },
  );

  it.each([
    { label: "leading NUL", op: "\u0000create" },
    { label: "trailing NUL", op: "create\u0000" },
    { label: "NUL after a valid prefix of another op", op: "read\u0000x" },
  ])("op with $label answers 422", async ({ op }) => {
    const { fake, auditValues, call } = await setup();
    const a = await call({ op, idempotency_key: "op-nul-001", fields: FIELDS });
    expectAdmission422(a);
    expectNoControlInAudit(fake, auditValues);
  });

  it("a NUL-bearing op stores nothing under its key: the corrected op then creates fresh", async () => {
    const { call } = await setup();
    expectAdmission422(
      await call({ op: "cre\u0000ate", idempotency_key: "op-retry-001", fields: FIELDS }),
    );
    const corrected = await call({
      op: "create",
      idempotency_key: "op-retry-001",
      fields: FIELDS,
    });
    expect(corrected.status).toBe(201);
    expect(corrected.body).not.toHaveProperty("replayed");
  });

  it("both fields hostile at once answers 422, never 500", async () => {
    const { fake, auditValues, call } = await setup();
    const a = await call({ op: "cre\u0000ate", idempotency_key: "x\u0000y", fields: FIELDS });
    expectAdmission422(a);
    expectNoControlInAudit(fake, auditValues);
  });
});

describe("hostile envelopes across the deny paths", () => {
  // Every setup below would otherwise land on a different denial (or on
  // success); the admission guard must answer 422 first on each, and none
  // may surface as a 500 from the audit INSERT.
  const denySetups: Array<{
    label: string;
    grant: FakeGrant | null;
    credential: string | null;
    prepare?: (fake: FakeAgentDb) => Promise<void> | void;
  }> = [
    { label: "anonymous (no credential)", grant: null, credential: null },
    { label: "unknown credential", grant: null, credential: CRED },
    {
      label: "wrong caller",
      grant: liveGrant({ agent_id: "some-other-agent" }),
      credential: CRED,
    },
    { label: "wrong audience", grant: liveGrant({ guild_id: "other-guild" }), credential: CRED },
    {
      label: "disabled grant",
      grant: liveGrant({ disabled_at: new Date() }),
      credential: CRED,
    },
    {
      label: "expired grant",
      grant: liveGrant({ expires_at: new Date(Date.now() - 60_000) }),
      credential: CRED,
    },
    { label: "live grant (would otherwise succeed)", grant: liveGrant(), credential: CRED },
    {
      label: "spent mutating budgets",
      grant: liveGrant(),
      credential: CRED,
      prepare: (fake) => {
        fake.prespend(`mutating:${GRANT_ID}`);
        fake.prespend("service-mutating");
      },
    },
  ];

  it.each(denySetups)("NUL-bearing key on the $label path answers 422", async (s) => {
    const { fake, auditValues, call } = await setup(s.grant);
    await s.prepare?.(fake);
    const a = await call(
      { op: "create", idempotency_key: "x\u0000y", fields: FIELDS },
      s.credential,
    );
    expectAdmission422(a);
    expectNoControlInAudit(fake, auditValues);
  });

  it.each(denySetups)("NUL-bearing op on the $label path answers 422", async (s) => {
    const { fake, auditValues, call } = await setup(s.grant);
    await s.prepare?.(fake);
    const a = await call(
      { op: "cre\u0000ate", idempotency_key: "deny-path-op-001", fields: FIELDS },
      s.credential,
    );
    expectAdmission422(a);
    expectNoControlInAudit(fake, auditValues);
  });

  it("a hostile key does not replay or disturb a stored replay under a valid key", async () => {
    const { fake, auditValues, call } = await setup();
    const body = { op: "create", idempotency_key: "seeded-valid-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "seeded-valid-001", {
      payload_digest: await digest(body),
      status: 201,
      body: JSON.stringify({ event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA", status: "draft" }),
      event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expectAdmission422(await call({ op: "create", idempotency_key: "x\u0000y", fields: FIELDS }));
    expectNoControlInAudit(fake, auditValues);
    const replay = await call(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true });
  });
});

describe("controls: existing refusals and valid flows are unchanged", () => {
  it("a well-formed create from the admitted caller reaches 201", async () => {
    const { call } = await setup();
    const a = await call({ op: "create", idempotency_key: "control-ok-001", fields: FIELDS });
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });

  it("a valid key with punctuation and non-ASCII letters still creates", async () => {
    const { call } = await setup();
    const a = await call({
      op: "create",
      idempotency_key: "café:proof_01.rev-2",
      fields: FIELDS,
    });
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });

  it("a 255-character valid key still creates", async () => {
    const { call } = await setup();
    const a = await call({ op: "create", idempotency_key: "k".repeat(255), fields: FIELDS });
    expect(a.status).toBe(201);
  });

  it("a duplicate valid delivery replays and a changed payload conflicts", async () => {
    const { call } = await setup();
    const body = { op: "create", idempotency_key: "control-replay-001", fields: FIELDS };
    expect((await call(body)).status).toBe(201);
    const replay = await call(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true });
    const conflict = await call({
      ...body,
      fields: { ...FIELDS, title: "Changed payload" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ reason: "idempotency_conflict" });
  });

  it("an anonymous hit with a valid key stays 401", async () => {
    const { call } = await setup();
    const a = await call(
      { op: "create", idempotency_key: "control-anon-001", fields: FIELDS },
      null,
    );
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
  });

  it("a grant that is not the admitted caller stays 403 wrong_caller", async () => {
    const { call } = await setup(liveGrant({ agent_id: "some-other-agent" }));
    const a = await call({ op: "create", idempotency_key: "control-caller-001", fields: FIELDS });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_caller" });
  });

  it("a grant outside the staging guild stays 403 wrong_audience", async () => {
    const { call } = await setup(liveGrant({ guild_id: "other-guild" }));
    const a = await call({ op: "create", idempotency_key: "control-guild-001", fields: FIELDS });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_audience" });
  });

  it("a disabled grant stays grant_disabled", async () => {
    const { call } = await setup(liveGrant({ disabled_at: new Date() }));
    const a = await call({ op: "create", idempotency_key: "control-disabled-001", fields: FIELDS });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "grant_disabled" });
  });

  it("an expired grant stays grant_expired", async () => {
    const { call } = await setup(liveGrant({ expires_at: new Date(Date.now() - 60_000) }));
    const a = await call({ op: "create", idempotency_key: "control-expired-001", fields: FIELDS });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "grant_expired" });
  });

  it("an unknown op with a valid key stays 403 forbidden_action", async () => {
    const { call } = await setup();
    const a = await call({ op: "delete", idempotency_key: "control-op-001" });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "forbidden_action" });
  });

  it("an envelope without op or without a key stays 422 validation_failed", async () => {
    const { call } = await setup();
    const noOp = await call({ idempotency_key: "control-env-001", fields: FIELDS });
    expect(noOp.status).toBe(422);
    expect(noOp.body).toMatchObject({ reason: "validation_failed" });
    const noKey = await call({ op: "create", fields: FIELDS });
    expect(noKey.status).toBe(422);
    expect(noKey.body).toMatchObject({ reason: "validation_failed" });
  });

  it("a fresh valid create with spent mutating budgets stays 429", async () => {
    const { fake, call } = await setup();
    fake.prespend(`mutating:${GRANT_ID}`);
    fake.prespend("service-mutating");
    const a = await call({ op: "create", idempotency_key: "control-429-001", fields: FIELDS });
    expect(a.status).toBe(429);
    expect(a.body).toMatchObject({ reason: "rate_limited" });
  });
});

describe("mounted route: POST /api/agent-events", () => {
  const baseEnv = { APP_URL: "https://next.example.test" } as unknown as Env;
  const enabledEnv = {
    ...baseEnv,
    AGENT_EVENTS_ENABLED: "true",
    AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
  } as unknown as Env;
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

  async function routeCall(body: unknown, credential: string | null = CRED) {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const { sql, auditValues } = pgTextDouble(fake);
    const env = { ...enabledEnv, AGENT_EVENT_SQL: sql } as unknown as Env;
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
      executionCtx,
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      fake,
      auditValues,
    };
  }

  it("a NUL-bearing key answers HTTP 422, never 500", async () => {
    const r = await routeCall({ op: "create", idempotency_key: "x\u0000y", fields: FIELDS });
    expect(r.status).not.toBeGreaterThanOrEqual(500);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ reason: "validation_failed" });
    expectNoControlInAudit(r.fake, r.auditValues);
  });

  it("a NUL-bearing op answers HTTP 422, never 500", async () => {
    const r = await routeCall({
      op: "cre\u0000ate",
      idempotency_key: "route-op-001",
      fields: FIELDS,
    });
    expect(r.status).not.toBeGreaterThanOrEqual(500);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ reason: "validation_failed" });
    expectNoControlInAudit(r.fake, r.auditValues);
  });

  it("a hostile envelope without a bearer answers HTTP 422, never 500", async () => {
    const r = await routeCall({ op: "create", idempotency_key: "x\u0000y", fields: FIELDS }, null);
    expect(r.status).not.toBeGreaterThanOrEqual(500);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ reason: "validation_failed" });
    expectNoControlInAudit(r.fake, r.auditValues);
  });

  it("control: a valid create through the route still reaches 201", async () => {
    const r = await routeCall({ op: "create", idempotency_key: "route-ok-001", fields: FIELDS });
    expect(r.status).toBe(201);
  });

  it("control: a disabled ingress still answers 404 for a hostile envelope, touching no store", async () => {
    noFetch();
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create", idempotency_key: "x\u0000y", fields: FIELDS }),
      },
      baseEnv,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "ingress_disabled",
    });
  });
});
