// route-inventory: GET /admin/queue/source-evidence/:id
// route-inventory: DELETE /admin/queue/source-evidence/:id
// route-inventory: OPTIONS /admin/queue/source-evidence/:id
// route-inventory: PATCH /admin/queue/source-evidence/:id
// route-inventory: POST /admin/queue/source-evidence/:id
// route-inventory: PUT /admin/queue/source-evidence/:id
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { STATEMENT_SET_HASH } from "../src/admin/source-evidence";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";

const mocks = vi.hoisted(() => ({
  texts: [] as string[],
  options: [] as unknown[],
  begins: [] as unknown[][],
  end: vi.fn(),
  factory: vi.fn(),
  mode: "row" as "row" | "missing" | "error" | "markerless",
}));
vi.mock("postgres", () => ({ default: mocks.factory }));

const token = "test-source-evidence-bearer-token-with-32-plus-bytes-000";
const env: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "1545644954272137297",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
  SOURCE_EVIDENCE_VERIFIER_ENABLED: "true",
  SOURCE_EVIDENCE_VERIFIER_TOKEN: token,
  SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: "7",
  SOURCE_EVIDENCE_VERIFIER_ISSUED_AT: String(Date.now()),
  SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(Date.now() + 600_000),
};

function markerRow() {
  const at = new Date();
  return {
    id: 7,
    kind: "sync-event",
    key: "sync-event:01ARZ3NDEKTSV4RRFFQ69G5FAA",
    failed_at: at,
    observed_at: at,
    preview_read_at: mocks.mode === "markerless" ? undefined : at,
  };
}

function fakeTag(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join("?");
  const normalized = text.replace(/\s+/g, " ").trim();
  // Cache-defeat fragments are interpolated, never executed: like the real
  // driver, build them without recording a source read.
  if (text.trim().startsWith(", clock_timestamp()")) return {};
  if (
    normalized ===
      "select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout" &&
    values.length === 0
  ) {
    return [{ lock_timeout: "17s", statement_timeout: "23s" }];
  }
  // Timeout setup/restoration configures the transaction; it is not an
  // evidence/source read. The fixture uses non-default caller settings.
  if (text.includes("set_config")) {
    const timeoutConfig =
      normalized ===
      "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)";
    const isBounded =
      values.length === 2 && values.every((value) => value === "2000" || value === "2000ms");
    const restoresCallerSettings = values[0] === "17s" && values[1] === "23s";
    if (timeoutConfig && (isBounded || restoresCallerSettings)) return [];
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
  }
  mocks.texts.push(text);
  if (mocks.mode === "error") throw new Error("private source failure");
  if (text.includes("queue_failed_jobs")) return mocks.mode === "missing" ? [] : [markerRow()];
  if (text.includes("rejected") || text.includes("pending") || text.includes("a.state")) return [];
  if (text.includes("from events")) return [{ preview_read_at: new Date() }];
  throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
}

function request(
  store: SessionStore,
  init: RequestInit = {},
  bindings = env,
  path = "/admin/queue/source-evidence/7",
) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${STAGING_APP_URL}${path}`,
    {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    },
    bindings,
  );
}

const WRITE_VERBS = ["OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
const ACTION_MAX = BODY_LIMIT_BYTES.action;
const TOO_LARGE = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

function oversizedUpload(method: string, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const upload = new Request(`${STAGING_APP_URL}/admin/queue/source-evidence/7`, {
    method,
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(advertised ? { "content-length": String(ACTION_MAX + 1) } : {}),
    },
  } as RequestInit);
  return { upload, pull };
}

describe("evidence-only source/cache verifier admission", () => {
  beforeEach(() => {
    mocks.texts.length = 0;
    mocks.options.length = 0;
    mocks.begins.length = 0;
    mocks.mode = "row";
    mocks.end.mockResolvedValue(undefined);
    mocks.factory.mockImplementation((_url: string, options: unknown) => {
      mocks.options.push(options);
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
        fakeTag(strings, ...values);
      // A postgres.js transaction tag can savepoint but cannot open another transaction.
      function transactionClient() {
        const tx = (strings: TemplateStringsArray, ...values: unknown[]) =>
          fakeTag(strings, ...values);
        return Object.assign(tx, {
          async savepoint<T>(work: (client: unknown) => Promise<T>) {
            return work(transactionClient());
          },
        });
      }
      const tx = transactionClient();
      return Object.assign(tag, {
        begin: (...args: unknown[]) => {
          mocks.begins.push(args);
          return (args[args.length - 1] as (tx: unknown) => unknown)(tx);
        },
        end: mocks.end,
      });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it.each([undefined, "false", "1", "TRUE", "true "])(
    "flag %s refuses before any session or source read",
    async (flag) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const res = await request(store, {}, { ...env, SOURCE_EVIDENCE_VERIFIER_ENABLED: flag });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "evidence_disabled" });
      expect(get).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );

  it.each(["https://togetherweown.com", "http://localhost:8787"])(
    "non-staging configuration %s refuses without a source read",
    async (APP_URL) => {
      const res = await request(createMemorySessionStore(), {}, { ...env, APP_URL });
      expect(res.status).toBe(404);
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );

  it("a staging APP_URL alone does not admit a foreign request origin", async () => {
    const app = new Hono().route("/admin", adminApp(createMemorySessionStore()));
    const res = await app.request(
      "https://elsewhere.example/admin/queue/source-evidence/7",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(404);
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it.each(["OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
    "%s has no evidence authority",
    async (method) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const res = await request(store, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
      expect(get).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );

  it.each([...WRITE_VERBS])(
    "%s with a small body still refuses 405 DB-free (cap passes, refusal answers)",
    async (method) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const throttleStore = vi.fn(async () => null);
      const bindings = { ...env, THROTTLE_STORE: throttleStore } as unknown as Env;
      const res = await request(
        store,
        { method, body: "ok", headers: { "content-type": "text/plain" } },
        bindings,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
      expect(get).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
      expect(throttleStore).not.toHaveBeenCalled();
    },
  );

  it.each([...WRITE_VERBS])(
    "%s with an advertised oversized body refuses 413 DB-free before the method refusal",
    async (method) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const throttleStore = vi.fn(async () => null);
      const bindings = { ...env, THROTTLE_STORE: throttleStore } as unknown as Env;
      const app = new Hono().route("/admin", adminApp(store));
      const { upload, pull } = oversizedUpload(method, true);
      const res = await app.request(upload, undefined, bindings);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject(TOO_LARGE);
      expect(pull).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
      expect(throttleStore).not.toHaveBeenCalled();
      await upload.body?.cancel().catch(() => {});
    },
  );

  it.each([...WRITE_VERBS])(
    "%s with a chunked oversized body refuses 413 DB-free before the method refusal",
    async (method) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const throttleStore = vi.fn(async () => null);
      const bindings = { ...env, THROTTLE_STORE: throttleStore } as unknown as Env;
      const app = new Hono().route("/admin", adminApp(store));
      const { upload, pull } = oversizedUpload(method, false);
      const res = await app.request(upload, undefined, bindings);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject(TOO_LARGE);
      expect(pull.mock.calls.length).toBeLessThanOrEqual(ACTION_MAX / 1024 + 2);
      expect(get).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
      expect(throttleStore).not.toHaveBeenCalled();
      await upload.body?.cancel().catch(() => {});
    },
  );

  it.each(["0", "-1", "01", "1.0", "9007199254740992"])(
    "invalid incident selector %s refuses without a source read",
    async (id) => {
      const res = await request(
        createMemorySessionStore(),
        {},
        env,
        `/admin/queue/source-evidence/${id}`,
      );
      expect(res.status).toBe(422);
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );

  it("a query string refuses without a source read", async () => {
    const res = await request(
      createMemorySessionStore(),
      {},
      env,
      "/admin/queue/source-evidence/7?incident=7",
    );
    expect(res.status).toBe(422);
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it.each([
    ["absent bearer", { authorization: "" }, { ...env }],
    ["wrong bearer", { authorization: "Bearer wrong-token-with-32-plus-bytes-000000" }, env],
    [
      "short configured token",
      { authorization: "Bearer short" },
      { ...env, SOURCE_EVIDENCE_VERIFIER_TOKEN: "short" },
    ],
    ["wrong incident", {}, { ...env, SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: "8" }],
    ["unparseable incident", {}, { ...env, SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: "nope" }],
    [
      "expired window",
      {},
      { ...env, SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(Date.now() - 1000) },
    ],
  ])("%s refuses without a source read", async (_label, headers, bindings) => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const res = await request(store, { headers }, bindings);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "evidence_forbidden" });
    expect(get).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it.each([
    ["longer than one hour", 0, 3_600_001],
    ["expiry before issue", 0, -1_000],
    ["issued in the future", 120_000, 600_000],
  ])("an authorization window %s refuses", async (_label, issuedSkew, windowMs) => {
    // Computed at request time against the live clock: no same-millisecond race.
    const issuedAt = Date.now() + issuedSkew;
    const res = await request(
      createMemorySessionStore(),
      {},
      {
        ...env,
        SOURCE_EVIDENCE_VERIFIER_ISSUED_AT: String(issuedAt),
        SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(issuedAt + windowMs),
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "evidence_forbidden" });
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("unknown incident is a bounded 404, not evidence", async () => {
    mocks.mode = "missing";
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const res = await request(store);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "failure_not_found" });
    expect(get).not.toHaveBeenCalled();
  });

  it("source error fails closed without leaking diagnostics", async () => {
    mocks.mode = "error";
    const res = await request(createMemorySessionStore());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence_unavailable" });
  });

  it("a markerless failed-row read ends the attempt as missing evidence", async () => {
    mocks.mode = "markerless";
    const res = await request(createMemorySessionStore());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence_unavailable" });
  });

  it.each([
    ["bounded timeout setup", "2000", "2000"],
    ["bounded timeout setup with units", "2000ms", "2000ms"],
    ["caller timeout restoration", "17s", "23s"],
  ] as const)(
    "%s does not count as a source read",
    async (_label, lockTimeout, statementTimeout) => {
      fakeTag`select set_config('lock_timeout', ${lockTimeout}, true), set_config('statement_timeout', ${statementTimeout}, true)`;
      expect(mocks.texts).toHaveLength(0);
      const res = await request(createMemorySessionStore());
      expect(res.status).toBe(200);
      expect(mocks.texts).toHaveLength(5);
      const body = (await res.json()) as { selects: unknown[] };
      expect(body.selects).toHaveLength(5);
    },
  );

  it.each([
    ["select unknown_function()", []],
    [
      "select set_config('lock_timeout', ?, false), set_config('statement_timeout', ?, true)",
      ["2000", "2000"],
    ],
    [
      "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true) from events",
      ["2000", "2000"],
    ],
    [
      "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
      ["0", "2000"],
    ],
    [
      "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
      ["2000"],
    ],
  ])("unexpected SQL/configuration still refuses: %s %j", (text, values) => {
    expect(() => fakeTag([text] as unknown as TemplateStringsArray, ...values)).toThrow(
      "unexpected statement:",
    );
  });

  it("success returns evidence only, once, with no session and no audit write", async () => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    // No cookie at all: a guest must still reach the bearer check, never OAuth.
    const res = await request(store);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      selects: { index: number; statement: string; rowCount: number; readAt: string | null }[];
    };
    expect(body).toMatchObject({
      evidenceOnly: true,
      statementSetHash: STATEMENT_SET_HASH,
      incidentId: 7,
      binding: { kind: "explicit-url", databaseUrlOverride: true },
    });
    expect(body.selects).toHaveLength(5);
    expect(body.selects[0]).toMatchObject({ index: 0, statement: "queue_failed_jobs_by_id" });
    for (const select of body.selects) {
      if (select.rowCount > 0) expect(typeof select.readAt).toBe("string");
    }
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "disposition",
      "eventKey",
      "idempotencyKey",
      "sync-event",
      "private",
      "token",
      "secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Exactly one guarded snapshot: a single client, a single attempt, closed once.
    expect(mocks.factory).toHaveBeenCalledTimes(1);
    expect(mocks.begins).toHaveLength(1);
    expect(String(mocks.begins[0]![0])).toContain("read only");
    expect(mocks.texts.some((text) => /insert into activity_log/i.test(text))).toBe(false);
    expect(mocks.texts.some((text) => /insert|update|delete/i.test(text))).toBe(false);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    expect(get).not.toHaveBeenCalled();
  });

  it("uses a 10 s statement timeout on its own client", async () => {
    await request(createMemorySessionStore());
    expect(mocks.options).toHaveLength(1);
    expect(mocks.options[0]).toMatchObject({
      connection: { statement_timeout: 10_000 },
    });
  });

  it("reports the Hyperdrive binding kind when no URL override is set", async () => {
    const { DATABASE_URL: _dropped, ...hyperdriveEnv } = env;
    const res = await request(
      createMemorySessionStore(),
      {},
      { ...hyperdriveEnv, DB: { connectionString: "postgres://staging/hyperdrive" } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      binding: { kind: "hyperdrive", databaseUrlOverride: false },
    });
  });
});
