// Shared hermetic fixture for the streaming S3 acceptance suites
// (test/streaming-setup-acceptance.test.ts,
// test/streaming-key-confinement-acceptance.test.ts).
//
// S3: lazy provisioning of one Cloudflare Stream live input per subscriber
// on first /streaming/setup visit, show-once ingest key, rotate, and
// member self disable/enable. No live services, no real DB: the Cloudflare
// API is a recorded-shape fake over stubbed global fetch, Postgres is a
// pg-proxy fake emulating `subscriptions` + `stream_live_inputs`, sessions
// are the memory store, and throttling is the shared THROTTLE_STORE seam
// with an in-memory fixed-window counter.
//
// Locked seams the Builder must honor (full contract in the suite headers):
// - routes on the main app: GET /streaming/setup,
//   POST /streaming/setup/rotate, POST /streaming/setup/disable,
//   POST /streaming/setup/enable (empty urlencoded form + Origin).
// - env: STREAM_KEYS_KEY (`v1:<base64-32B>`; rotation lists are
//   comma-separated with the current key first), CF_STREAM_ACCOUNT_ID,
//   CF_STREAM_API_TOKEN, plus the existing SESSION_STORE / ADMIN_DB /
//   THROTTLE_STORE seams.
// - Cloudflare Stream over global fetch against
//   https://api.cloudflare.com/client/v4/accounts/<id>/stream/live_inputs:
//   POST (provision), POST :uid/rotate_keys, PUT :uid {enabled}, and the
//   connection-status lifecycle read on
//   https://<customer>.cloudflarestream.com/<uid>/lifecycle.
// - Postgres through ADMIN_DB: `subscriptions` and `stream_live_inputs`
//   per the design table shapes, key_version defaulting to 1.
import { randomBytes } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { SESSION_COOKIE } from "../../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../../src/sessions";
import app from "../app";

export const STREAMING_APP_URL = "https://streaming.example.test";
export const STREAMING_RTMPS_URL = "rtmps://live.cloudflare.com:443/live/";
export const STREAMING_CF_ACCOUNT = "fixture-cf-account-id";
export const STREAMING_CF_TOKEN = "fixture-cf-api-token";
export const STREAMING_ALICE = "100000000000000001";
export const STREAMING_BOB = "100000000000000002";
export const STREAMING_SESSION_SECRET = "test-streaming-session-secret-at-least-32-bytes";

const HTML_ACCEPT = "text/html,application/xhtml+xml";

/** Fresh `v1:<base64-32B>` key material for STREAM_KEYS_KEY. */
export function makeStreamKeysKey(): string {
  return `v1:${randomBytes(32).toString("base64")}`;
}

/** Rotation-list value: a new current v2 key with the previous value kept. */
export function rotatedStreamKeysKey(previousValue: string): string {
  return `v2:${randomBytes(32).toString("base64")},${previousValue}`;
}

export type CfRecordedCall = {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
};

type CfInputState = {
  uid: string;
  key: string;
  deadKeys: string[];
  enabled: boolean;
  live: boolean;
  recordingMode: unknown;
  metaName: unknown;
  videoUID: string;
};

/**
 * Fake Cloudflare Stream server with recorded API shapes (v4 envelope
 * `{success, errors, messages, result}` on api.cloudflare.com, bare
 * `{isInput, videoUID, live}` on the customer lifecycle host). Neutral
 * toward wrong requests: it records everything and answers, so the suite —
 * not the fake — judges recording.mode, names, and call order.
 */
export class FakeCloudflareStream {
  readonly calls: CfRecordedCall[] = [];
  readonly unexpected: CfRecordedCall[] = [];
  private readonly inputs = new Map<string, CfInputState>();
  private seq = 0;
  private keySeq = 0;
  private failProvision = 0;
  private failRotate = 0;
  private failUpdate = 0;

  /** Fail the next n provision calls with a 500 v4 error envelope. */
  failNextProvisions(n: number): void {
    this.failProvision = n;
  }

  failNextRotates(n: number): void {
    this.failRotate = n;
  }

  failNextUpdates(n: number): void {
    this.failUpdate = n;
  }

  provisions(): CfRecordedCall[] {
    return this.calls.filter(
      (c) => c.method === "POST" && /\/stream\/live_inputs$/.test(new URL(c.url).pathname),
    );
  }

  rotates(): CfRecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.includes("/rotate_keys"));
  }

  updates(): CfRecordedCall[] {
    return this.calls.filter((c) => c.method === "PUT" && c.url.includes("/stream/live_inputs/"));
  }

  input(uid: string): CfInputState | undefined {
    return this.inputs.get(uid);
  }

  currentKey(uid: string): string | undefined {
    return this.inputs.get(uid)?.key;
  }

  isDead(key: string): boolean {
    return [...this.inputs.values()].some((input) => input.deadKeys.includes(key));
  }

  setLive(uid: string, live: boolean): void {
    const input = this.inputs.get(uid);
    if (!input) throw new Error(`fake Cloudflare has no input ${uid}`);
    input.live = live;
  }

  firstUid(): string | undefined {
    return [...this.inputs.keys()].at(0);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const call: CfRecordedCall = {
      method,
      url,
      body,
      authorization: headers.get("authorization"),
    };
    this.calls.push(call);

    const parsed = new URL(url);
    if (parsed.hostname === "api.cloudflare.com") return this.routeApi(parsed, call);
    if (
      parsed.hostname.endsWith(".cloudflarestream.com") &&
      method === "GET" &&
      /^\/[^/]+\/lifecycle$/.test(parsed.pathname)
    ) {
      const uid = parsed.pathname.split("/")[1] ?? "";
      const state = this.inputs.get(uid);
      if (!state) return Response.json({ message: "unknown input" }, { status: 404 });
      return Response.json({ isInput: true, videoUID: state.videoUID, live: state.live });
    }
    this.unexpected.push(call);
    return Response.json(
      { success: false, errors: [{ message: "unexpected call in streaming fixture" }] },
      { status: 500 },
    );
  }

  private routeApi(parsed: URL, call: CfRecordedCall): Response {
    const match =
      /^\/client\/v4\/accounts\/([^/]+)\/stream\/live_inputs(?:\/([^/]+))?(\/[^/]+)?$/.exec(
        parsed.pathname,
      );
    if (!match) {
      this.unexpected.push(call);
      return Response.json(
        { success: false, errors: [{ message: "unexpected call in streaming fixture" }] },
        { status: 500 },
      );
    }
    const uid = match[2];
    const suffix = match[3];
    if (call.method === "POST" && !uid) return this.provision(call);
    if (call.method === "POST" && uid && suffix === "/rotate_keys") return this.rotate(uid);
    if (call.method === "PUT" && uid && !suffix) return this.update(uid, call.body);
    if (call.method === "GET" && uid && !suffix) return this.retrieve(uid);
    this.unexpected.push(call);
    return Response.json(
      { success: false, errors: [{ message: "unexpected call in streaming fixture" }] },
      { status: 500 },
    );
  }

  private envelope(result: unknown): Response {
    return Response.json({ success: true, errors: [], messages: [], result });
  }

  private failure(): Response {
    return Response.json(
      { success: false, errors: [{ code: 10000, message: "Fake Cloudflare outage" }] },
      { status: 500 },
    );
  }

  private describe(state: CfInputState): Record<string, unknown> {
    return {
      uid: state.uid,
      rtmps: { url: STREAMING_RTMPS_URL, streamKey: state.key },
      created: "2026-10-22T00:00:00.000Z",
      modified: "2026-10-22T00:00:00.000Z",
      meta: { name: state.metaName },
      status: null,
      recording: { mode: state.recordingMode },
      enabled: state.enabled,
    };
  }

  private provision(call: CfRecordedCall): Response {
    if (this.failProvision > 0) {
      this.failProvision -= 1;
      return this.failure();
    }
    this.seq += 1;
    this.keySeq += 1;
    const payload = (call.body ?? {}) as {
      meta?: { name?: unknown };
      recording?: { mode?: unknown };
    };
    const state: CfInputState = {
      uid: `fake-live-input-${this.seq}`,
      key: `fake-ingest-key-${this.keySeq}`,
      deadKeys: [],
      enabled: true,
      live: false,
      recordingMode: payload.recording?.mode ?? null,
      metaName: payload.meta?.name ?? null,
      videoUID: `fake-video-${this.seq}`,
    };
    this.inputs.set(state.uid, state);
    return this.envelope(this.describe(state));
  }

  private rotate(uid: string): Response {
    if (this.failRotate > 0) {
      this.failRotate -= 1;
      return this.failure();
    }
    const state = this.inputs.get(uid);
    if (!state) {
      return Response.json(
        { success: false, errors: [{ code: 10006, message: "unknown live input" }] },
        { status: 404 },
      );
    }
    state.deadKeys.push(state.key);
    this.keySeq += 1;
    state.key = `fake-ingest-key-${this.keySeq}`;
    return this.envelope(this.describe(state));
  }

  private update(uid: string, body: unknown): Response {
    if (this.failUpdate > 0) {
      this.failUpdate -= 1;
      return this.failure();
    }
    const state = this.inputs.get(uid);
    if (!state) {
      return Response.json(
        { success: false, errors: [{ code: 10006, message: "unknown live input" }] },
        { status: 404 },
      );
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled === "boolean") state.enabled = enabled;
    return this.envelope(this.describe(state));
  }

  private retrieve(uid: string): Response {
    const state = this.inputs.get(uid);
    if (!state) {
      return Response.json(
        { success: false, errors: [{ code: 10006, message: "unknown live input" }] },
        { status: 404 },
      );
    }
    return this.envelope(this.describe(state));
  }
}

export type RecordedQuery = { sql: string; params: unknown[] };
export type DbRow = Record<string, unknown>;

export type StreamingDb = {
  db: Db;
  /** Raw pg-proxy driver behind `db` (lets probes issue typed queries). */
  driver: (sql: string, params: unknown[]) => Promise<{ rows: unknown[][] }>;
  queries: RecordedQuery[];
  failAll: Error | null;
  seedSubscription: (userId: string, over?: Partial<DbRow>) => DbRow;
  row: (table: string, pk: string) => DbRow | undefined;
  setRow: (table: string, pk: string, patch: Partial<DbRow>) => void;
  rowCount: (table: string) => number;
};

const TABLE_PK = "user_id";
const TABLE_DEFAULTS: Record<string, DbRow> = {
  subscriptions: { cancel_at_period_end: false },
  stream_live_inputs: { enabled: true, recording_mode: "off", key_version: 1 },
};
const TABLE_COLUMNS: Record<string, string[]> = {
  subscriptions: [
    "user_id",
    "stripe_customer_id",
    "stripe_subscription_id",
    "tier",
    "status",
    "current_period_start",
    "current_period_end",
    "cancel_at_period_end",
    "created_at",
    "updated_at",
  ],
  stream_live_inputs: [
    "user_id",
    "cf_input_uid",
    "ingest_key_enc",
    "ingest_key_iv",
    "enabled",
    "recording_mode",
    "key_version",
    "created_at",
    "updated_at",
  ],
};

function isEmulated(table: string): boolean {
  return table === "subscriptions" || table === "stream_live_inputs";
}

function tableOf(sql: string, keyword: "from" | "into" | "update"): string | null {
  const pattern =
    keyword === "from"
      ? /\sfrom\s+"?([A-Za-z0-9_]+)"?/i
      : keyword === "into"
        ? /insert\s+into\s+"?([A-Za-z0-9_]+)"?/i
        : /update\s+"?([A-Za-z0-9_]+)"?/i;
  return pattern.exec(sql)?.[1] ?? null;
}

/**
 * In-memory pg-proxy Postgres emulating the two S3 tables. Single-table
 * SELECT/INSERT/UPDATE/DELETE by id param; anything else answers empty but
 * is recorded (so the key-confinement suite can still grep every statement
 * and bound param). Unsupported shapes on the emulated tables throw a
 * loud, named error instead of answering wrong data.
 */
export function createStreamingDb(): StreamingDb {
  const tables = new Map<string, Map<string, DbRow>>();
  const queries: RecordedQuery[] = [];
  const driver = async (sql: string, params: unknown[]): Promise<{ rows: unknown[][] }> => {
    queries.push({ sql, params });
    if (state.failAll) throw state.failAll;
    if (/^\s*select\b/i.test(sql)) return handleSelect(sql, params);
    if (/^\s*insert\b/i.test(sql)) return handleInsert(sql, params);
    if (/^\s*update\b/i.test(sql)) return handleUpdate(sql, params);
    if (/^\s*delete\b/i.test(sql)) return handleDelete(sql, params);
    return { rows: [] };
  };
  const state: StreamingDb = {
    db: null as unknown as Db,
    driver,
    queries,
    failAll: null,
    seedSubscription: (userId, over = {}) => {
      const now = Date.now();
      const row: DbRow = {
        user_id: userId,
        stripe_customer_id: `cus_fixture_${userId.slice(-4)}`,
        stripe_subscription_id: `sub_fixture_${userId.slice(-4)}`,
        tier: "basic",
        status: "active",
        current_period_start: new Date(now - 86_400_000),
        current_period_end: new Date(now + 30 * 86_400_000),
        cancel_at_period_end: false,
        created_at: new Date(now - 86_400_000),
        updated_at: new Date(now - 86_400_000),
        ...over,
      };
      table("subscriptions").set(userId, row);
      return row;
    },
    row: (tableName, pk) => table(tableName).get(pk),
    setRow: (tableName, pk, patch) => {
      const existing = table(tableName).get(pk);
      if (!existing) throw new Error(`streaming DB fake has no ${tableName} row for ${pk}`);
      table(tableName).set(pk, { ...existing, ...patch });
    },
    rowCount: (tableName) => table(tableName).size,
  };

  const table = (name: string): Map<string, DbRow> => {
    let rows = tables.get(name);
    if (!rows) {
      rows = new Map();
      tables.set(name, rows);
    }
    return rows;
  };

  const matchRow = (tableName: string, params: unknown[]): DbRow | undefined => {
    for (const row of table(tableName).values()) {
      for (const param of params) {
        if (typeof param !== "string") continue;
        if (
          param === row.user_id ||
          param === row.cf_input_uid ||
          param === row.stripe_subscription_id
        ) {
          return row;
        }
      }
    }
    return undefined;
  };

  const encode = (row: DbRow, columns: string[]): unknown[] =>
    columns.map((column) => {
      const value = row[column];
      if (value instanceof Date) return value.toISOString();
      return value ?? null;
    });

  const selectedColumns = (sql: string): string[] | null => {
    const list = /^select\s+([\s\S]*?)\sfrom\s/i.exec(sql)?.[1];
    if (list === undefined) return null;
    if (list.trim() === "*") return ["*"];
    const columns: string[] = [];
    for (const part of list.split(",")) {
      const idents = [...part.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] as string);
      const last = idents.at(-1);
      if (last === undefined) return null;
      columns.push(last);
    }
    return columns;
  };

  const returningColumns = (sql: string): string[] | null => {
    const list = /returning\s+(.+?)\s*;?\s*$/i.exec(sql)?.[1];
    if (list === undefined) return null;
    if (list.trim() === "*") return ["*"];
    return [...list.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] as string);
  };

  const handleSelect = (sql: string, params: unknown[]): { rows: unknown[][] } => {
    if (/\bjoin\b/i.test(sql)) {
      throw new Error(
        "streaming DB fake does not support JOIN; extend test/helpers/streaming-acceptance.ts (Test Author owns this file)",
      );
    }
    const tableName = tableOf(sql, "from");
    if (!tableName || !isEmulated(tableName)) return { rows: [] };
    if (/count\(\s*\*\s*\)/i.test(sql)) {
      return { rows: [[matchRow(tableName, params) ? 1 : 0]] };
    }
    const columns = selectedColumns(sql);
    if (!columns) {
      throw new Error(
        `streaming DB fake cannot parse SELECT columns: ${sql.slice(0, 160)} (Test Author owns this file)`,
      );
    }
    const row = matchRow(tableName, params);
    if (!row) return { rows: [] };
    const resolved =
      columns.length === 1 && columns[0] === "*" ? TABLE_COLUMNS[tableName]! : columns;
    return { rows: [encode(row, resolved)] };
  };

  const handleInsert = (sql: string, params: unknown[]): { rows: unknown[][] } => {
    const tableName = tableOf(sql, "into");
    if (!tableName || !isEmulated(tableName)) return { rows: [] };
    const columnsPart = /insert\s+into\s+"?[A-Za-z0-9_]+"?\s*\(([^)]+)\)/i.exec(sql)?.[1];
    const valuesPart = /values\s*\(([^)]+)\)/i.exec(sql)?.[1];
    if (!columnsPart || !valuesPart) {
      throw new Error(
        `streaming DB fake cannot parse INSERT: ${sql.slice(0, 160)} (Test Author owns this file)`,
      );
    }
    const columns = [...columnsPart.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] as string);
    const items = valuesPart.split(",").map((item) => item.trim());
    if (columns.length === 0 || columns.length !== items.length) {
      throw new Error(
        `streaming DB fake cannot zip INSERT columns to params: ${sql.slice(0, 160)} (Test Author owns this file)`,
      );
    }
    const now = new Date();
    const row: DbRow = {
      created_at: now,
      updated_at: now,
      ...TABLE_DEFAULTS[tableName],
    };
    columns.forEach((column, position) => {
      const item = items[position] as string;
      const ref = /^\$(\d+)$/.exec(item)?.[1];
      if (ref !== undefined) {
        row[column] = params[Number(ref) - 1];
      } else if (/^(now\(\)|clock_timestamp\(\))$/i.test(item)) {
        row[column] = new Date();
      } else if (item.toLowerCase() !== "default") {
        throw new Error(
          `streaming DB fake cannot parse INSERT value ${item}: ${sql.slice(0, 160)} (Test Author owns this file)`,
        );
      }
    });
    const pk = row[TABLE_PK];
    if (typeof pk !== "string") {
      throw new Error(
        `streaming DB fake INSERT carries no ${TABLE_PK}: ${sql.slice(0, 160)} (Test Author owns this file)`,
      );
    }
    if (/\bon\s+conflict\b/i.test(sql)) {
      table(tableName).set(pk, { ...table(tableName).get(pk), ...row });
    } else {
      table(tableName).set(pk, row);
    }
    const returning = returningColumns(sql);
    if (!returning) return { rows: [] };
    const stored = table(tableName).get(pk) as DbRow;
    const resolved =
      returning.length === 1 && returning[0] === "*" ? TABLE_COLUMNS[tableName]! : returning;
    return { rows: [encode(stored, resolved)] };
  };

  const handleUpdate = (sql: string, params: unknown[]): { rows: unknown[][] } => {
    const tableName = tableOf(sql, "update");
    if (!tableName || !isEmulated(tableName)) return { rows: [] };
    const setPart = /update\s+"?[A-Za-z0-9_]+"?\s+set\s+([\s\S]*?)\s+where\s+/i.exec(sql)?.[1];
    if (!setPart) {
      throw new Error(
        `streaming DB fake cannot parse UPDATE: ${sql.slice(0, 160)} (Test Author owns this file)`,
      );
    }
    const patch: DbRow = {};
    for (const pair of setPart.matchAll(
      /"([A-Za-z0-9_]+)"\s*=\s*(?:\$(\d+)|(now\(\)|clock_timestamp\(\)))/gi,
    )) {
      patch[pair[1] as string] = pair[2] === undefined ? new Date() : params[Number(pair[2]) - 1];
    }
    const row = matchRow(tableName, params);
    if (row) table(tableName).set(String(row[TABLE_PK]), { ...row, ...patch });
    const returning = returningColumns(sql);
    if (!returning || !row) return { rows: [] };
    const stored = table(tableName).get(String(row[TABLE_PK])) as DbRow;
    const resolved =
      returning.length === 1 && returning[0] === "*" ? TABLE_COLUMNS[tableName]! : returning;
    return { rows: [encode(stored, resolved)] };
  };

  const handleDelete = (sql: string, params: unknown[]): { rows: unknown[][] } => {
    const tableName = /\sfrom\s+"?([A-Za-z0-9_]+)"?/i.exec(sql)?.[1];
    if (!tableName || !isEmulated(tableName)) return { rows: [] };
    const row = matchRow(tableName, params);
    if (row) table(tableName).delete(String(row[TABLE_PK]));
    return { rows: [] };
  };

  const db = drizzle(driver);
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => unknown) => fn(db as unknown as Db),
  });
  state.db = db as unknown as Db;
  return state;
}

export type ThrottleFake = {
  store: () => Promise<Sql | null>;
  /** Buckets checked, in order. Reads must never appear here. */
  checks: string[];
};

/**
 * In-memory fixed-window counter behind the shared THROTTLE_STORE seam:
 * answers the exact statements checkJoinThrottle issues (advisory lock,
 * 60 s count, hit insert, expiry prune) so the suites pin the real
 * 30/min shared-middleware behavior instead of a verdict stub.
 */
export function createThrottleFake(): ThrottleFake {
  const checks: string[] = [];
  const hits = new Map<string, number[]>();
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("count(*)")) {
      const bucket = String(values[0]);
      checks.push(bucket);
      const now = Date.now();
      const recent = (hits.get(bucket) ?? []).filter((at) => now - at < 60_000);
      hits.set(bucket, recent);
      return [{ n: recent.length, wait: 60 }];
    }
    if (text.includes("INSERT INTO web_throttle_hits")) {
      const bucket = String(values[0]);
      const list = hits.get(bucket) ?? [];
      list.push(Date.now());
      hits.set(bucket, list);
      return [];
    }
    if (text.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error(
      `streaming throttle fake cannot answer: ${text.slice(0, 160)} (Test Author owns this file)`,
    );
  }) as unknown as Sql;
  (tag as unknown as { unsafe: (sql: string) => Promise<never[]> }).unsafe = async () => [];
  const sql = {
    begin: async (run: (tx: Sql) => Promise<unknown>) => run(tag),
  };
  return { store: async () => sql as unknown as Sql, checks };
}

export type StreamingFixture = {
  env: Env;
  cf: FakeCloudflareStream;
  sdb: StreamingDb;
  throttle: ThrottleFake;
  sessions: SessionStore;
  streamKeysKey: string;
  cookieFor: (userId: string, username: string, member?: boolean) => Promise<string>;
  request: (path: string, init?: RequestInit, envOverride?: Env) => Promise<Response>;
  uninstall: () => void;
};

export function setupStreaming(over: { streamKeysKey?: string } = {}): StreamingFixture {
  const cf = new FakeCloudflareStream();
  const sdb = createStreamingDb();
  const throttle = createThrottleFake();
  const sessions = createMemorySessionStore();
  const streamKeysKey = over.streamKeysKey ?? makeStreamKeysKey();
  const env = {
    APP_URL: STREAMING_APP_URL,
    DISCORD_CLIENT_ID: "fixture-client-id",
    DISCORD_GUILD_ID: "100000000000000000",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_CLIENT_SECRET: "fixture-client-secret",
    DISCORD_BOT_TOKEN: "fixture-bot-token",
    SESSION_SECRET: STREAMING_SESSION_SECRET,
    STREAM_KEYS_KEY: streamKeysKey,
    CF_STREAM_ACCOUNT_ID: STREAMING_CF_ACCOUNT,
    CF_STREAM_API_TOKEN: STREAMING_CF_TOKEN,
    SESSION_STORE: sessions,
    ADMIN_DB: sdb.db,
    THROTTLE_STORE: throttle.store,
  } as unknown as Env;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    cf.fetch(input, init)) as typeof fetch;

  const cookieFor = async (userId: string, username: string, member = true): Promise<string> => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId,
      username,
      avatar: null,
      member,
      moderator: false,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const serialized = await serializeSigned(SESSION_COOKIE, token, STREAMING_SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    return serialized.split(";")[0] as string;
  };

  return {
    env,
    cf,
    sdb,
    throttle,
    sessions,
    streamKeysKey,
    cookieFor,
    request: (path, init = {}, envOverride) =>
      Promise.resolve(app.request(path, init, envOverride ?? env)),
    uninstall: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** Fixture env with bindings overridden (key rotation, failure injection). */
export function withEnv(fx: StreamingFixture, patch: Record<string, unknown>): Env {
  return { ...fx.env, ...patch } as unknown as Env;
}

/** Fixture env with bindings removed (missing-secret fail-closed tests). */
export function withoutEnv(fx: StreamingFixture, ...names: string[]): Env {
  const clone = { ...fx.env } as unknown as Record<string, unknown>;
  for (const name of names) delete clone[name];
  return clone as unknown as Env;
}

/** Native form POST for the setup actions: empty urlencoded form + Origin. */
export function setupAction(
  fx: StreamingFixture,
  cookie: string,
  action: "rotate" | "disable" | "enable",
  envOverride?: Env,
): Promise<Response> {
  return fx.request(
    `/streaming/setup/${action}`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: STREAMING_APP_URL,
        "content-type": "application/x-www-form-urlencoded",
        accept: HTML_ACCEPT,
      },
      body: "",
    },
    envOverride,
  );
}

export function setupGet(
  fx: StreamingFixture,
  cookie: string,
  accept = HTML_ACCEPT,
  envOverride?: Env,
): Promise<Response> {
  return fx.request("/streaming/setup", { headers: { cookie, accept } }, envOverride);
}

export function hasTestid(html: string, testid: string): boolean {
  return html.includes(`data-testid="${testid}"`);
}

/** Text inside the first element carrying the testid (leaf markers only). */
export function testidText(html: string, testid: string): string | null {
  const open = new RegExp(`<[^<>]*data-testid="${testid}"[^<>]*>`).exec(html);
  if (!open || open.index === undefined) return null;
  const rest = html.slice(open.index + open[0].length);
  const close = rest.indexOf("</");
  const inner = close === -1 ? rest : rest.slice(0, close);
  return inner
    .replace(/<[^<>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function formFor(html: string, testid: string): string | null {
  return (
    new RegExp(`<form\\b[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</form>`).exec(html)?.[0] ??
    null
  );
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";

/** Capture every console line (request logs, warnings, error paths) per test. */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const layer = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
  const saved = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const format = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? "undefined";
    } catch {
      return "[unstringifiable]";
    }
  };
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    saved.set(method, layer[method]);
    layer[method] = (...args: unknown[]) => {
      lines.push(args.map(format).join(" "));
    };
  }
  return {
    lines,
    restore: () => {
      for (const [method, original] of saved) layer[method] = original;
    },
  };
}
