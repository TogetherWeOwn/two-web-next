// route-inventory: POST /api/agent-events
// Acceptance: a supplied `guild_id` is admitted only when it is a string
// exactly equal to the grant guild. Every other supplied (non-null,
// non-omitted) value — arrays, objects, booleans, numbers — answers the
// existing 403 `wrong_guild` refusal; it is never coerced with `String(...)`
// and never throws its way to a 500.
//
// Premise (from the paired build card, verified against the public
// `handleAgentEvent` seam before writing this file): admission currently
// compares `String(doc.guild_id)` to the grant guild, ahead of replay and
// inner rate admission. On the source this suite was written against:
//   - `["12345"]`, `12345` and `{ toString: () => "12345" }` all created an
//     event (201) for a grant bound to guild "12345";
//   - `{ toString: null, valueOf: null }` (exactly what a JSON body
//     `{"toString":null,"valueOf":null}` parses to) and an object whose
//     `toString` throws rejected the service call with a TypeError, which
//     the mounted route maps to 500 `internal_error`.
// Input correctness only: the grant stays authoritative throughout — no
// case here claims a cross-guild authorization bypass.
//
// The production change that makes the RED tests pass: accept a supplied
// `guild_id` only when `typeof guild_id === "string"` and it equals the
// grant guild exactly (no trimming, no stringification), keeping the
// existing omitted/`null` allowance, the existing admission precedence
// (credential/grant checks before the guild check; the guild check before
// replay and inner rate admission), the correlated denied audit and the
// `{reason, message, request_id}` refusal envelope. Coercing first and
// comparing afterwards ("12345" from a number, an array or a `toString`)
// must fail these tests, as must sanitising a hostile value into an
// omitted one.
//
// The admitted guild here is "12345" rather than the default snowflake so
// a *number* can be exactly equal after coercion (a snowflake-length
// number loses precision in JS and would be refused even by the coercing
// comparison, hiding the bug). One route-level case also runs on the
// default snowflake guild.
//
// Hermetic and DB-free: in-memory fake agent-event store only, fetch and
// bot effects stubbed/spied. No DATABASE_URL, no Discord, no live calls.
//
// Scope guard: drive only through the public `handleAgentEvent` seam and
// the mounted app (`test/app.ts`), like the sibling ingress suites; do not
// import ingress/grants/shield/rate-limit/idempotency internals.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
  type IngressEffects,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const GUILD = "12345";
const OTHER_GUILD = "99999";
const SNOWFLAKE_GUILD = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-guild-type-001";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  stagingGuildId: GUILD,
  productionGuildId: OTHER_GUILD,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Guild type proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled guild-id type proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

let grantSeq = 0;
const liveGrant = (overrides: Partial<FakeGrant> = {}): FakeGrant => ({
  id: `grant-guild-type-${++grantSeq}`,
  agent_id: CALLER,
  guild_id: GUILD,
  expires_at: null,
  disabled_at: null,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

type Ctx = {
  fake: FakeAgentDb;
  grant: FakeGrant;
  fetchSpy: ReturnType<typeof vi.fn>;
  effects: Required<Pick<IngressEffects, "writeBack" | "readEvent">> & {
    writeBack: ReturnType<typeof vi.fn>;
    readEvent: ReturnType<typeof vi.fn>;
  };
  call: (body: unknown, credential?: string | null) => Promise<Answer>;
};

async function setup(grant: FakeGrant | null = liveGrant(), config: IngressConfig = cfg) {
  const fetchSpy = vi.fn(async () => {
    throw new Error("fetch must not be called on the ingress admission paths");
  });
  vi.stubGlobal("fetch", fetchSpy);
  const fake = makeFakeAgentDb();
  if (grant) await fake.addGrant(CRED, grant);
  const effects = {
    writeBack: vi.fn(async () => {}),
    readEvent: vi.fn(async () => ({ ok: false as const, reason: "fixture" })),
  };
  const call = (body: unknown, credential: string | null = CRED): Promise<Answer> =>
    handleAgentEvent(
      fake.sql,
      config,
      body,
      credential,
      null,
      effects as unknown as IngressEffects,
    );
  return { fake, grant: grant as FakeGrant, fetchSpy, effects, call } as Ctx;
}

// The full refusal accounting for a 403 wrong_guild on a fresh admitted
// grant: exact envelope, one correlated denied audit, only the single
// outer-shield hit (no inner rate budget), no event/bot effect.
function expectWrongGuild(a: Answer, ctx: Ctx) {
  expect(a.status).not.toBeGreaterThanOrEqual(500);
  expect(a.status).toBe(403);
  expect(Object.keys(a.body).sort()).toEqual(["message", "reason", "request_id"]);
  expect(a.body).toMatchObject({
    reason: "wrong_guild",
    message: expect.any(String),
    request_id: expect.any(String),
  });
  expect(JSON.stringify(a.body)).not.toContain(CRED);

  expect(ctx.fake.audits).toHaveLength(1);
  expect(ctx.fake.audits[0]).toMatchObject({
    grantId: ctx.grant.id,
    operation: "create",
    result: "denied",
    reason: "wrong_guild",
    requestId: a.body.request_id,
  });

  expect(ctx.fake.hits).toHaveLength(1);
  expect(ctx.fake.hits[0]!.bucket).toMatch(/^shield:/);
  expect(ctx.fake.hits.filter((h) => !h.bucket.startsWith("shield:"))).toHaveLength(0);

  expect(ctx.effects.writeBack).not.toHaveBeenCalled();
  expect(ctx.effects.readEvent).not.toHaveBeenCalled();
  expect(ctx.fetchSpy).not.toHaveBeenCalled();
}

const hostile = (key: string, guildId: unknown) => ({
  op: "create",
  idempotency_key: key,
  guild_id: guildId,
  fields: FIELDS,
});

describe("non-string guild_id is refused without coercion", () => {
  // Each case runs on a fresh fake with a fresh admitted grant, so shield
  // and inner budgets start unspent and audits start empty. Values are
  // built per case so no object is shared between tests.
  const HOSTILE_CASES: Array<{ label: string; make: () => unknown }> = [
    { label: "array containing the admitted guild", make: () => [GUILD] },
    { label: "nested array containing the admitted guild", make: () => [[GUILD]] },
    { label: "array containing a different guild", make: () => [OTHER_GUILD] },
    { label: "empty array", make: () => [] },
    { label: "number numerically equal to the admitted guild", make: () => 12345 },
    { label: "number for a different guild", make: () => 99999 },
    { label: "boolean true", make: () => true },
    { label: "boolean false", make: () => false },
    { label: "empty object", make: () => ({}) },
    { label: "object wrapping the admitted guild", make: () => ({ guild_id: GUILD }) },
    {
      label: "JSON-round-tripped null toString/valueOf object",
      make: () => JSON.parse(JSON.stringify({ toString: null, valueOf: null })) as unknown,
    },
    {
      label: "object whose toString returns the admitted guild",
      make: () => ({ toString: () => GUILD }),
    },
    {
      label: "object whose valueOf returns the admitted guild",
      make: () => ({ valueOf: () => GUILD }),
    },
    {
      label: "object whose toString throws",
      make: () => ({
        toString: () => {
          throw new Error("hostile toString");
        },
      }),
    },
    { label: "String object wrapping the admitted guild", make: () => new String(GUILD) },
  ];

  it.each(HOSTILE_CASES)(
    "guild_id as $label answers 403 wrong_guild, never creates and never throws",
    async ({ label, make }) => {
      const ctx = await setup();
      const a = await ctx.call(hostile(`guild-type-${label}`, make()));
      expectWrongGuild(a, ctx);
    },
  );

  it.each([
    { label: "array containing the admitted guild", make: () => [GUILD] },
    { label: "number equal to the admitted guild", make: () => 12345 },
    {
      label: "JSON-round-tripped null-conversion object",
      make: () => JSON.parse(JSON.stringify({ toString: null, valueOf: null })) as unknown,
    },
  ])(
    "after a $label refusal, the same idempotency key with the matching string creates fresh",
    async ({ label, make }) => {
      const ctx = await setup();
      const key = `guild-type-corrected-${label}`;
      expectWrongGuild(await ctx.call(hostile(key, make())), ctx);
      // No successful replay was stored under the key: the corrected
      // request is a fresh create, not a replay and not a conflict.
      const corrected = await ctx.call(hostile(key, GUILD));
      expect(corrected.status).toBe(201);
      expect(corrected.body).not.toHaveProperty("replayed");
    },
  );

  it("a hostile guild_id is refused before replay: a stored success is not replayed for it and survives undisturbed", async () => {
    const ctx = await setup();
    const key = "guild-type-before-replay";
    const created = await ctx.call(hostile(key, GUILD));
    expect(created.status).toBe(201);

    const auditsBefore = ctx.fake.audits.length;
    const a = await ctx.call(hostile(key, [GUILD]));
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_guild", request_id: expect.any(String) });
    expect(ctx.fake.audits.slice(auditsBefore)).toEqual([
      expect.objectContaining({
        result: "denied",
        reason: "wrong_guild",
        requestId: a.body.request_id,
      }),
    ]);

    const replay = await ctx.call(hostile(key, GUILD));
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true });
  });

  it("a hostile guild_id is refused before inner rate admission: spent mutating budgets still answer wrong_guild, not 429", async () => {
    const ctx = await setup();
    ctx.fake.prespend(`mutating:${ctx.grant.id}`);
    ctx.fake.prespend("service-mutating");
    const innerBefore = ctx.fake.hits.filter((h) => !h.bucket.startsWith("shield:")).length;

    const a = await ctx.call(hostile("guild-type-before-rate", [GUILD]));
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_guild" });
    expect(ctx.fake.hits.filter((h) => !h.bucket.startsWith("shield:")).length).toBe(innerBefore);
  });
});

describe("admission precedence is preserved with a hostile guild_id", () => {
  it("unknown credential plus a null-conversion guild object stays 401 unauthenticated and never throws", async () => {
    const ctx = await setup(null);
    const a = await ctx.call(
      hostile("guild-type-auth-unknown", JSON.parse('{"toString":null,"valueOf":null}')),
      "cred-never-granted",
    );
    expect(a.status).not.toBeGreaterThanOrEqual(500);
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated", request_id: expect.any(String) });
    // Grant-first ingress refuses unknown credentials with zero audit rows:
    // pre-auth refusals stay zero-audit (sampled warn only). Envelope,
    // request_id correlation and precedence pins below are unchanged.
    expect(ctx.fake.audits).toEqual([]);
    expect(ctx.fake.hits.filter((h) => !h.bucket.startsWith("shield:"))).toHaveLength(0);
  });

  it("anonymous caller plus an array guild stays 401 unauthenticated", async () => {
    const ctx = await setup();
    const a = await ctx.call(hostile("guild-type-auth-anon", [GUILD]), null);
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
  });

  it("a grant that is not the admitted caller plus an array guild stays 403 wrong_caller", async () => {
    const ctx = await setup(liveGrant({ agent_id: "some-other-agent" }));
    const a = await ctx.call(hostile("guild-type-prec-caller", [GUILD]));
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_caller" });
  });

  it("a grant bound outside the staging guild plus an array guild stays 403 wrong_audience", async () => {
    const ctx = await setup(liveGrant({ guild_id: "some-third-guild" }));
    const a = await ctx.call(hostile("guild-type-prec-audience", [GUILD]));
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_audience" });
  });

  it("an expired grant plus a numeric guild stays 403 grant_expired", async () => {
    const ctx = await setup(liveGrant({ expires_at: new Date(Date.now() - 60_000) }));
    const a = await ctx.call(hostile("guild-type-prec-expired", 12345));
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "grant_expired" });
  });

  it("an unknown op plus an array guild stays 403 forbidden_action", async () => {
    const ctx = await setup();
    const a = await ctx.call({
      op: "delete",
      idempotency_key: "guild-type-prec-op",
      guild_id: [GUILD],
    });
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "forbidden_action" });
  });
});

describe("controls: string, omitted and null guild_id are unchanged", () => {
  it("a matching string guild_id still creates", async () => {
    const ctx = await setup();
    const a = await ctx.call(hostile("guild-type-ok-string", GUILD));
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
    expect(ctx.fake.hits.filter((h) => !h.bucket.startsWith("shield:"))).not.toHaveLength(0);
  });

  it("an omitted guild_id still creates", async () => {
    const ctx = await setup();
    const a = await ctx.call({
      op: "create",
      idempotency_key: "guild-type-ok-omitted",
      fields: FIELDS,
    });
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });

  it("an explicitly undefined guild_id still creates", async () => {
    const ctx = await setup();
    const a = await ctx.call({
      op: "create",
      idempotency_key: "guild-type-ok-undefined",
      guild_id: undefined,
      fields: FIELDS,
    });
    expect(a.status).toBe(201);
  });

  it("a null guild_id still creates", async () => {
    const ctx = await setup();
    const a = await ctx.call(hostile("guild-type-ok-null", null));
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });

  it("a different string guild_id stays 403 wrong_guild with the same accounting", async () => {
    const ctx = await setup();
    expectWrongGuild(await ctx.call(hostile("guild-type-string-other", OTHER_GUILD)), ctx);
  });

  it("an empty string guild_id stays 403 wrong_guild", async () => {
    const ctx = await setup();
    expectWrongGuild(await ctx.call(hostile("guild-type-string-empty", "")), ctx);
  });

  it("a matching string with surrounding whitespace is not trimmed into a match", async () => {
    const ctx = await setup();
    expectWrongGuild(await ctx.call(hostile("guild-type-string-padded", ` ${GUILD} `)), ctx);
  });

  it("on the default snowflake guild, a numeric guild_id is 403 and the exact string creates", async () => {
    const snowCfg: IngressConfig = { ...cfg, stagingGuildId: SNOWFLAKE_GUILD };
    const refused = await setup(liveGrant({ guild_id: SNOWFLAKE_GUILD }), snowCfg);
    // The snowflake as a JS number (precision-lost, as any JSON number for
    // it would be) must still be a typed 403, never coerced.
    expectWrongGuild(
      await refused.call(hostile("guild-type-snow-number", 1545644954272137297)),
      refused,
    );

    const admitted = await setup(liveGrant({ guild_id: SNOWFLAKE_GUILD }), snowCfg);
    const ok = await admitted.call(hostile("guild-type-snow-string", SNOWFLAKE_GUILD));
    expect(ok.status).toBe(201);
  });
});

describe("mounted route: POST /api/agent-events", () => {
  const enabledEnv = {
    APP_URL: "https://next.example.test",
    AGENT_EVENTS_ENABLED: "true",
    AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
    AGENT_EVENTS_GUILD_ID: GUILD,
    AGENT_EVENTS_PRODUCTION_GUILD_ID: OTHER_GUILD,
  } as unknown as Env;
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

  async function routeCall(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the ingress admission paths");
      }),
    );
    const fake = makeFakeAgentDb();
    const grant = liveGrant();
    await fake.addGrant(CRED, grant);
    const env = { ...enabledEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CRED}` },
        body: JSON.stringify(body),
      },
      env,
      executionCtx,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, fake, grant };
  }

  it("a JSON null-conversion guild object answers HTTP 403 wrong_guild, never 500", async () => {
    const r = await routeCall(
      hostile("guild-type-route-null-props", JSON.parse('{"toString":null,"valueOf":null}')),
    );
    expect(r.status).not.toBeGreaterThanOrEqual(500);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ reason: "wrong_guild", request_id: expect.any(String) });
    expect(r.fake.audits).toEqual([
      expect.objectContaining({
        grantId: r.grant.id,
        result: "denied",
        reason: "wrong_guild",
        requestId: r.body.request_id,
      }),
    ]);
    expect(r.fake.hits.filter((h) => !h.bucket.startsWith("shield:"))).toHaveLength(0);
  });

  it("a JSON array containing the admitted guild answers HTTP 403, not a coerced create", async () => {
    const r = await routeCall(hostile("guild-type-route-array", [GUILD]));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ reason: "wrong_guild" });
  });

  it("a JSON number equal to the admitted guild answers HTTP 403, not a coerced create", async () => {
    const r = await routeCall(hostile("guild-type-route-number", 12345));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ reason: "wrong_guild" });
  });

  it("control: the matching JSON string guild still creates through the route", async () => {
    const r = await routeCall(hostile("guild-type-route-ok", GUILD));
    expect(r.status).toBe(201);
  });

  it("control: an omitted guild_id still creates through the route", async () => {
    const r = await routeCall({
      op: "create",
      idempotency_key: "guild-type-route-omitted",
      fields: FIELDS,
    });
    expect(r.status).toBe(201);
  });
});
