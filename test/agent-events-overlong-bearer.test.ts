// route-inventory: POST /api/agent-events
// Acceptance: overlong Bearer credentials die before hashing.
//
// Contract under test (bound agreed for this change):
// - A captured Bearer credential longer than 512 characters is answered with
//   the existing 401 `unauthenticated` envelope and NOTHING else: no shield
//   hash, no `agent_event_hits` row, no verifier lookup. It must not be
//   silently demoted to the anonymous bucket either — the hit count does not
//   move at all.
// - A credential of exactly 512 characters is the boundary: it is hashed,
//   counted by the shield, and admitted exactly as today (a grant for it
//   creates; an unknown one is a counted 401).
// - Rotating distinct overlong credentials mints no buckets and spends no
//   budget: every one is the same 401, never a 429, and a normal valid
//   bearer afterwards is unaffected.
// - No credential material appears in any refusal body, and an overlong
//   credential that happens to have a grant is indistinguishable from an
//   unknown short credential (same status, reason, message and body keys).
//
// Driven black-box through the mounted route so the cap may live at either
// the route or the ingress layer. Hermetic half: in-memory fake store.
// Database half: owned schema on the guarded disposable test database only,
// skipped when DATABASE_URL is unset.
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import type { Env } from "../src/env";
import app from "./app";
import { clearAuditRows } from "./helpers/audit-rows";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const state = vi.hoisted(() => ({
  schema: "",
  clients: [] as { end: () => Promise<void> }[],
}));
// Keep the real mounted route, driver and SQL. Only pin request connections
// to the fixture's schema and the explicitly authorized empty test password
// (same seam as agent-events-input-bounds.test.ts).
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

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
/** The agreed cap: credentials longer than this die before hashing. */
const MAX_CRED = 512;

const FIELDS = {
  title: "Agent overlong-bearer proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled overlong-bearer proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

/** A printable, whitespace-free credential of exactly `len` characters. */
const credOf = (len: number, seed = "c") => {
  const head = `cred-${seed}-`;
  return head + "x".repeat(len - head.length);
};

let seq = 0;
const createBody = () =>
  JSON.stringify({ op: "create", idempotency_key: `overlong-${++seq}`, fields: FIELDS });

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the agent-events ingress paths");
    }),
  );
}

type Reply = { status: number; body: Record<string, unknown>; text: string };

async function callWithFake(fake: FakeAgentDb, token: string): Promise<Reply> {
  const env = {
    APP_URL: "https://next.example.test",
    AGENT_EVENTS_ENABLED: "true",
    AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
    AGENT_EVENT_SQL: fake.sql,
  } as unknown as Env;
  const res = await app.request(
    "/api/agent-events",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: createBody(),
    },
    env,
    executionCtx,
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

const grantFor = (id: string) => ({
  id,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
});

describe("overlong Bearer credentials die before hashing (hermetic)", () => {
  it.each([MAX_CRED + 1, 1024, 8192])(
    "an unknown %i-character bearer is the plain 401 and writes no hit row",
    async (len) => {
      noFetch();
      const fake = makeFakeAgentDb();
      const token = credOf(len, `u${len}`);
      const r = await callWithFake(fake, token);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ reason: "unauthenticated" });
      // Died before hashing: the shield never saw it, so no bucket was
      // minted and no hit was counted — not even an anonymous one.
      expect(fake.hits).toHaveLength(0);
      // No credential material leaks into the refusal.
      expect(r.text).not.toContain(token.slice(0, 64));
    },
  );

  it("a granted overlong bearer still dies before the verifier lookup, indistinguishable from unknown", async () => {
    noFetch();
    // Control shape: an unknown short credential on its own store.
    const controlFake = makeFakeAgentDb();
    const control = await callWithFake(controlFake, credOf(24, "short"));
    expect(control.status).toBe(401);

    const fake = makeFakeAgentDb();
    const token = credOf(MAX_CRED + 1, "granted513");
    await fake.addGrant(token, grantFor("grant-overlong-513"));
    const r = await callWithFake(fake, token);
    // Even though a grant exists for this exact credential, it is never
    // hashed or looked up: same 401 shape as an unknown short credential.
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe(control.body.reason);
    expect(r.body.message).toBe(control.body.message);
    expect(Object.keys(r.body).sort()).toEqual(Object.keys(control.body).sort());
    expect(fake.hits).toHaveLength(0);
    expect(r.text).not.toContain(token.slice(0, 64));
  });

  it("a rotation flood of distinct overlong bearers mints no buckets and spends no budget", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const normal = credOf(24, "normal");
    await fake.addGrant(normal, grantFor("grant-overlong-normal"));
    for (let i = 0; i < 25; i++) {
      const r = await callWithFake(fake, credOf(600 + i, `rot${i}`));
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ reason: "unauthenticated" });
    }
    expect(fake.hits).toHaveLength(0);
    // The flood spent nothing: a normal valid bearer is admitted at once.
    const ok = await callWithFake(fake, normal);
    expect(ok.status).toBe(201);
  });

  // Valid controls: these must pass before and after the cap exists.
  it("control: a granted bearer of exactly the boundary length is admitted", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const token = credOf(MAX_CRED, "edge512");
    await fake.addGrant(token, grantFor("grant-overlong-512"));
    const r = await callWithFake(fake, token);
    expect(r.status).toBe(201);
  });

  it("control: an unknown boundary-length bearer is a counted 401, hashed into its shield bucket", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const token = credOf(MAX_CRED, "unknown512");
    const r = await callWithFake(fake, token);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ reason: "unauthenticated" });
    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]!.bucket).toBe(`shield:${await sha256Hex(token)}`);
  });

  it("control: an unknown short bearer is a counted 401, exactly as today", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const token = credOf(24, "shortcount");
    const r = await callWithFake(fake, token);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ reason: "unauthenticated" });
    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]!.bucket).toBe(`shield:${await sha256Hex(token)}`);
  });

  it("control: a granted short bearer creates", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const token = credOf(24, "shortok");
    await fake.addGrant(token, grantFor("grant-overlong-short"));
    const r = await callWithFake(fake, token);
    expect(r.status).toBe(201);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "overlong Bearer credentials die before hashing (guarded disposable database)",
  () => {
    let fixture: MemberDataFixture;
    let sql: MemberDataFixture["client"];
    let url: string;

    const hitCount = async () =>
      (await sql`SELECT count(*)::int AS n FROM agent_event_hits`)[0]!.n as number;

    async function grant(token: string) {
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${CALLER}, 'synthetic-company', ${STAGING}, ${await sha256Hex(token)})`;
    }

    async function call(token: string): Promise<Reply> {
      const pending: Promise<unknown>[] = [];
      try {
        const res = await app.request(
          "/api/agent-events",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: createBody(),
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
        const text = await res.text();
        return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
      } finally {
        await Promise.all(pending);
        await Promise.all(state.clients.splice(0).map((client) => client.end()));
      }
    }

    beforeAll(async () => {
      url = testDatabaseUrl(process.env.DATABASE_URL!).href;
      fixture = await createMemberDataFixture(url, { max: 4 });
      sql = fixture.client;
      state.schema = fixture.schemaName;
    });
    beforeEach(async () => {
      await fixture.reset();
      await clearAuditRows(sql, ["agent_event_audits"]);
      await sql`DELETE FROM agent_event_grants`;
      await sql`DELETE FROM agent_event_hits`;
    });
    afterAll(async () => {
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
      state.schema = "";
      await fixture?.dispose();
    });

    it("an unknown overlong bearer is 401 with no agent_event_hits row", async () => {
      const before = await hitCount();
      const token = credOf(MAX_CRED + 1, "dbunknown513");
      const r = await call(token);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ reason: "unauthenticated" });
      expect(await hitCount()).toBe(before);
      expect(r.text).not.toContain(token.slice(0, 64));
    });

    it("a granted overlong bearer is 401 with no agent_event_hits row", async () => {
      const token = credOf(MAX_CRED + 1, "dbgranted513");
      await grant(token);
      const before = await hitCount();
      const r = await call(token);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ reason: "unauthenticated" });
      expect(await hitCount()).toBe(before);
    });

    it("a rotation flood of distinct overlong bearers writes no hit rows and no shield buckets", async () => {
      const normal = credOf(24, "dbnormal");
      await grant(normal);
      const before = await hitCount();
      for (let i = 0; i < 15; i++) {
        const r = await call(credOf(600 + i, `dbrot${i}`));
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({ reason: "unauthenticated" });
      }
      expect(await hitCount()).toBe(before);
      expect(
        (
          await sql`SELECT count(DISTINCT bucket)::int AS n FROM agent_event_hits WHERE bucket LIKE 'shield:%'`
        )[0]!.n as number,
      ).toBe(0);
      const ok = await call(normal);
      expect(ok.status).toBe(201);
    });

    it("control: a granted boundary-length bearer creates and is counted", async () => {
      const token = credOf(MAX_CRED, "dbedge512");
      await grant(token);
      const before = await hitCount();
      const r = await call(token);
      expect(r.status).toBe(201);
      expect(await hitCount()).toBeGreaterThan(before);
      expect(
        await sql`SELECT bucket FROM agent_event_hits WHERE bucket = ${`shield:${await sha256Hex(token)}`}`,
      ).toHaveLength(1);
    });

    it("control: an unknown boundary-length bearer is a counted 401", async () => {
      const token = credOf(MAX_CRED, "dbunknown512");
      const before = await hitCount();
      const r = await call(token);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ reason: "unauthenticated" });
      expect((await hitCount()) - before).toBe(1);
      expect(
        await sql`SELECT bucket FROM agent_event_hits WHERE bucket = ${`shield:${await sha256Hex(token)}`}`,
      ).toHaveLength(1);
    });
  },
);
