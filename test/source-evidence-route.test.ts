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

function fakeTag(strings: TemplateStringsArray, ..._values: unknown[]) {
  const text = strings.join("?");
  // Cache-defeat fragments are interpolated, never executed: like the real
  // driver, build them without recording a source read.
  if (text.trim().startsWith(", clock_timestamp()")) return {};
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
      return Object.assign(tag, {
        begin: (...args: unknown[]) => {
          mocks.begins.push(args);
          return (args[args.length - 1] as (tx: unknown) => unknown)(tag);
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
