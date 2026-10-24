// route-inventory: POST /api/agent-events
// Acceptance: the agent-events body-size cap is enforced BEFORE any
// admission DB work. An over-cap body — with unknown credentials, with no
// credentials, and with a valid grant credential — is refused 413 without
// opening a DB client, without running a single statement against an
// already-bound store, and without spending shield or grant rate budget.
// The cap also wins over an already-spent shield bucket (413, not 429),
// because no admission query may run to discover the bucket state.
//
// Break this catches: the route stack admits first and bounds second, so
// an oversized (or unauthenticated oversized) body opens a Postgres
// client and spends shield budget before the byte cap refuses it. Size is
// knowable from the request alone; no socket, grant lookup, hit row or
// audit row may precede the refusal.
//
// Positive controls (must pass before and after): under-cap requests are
// byte-for-byte unchanged — unknown credential 401, wrong-caller grant
// 403, forbidden op 403 with its audit row, stored replay 201 replayed,
// spent mutating budget 429, spent shield bucket 429 — and a body of
// exactly the cap is admitted to the service (never 413). Each control
// also proves the DB counters actually move, so the zero assertions in
// the over-cap suite cannot pass vacuously.
//
// Hermetic and DB-free: mounted app (`test/app.ts`) with the in-memory
// fake agent-event store behind a statement-counting wrapper, plus the
// Hyperdrive-shaped env behind a mocked `postgres` module that counts
// client opens. No DATABASE_URL, no Discord, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { DEFAULT_CONFIG, digest } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

// Counts real `postgres()` client opens on the Hyperdrive (AGENT_DB) path.
// Same modelling as test/body-limit-route-admission.test.ts.
const pgFixture = vi.hoisted(() => ({
  hits: 0,
  queries: [] as string[],
  ends: 0,
  connects: 0,
}));
vi.mock("postgres", () => ({
  default: (_url: string, _options: Record<string, unknown>) => {
    pgFixture.connects++;
    const sql = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      pgFixture.queries.push(query);
      if (query.includes("SELECT count(*)")) return [{ n: pgFixture.hits, wait: 31 }];
      if (query.includes("INSERT INTO agent_event_hits")) pgFixture.hits++;
      return [];
    };
    sql.begin = async (fn: (tx: unknown) => unknown) => fn(sql);
    sql.unsafe = async () => [];
    sql.end = async () => {
      pgFixture.ends++;
    };
    return sql;
  },
}));

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-body-cap-first-001";
const UNKNOWN_CRED = "cred-body-cap-first-unknown";
const GRANT_ID = "grant-body-cap-first-1";
const CAP = BODY_LIMIT_BYTES.agent;
const ERROR_413 = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled body-cap proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const baseEnv = {
  APP_URL: "https://next.example.test",
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
};

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

beforeEach(() => {
  pgFixture.hits = 0;
  pgFixture.queries = [];
  pgFixture.ends = 0;
  pgFixture.connects = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function silence() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the body-cap paths");
    }),
  );
}

type Counter = { statements: 0; begins: 0; ends: 0 };

/** Wrap the fake store so every statement/transaction/close is counted. */
function countingSql(fake: FakeAgentDb): { sql: postgres.Sql; counter: Counter } {
  const counter: Counter = { statements: 0, begins: 0, ends: 0 };
  const inner = fake.sql as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    unsafe: (...args: unknown[]) => Promise<unknown[]>;
    end: (...args: unknown[]) => Promise<void>;
    begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    counter.statements++;
    return inner(strings, ...values);
  }) as unknown as Record<string, unknown>;
  run.unsafe = async (...args: unknown[]) => {
    counter.statements++;
    return inner.unsafe(...args);
  };
  run.end = async (...args: unknown[]) => {
    counter.ends++;
    return inner.end(...args);
  };
  run.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    counter.begins++;
    return inner.begin(async () => fn(run));
  };
  return { sql: run as unknown as postgres.Sql, counter };
}

async function fakeEnv(grantAgentId: string = CALLER) {
  const fake = makeFakeAgentDb();
  await fake.addGrant(CRED, {
    id: GRANT_ID,
    agent_id: grantAgentId,
    guild_id: STAGING,
    expires_at: null,
    disabled_at: null,
  });
  const { sql, counter } = countingSql(fake);
  const env = { ...baseEnv, AGENT_EVENT_SQL: sql } as unknown as Env;
  return { fake, counter, env };
}

const hyperdriveEnv = {
  ...baseEnv,
  AGENT_DB: { connectionString: "postgres://fixture.invalid/never-connected" },
} as unknown as Env;

/** Endlessly-pullable upload; `advertised` also declares content-length cap+1. */
function overCapRequest(headers: Record<string, string>, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL("/api/agent-events", baseEnv.APP_URL), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
      ...headers,
      ...(advertised ? { "content-length": String(CAP + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

async function postJson(env: Env, headers: Record<string, string>, body: string) {
  const res = await app.request(
    "/api/agent-events",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1", ...headers },
      body,
    },
    env,
    executionCtx,
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

const credCases = [
  ["an unknown credential", UNKNOWN_CRED],
  ["a valid grant credential", CRED],
] as const;

describe("body cap before admission: over-cap refusals spend nothing (fake store)", () => {
  it.each(credCases)(
    "advertised over-cap body with %s is 413 with zero statements and zero budget",
    async (_label, credential) => {
      silence();
      const { fake, counter, env } = await fakeEnv();
      const { request } = overCapRequest({ authorization: `Bearer ${credential}` }, true);
      const res = await app.request(request, undefined, env, executionCtx);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject(ERROR_413);
      expect(counter.statements).toBe(0);
      expect(counter.begins).toBe(0);
      expect(fake.hits).toEqual([]);
      expect(fake.audits).toEqual([]);
      await request.body?.cancel();
    },
  );

  it.each(credCases)(
    "chunked over-cap body with %s is 413 with zero statements and zero budget",
    async (_label, credential) => {
      silence();
      const { fake, counter, env } = await fakeEnv();
      const { request } = overCapRequest({ authorization: `Bearer ${credential}` }, false);
      const res = await app.request(request, undefined, env, executionCtx);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject(ERROR_413);
      expect(counter.statements).toBe(0);
      expect(counter.begins).toBe(0);
      expect(fake.hits).toEqual([]);
      expect(fake.audits).toEqual([]);
      await request.body?.cancel();
    },
  );

  it("a credential-free over-cap string body is 413 with zero statements", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    const { res, json } = await postJson(env, {}, "x".repeat(CAP + 1));
    expect(res.status).toBe(413);
    expect(json).toMatchObject(ERROR_413);
    expect(counter.statements).toBe(0);
    expect(counter.begins).toBe(0);
    expect(fake.hits).toEqual([]);
    expect(fake.audits).toEqual([]);
  });

  it("the cap wins over a spent shield bucket: 413, no query, no new hit", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    fake.prespend(`shield:${await sha256Hex(CRED)}`);
    const prespent = fake.hits.length;
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      "x".repeat(CAP + 1),
    );
    expect(res.status).toBe(413);
    expect(json).toMatchObject(ERROR_413);
    expect(counter.statements).toBe(0);
    expect(fake.hits).toHaveLength(prespent);
    expect(fake.audits).toEqual([]);
  });
});

describe("body cap before admission: over-cap refusals open no client (Hyperdrive env)", () => {
  it.each(credCases)(
    "advertised over-cap body with %s opens zero Postgres clients",
    async (_label, credential) => {
      silence();
      const { request } = overCapRequest({ authorization: `Bearer ${credential}` }, true);
      const res = await app.request(request, undefined, hyperdriveEnv, executionCtx);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject(ERROR_413);
      expect(pgFixture.connects).toBe(0);
      expect(pgFixture.queries).toEqual([]);
      expect(pgFixture.hits).toBe(0);
      expect(pgFixture.ends).toBe(0);
      await request.body?.cancel();
    },
  );

  it("a chunked over-cap body with a bearer credential opens zero clients", async () => {
    silence();
    const { request } = overCapRequest({ authorization: `Bearer ${CRED}` }, false);
    const res = await app.request(request, undefined, hyperdriveEnv, executionCtx);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject(ERROR_413);
    expect(pgFixture.connects).toBe(0);
    expect(pgFixture.queries).toEqual([]);
    expect(pgFixture.ends).toBe(0);
    await request.body?.cancel();
  });
});

describe("body cap before admission: under-cap controls unchanged", () => {
  it("an unknown credential under the cap still reaches admission: 401, budget spent", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${UNKNOWN_CRED}` },
      JSON.stringify({ op: "create", idempotency_key: "cap-first-unknown-001", fields: FIELDS }),
    );
    expect(res.status).toBe(401);
    expect(json).toMatchObject({ reason: "unauthenticated" });
    expect(counter.statements).toBeGreaterThan(0);
    expect(fake.hits.length).toBeGreaterThan(0);
  });

  it("a grant for another caller under the cap still refuses 403 wrong_caller", async () => {
    silence();
    const { counter, env } = await fakeEnv("some-other-agent");
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      JSON.stringify({ op: "create", idempotency_key: "cap-first-caller-001", fields: FIELDS }),
    );
    expect(res.status).toBe(403);
    expect(json).toMatchObject({ reason: "wrong_caller" });
    expect(counter.statements).toBeGreaterThan(0);
  });

  it("a forbidden op under the cap still refuses 403 and writes its audit row", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      JSON.stringify({ op: "delete", idempotency_key: "cap-first-forbidden-001" }),
    );
    expect(res.status).toBe(403);
    expect(json).toMatchObject({ reason: "forbidden_action" });
    expect(counter.statements).toBeGreaterThan(0);
    expect(fake.audits.length).toBeGreaterThan(0);
  });

  it("a stored replay under the cap still answers 201 replayed", async () => {
    silence();
    const { fake, env } = await fakeEnv();
    const body = { op: "create", idempotency_key: "cap-first-replay-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "cap-first-replay-001", {
      payload_digest: await digest(body),
      status: 201,
      body: JSON.stringify({ event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA", status: "draft" }),
      event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      JSON.stringify(body),
    );
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ replayed: true });
  });

  it("a fresh create with spent mutating budgets under the cap still refuses 429", async () => {
    silence();
    const { fake, env } = await fakeEnv();
    fake.prespend(`mutating:${GRANT_ID}`);
    fake.prespend("service-mutating");
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      JSON.stringify({ op: "create", idempotency_key: "cap-first-inner-429-001", fields: FIELDS }),
    );
    expect(res.status).toBe(429);
    expect(json).toMatchObject({ reason: "rate_limited" });
  });

  it("a spent shield bucket under the cap still refuses 429 rate_limited", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    fake.prespend(`shield:${await sha256Hex(CRED)}`);
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      JSON.stringify({ op: "create", idempotency_key: "cap-first-shield-429-001", fields: FIELDS }),
    );
    expect(res.status).toBe(429);
    expect(json).toMatchObject({ reason: "rate_limited" });
    expect(counter.statements).toBeGreaterThan(0);
  });

  it("a body of exactly the cap is admitted, never 413", async () => {
    silence();
    const { fake, counter, env } = await fakeEnv();
    const { res, json } = await postJson(
      env,
      { authorization: `Bearer ${CRED}` },
      " ".repeat(CAP - 2) + "{}",
    );
    expect(res.status).toBe(422);
    expect(json).toMatchObject({ reason: "validation_failed" });
    expect(counter.statements).toBeGreaterThan(0);
    expect(fake.hits.length).toBeGreaterThan(0);
  });

  it("an under-cap request on the Hyperdrive path still opens its client", async () => {
    silence();
    const { res } = await postJson(hyperdriveEnv, {}, "{}");
    expect(res.status).not.toBe(413);
    expect(pgFixture.connects).toBeGreaterThan(0);
    expect(pgFixture.queries.length).toBeGreaterThan(0);
  });
});
